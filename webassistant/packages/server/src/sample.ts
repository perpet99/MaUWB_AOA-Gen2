/**
 * Generate a synthetic raw capture so the stack can be exercised without
 * hardware.
 *
 *     npm run sample -- samples/demo.bin --tags 3 --seconds 20
 *
 * The result is byte-compatible with a real capture, so it replays through
 * `file://` exactly like one recorded from an anchor.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CmdDirect, CmdType, buildFrame, encodeTagDetail } from '@mauwb/protocol';

import { displayPath, resolveDataPath } from './paths.js';

export interface SampleOptions {
  tags?: number;
  seconds?: number;
  /** frames per second per tag */
  rate?: number;
  /** angle noise, degrees */
  noise?: number;
  /** inject junk bytes to exercise the resync path */
  garbage?: boolean;
  /** emit 0x64 RSSI frames instead of plain 0x01 ones */
  rssi?: boolean;
  seed?: number;
}

/** Small deterministic PRNG so a seed reproduces a capture exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number, sigma: number): number {
  // Box-Muller; one sample is plenty and keeps the generator cheap.
  const u = Math.max(rnd(), Number.EPSILON);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

/** Build the bytes that follow cmd_direct in a positioning frame. */
function locPayload(args: {
  tagTime: number;
  anc16: number;
  tag16: number;
  sn: number;
  mask: number;
  anchors: { angle: number; range: number; rssi: number }[];
  detail: number;
  rawAngle: number;
  rawRange: number;
  angle360: number;
  angleDir: number;
  withRssi: boolean;
}): Uint8Array {
  const stride = args.withRssi ? 6 : 4;
  const size = 10 + 4 * stride + 32;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);

  dv.setUint32(0, args.tagTime, true);
  dv.setUint16(4, args.anc16, true);
  dv.setUint16(6, args.tag16, true);
  b[8] = args.sn & 0xff;
  b[9] = args.mask & 0xff;

  args.anchors.forEach((a, i) => {
    const base = 10 + i * stride;
    dv.setInt16(base, a.angle, true);
    dv.setUint16(base + 2, a.range, true);
    if (args.withRssi) dv.setInt16(base + 4, a.rssi, true);
  });

  const p = 10 + 4 * stride;
  dv.setUint32(p, args.detail, true);
  // acc (p+4 .. p+9) and gyro (p+10 .. p+15) stay zero
  dv.setInt16(p + 16, args.rawAngle, true);
  dv.setUint16(p + 18, args.rawRange, true);
  dv.setInt32(p + 20, 0, true);
  dv.setUint16(p + 24, args.angle360, true);
  b[p + 26] = args.angleDir & 0xff;
  // reserve p+27 .. p+31 stays zero
  return b;
}

export function buildSample(opts: SampleOptions = {}): { data: Uint8Array; frames: number } {
  const tags = opts.tags ?? 3;
  const seconds = opts.seconds ?? 20;
  const rate = opts.rate ?? 20;
  const noise = opts.noise ?? 1.5;
  const withRssi = opts.rssi ?? false;
  const rnd = mulberry32(opts.seed ?? 7);

  const n = Math.floor(seconds * rate);

  // Each tag walks its own smooth path so trails look like real motion.
  const paths = Array.from({ length: tags }, (_, i) => ({
    addr: (0x1000 + 0x54f * i) & 0xffff,
    phase: rnd() * Math.PI * 2,
    sweep: 35 + rnd() * 35, // degrees of arc
    r0: 1.5 + rnd() * 2.5,
    dr: 0.5 + rnd() * 1.5,
    period: 6 + rnd() * 7,
    batt: 360 + Math.floor(rnd() * 56),
    dev: Math.floor(rnd() * 3),
  }));

  const chunks: Uint8Array[] = [];
  let frames = 0;

  for (let k = 0; k < n; k++) {
    const t = k / rate;
    paths.forEach((pa, i) => {
      const w = (Math.PI * 2 * t) / pa.period + pa.phase;
      const angle = pa.sweep * Math.sin(w) + gaussian(rnd, noise);
      const rngM = pa.r0 + pa.dr * Math.sin(w * 0.7);
      const rangeCm = Math.max(10, Math.round(rngM * 100 + gaussian(rnd, 3)));
      const ai = Math.round(angle);

      const detail = encodeTagDetail({
        batteryVal: pa.batt,
        devType: pa.dev,
        isChrg: false,
        isLowbattery: pa.batt < 370,
        isAlarm: i === 0 && (t % 10) / 10 > 0.45 && (t % 10) / 10 < 0.55,
      });

      const payload = locPayload({
        tagTime: Math.floor(t * 1000),
        anc16: 0x0000,
        tag16: pa.addr,
        sn: k & 0xff,
        mask: 0x01,
        anchors: [
          { angle: ai, range: rangeCm, rssi: -60 - Math.round(rngM * 6) },
          // A second anchor, offset, so the RSSI/dual-anchor views have data.
          withRssi
            ? { angle: ai - 12, range: rangeCm + 30, rssi: -66 - Math.round(rngM * 6) }
            : { angle: 0, range: 0, rssi: 0 },
          { angle: 0, range: 0, rssi: 0 },
          { angle: 0, range: 0, rssi: 0 },
        ],
        detail,
        rawAngle: ai,
        rawRange: rangeCm,
        angle360: Math.round(((angle % 360) + 360) % 360),
        angleDir: Math.floor(((((angle % 360) + 360) % 360) / 45) % 8),
        withRssi,
      });

      if (opts.garbage && rnd() < 0.01) {
        const junk = new Uint8Array(1 + Math.floor(rnd() * 9));
        for (let j = 0; j < junk.length; j++) junk[j] = Math.floor(rnd() * 256);
        chunks.push(junk);
      }

      chunks.push(
        buildFrame(
          withRssi ? CmdType.LOC_RSSI : CmdType.LOC,
          payload,
          0xddddddddddddddddn,
          0xeeeeeeeeeeeeeeeen,
          CmdDirect.ENGINE_REPORT,
        ),
      );
      frames++;
    });
  }

  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.length;
  }
  return { data, frames };
}

export async function writeSample(
  outPath: string,
  opts: SampleOptions = {},
): Promise<{ frames: number; path: string }> {
  const { data, frames } = buildSample(opts);
  const resolved = resolveDataPath(outPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, data);
  return { frames, path: displayPath(resolved) };
}

/* ------------------------------------------------------------------ cli --- */

const VALUE_FLAGS = ['--tags', '--seconds', '--rate', '--noise', '--seed'];

function parseArgs(argv: string[]): { out: string; opts: SampleOptions } {
  // Skip the value that follows a value-taking flag, so "--tags 3 out.bin"
  // does not mistake "3" for the output path.
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('--')) {
      out = a;
      break;
    }
  }
  if (!out) {
    throw new Error(
      'usage: sample <out.bin> [--tags N] [--seconds S] [--rate R] [--noise D] [--seed N] [--rssi] [--garbage]',
    );
  }
  const num = (flag: string): number | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) return undefined;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v)) throw new Error(`${flag} needs a number, got "${argv[i + 1]}"`);
    return v;
  };
  return {
    out,
    opts: {
      tags: num('--tags'),
      seconds: num('--seconds'),
      rate: num('--rate'),
      noise: num('--noise'),
      seed: num('--seed'),
      rssi: argv.includes('--rssi'),
      garbage: argv.includes('--garbage'),
    },
  };
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  const { out, opts } = parseArgs(process.argv.slice(2));
  const r = await writeSample(out, opts);
  console.log(`wrote ${r.frames} frames to ${r.path}`);
}
