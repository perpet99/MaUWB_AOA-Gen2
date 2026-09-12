/**
 * Ported from pyassistant's tests/test_protocol.py.
 *
 * Every assertion in `document example` is a value the protocol PDF states
 * explicitly ([备注 6：基站定位帧示例]), so this file is the thing that keeps the
 * TypeScript codec honest against the spec rather than against itself.
 */

import { describe, expect, it } from 'vitest';

import {
  CmdDirect,
  CmdType,
  ENVELOPE_EXTRA,
  FrameError,
  FrameStream,
  LOC_LEN,
  LOC_RSSI_LEN,
  activeAnchors,
  anchorXY,
  batteryVolts,
  buildConfigFrame,
  buildFrame,
  decodeTagDetail,
  devTypeName,
  encodeTagDetail,
  fromHex,
  locXY,
  parseFrame,
  primaryAnchor,
  toHex,
  xorCrc,
  type LocFrame,
} from '../src/index.js';

/** [备注 6：基站定位帧示例] - the worked example from the document, verbatim. */
const DOC_EXAMPLE = fromHex(
  '2A 4C 00 DD DD DD DD DD DD DD DD EE EE EE EE EE EE EE EE 01 05 93 23 1C 00 00 00 ' +
    'D8 64 87 01 F9 FF 60 00 00 00 00 00 00 00 00 00 00 00 00 00 FC 17 00 02 00 00 00 ' +
    '00 00 00 00 00 00 00 00 00 F9 FF 60 00 00 00 00 00 45 00 03 00 00 00 00 00 3D 23',
);

function locPayload(opts: {
  tagTime: number;
  anc16: number;
  tag16: number;
  sn: number;
  mask: number;
  anchors: [number, number][];
  detail: number;
  rawAngle: number;
  rawRange: number;
  angle360?: number;
  angleDir?: number;
}): Uint8Array {
  const b = new Uint8Array(58);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, opts.tagTime, true);
  dv.setUint16(4, opts.anc16, true);
  dv.setUint16(6, opts.tag16, true);
  b[8] = opts.sn;
  b[9] = opts.mask;
  opts.anchors.forEach(([angle, range], i) => {
    dv.setInt16(10 + i * 4, angle, true);
    dv.setUint16(12 + i * 4, range, true);
  });
  dv.setUint32(26, opts.detail, true);
  // acc (30..35) and gyro (36..41) stay zero
  dv.setInt16(42, opts.rawAngle, true);
  dv.setUint16(44, opts.rawRange, true);
  dv.setInt32(46, 0, true);
  dv.setUint16(50, opts.angle360 ?? 0, true);
  b[52] = opts.angleDir ?? 0;
  // reserve 53..57 stays zero
  return b;
}

function rssiPayload(anchors: [number, number, number][]): Uint8Array {
  const b = new Uint8Array(66);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1234, true);
  dv.setUint16(4, 0x0001, true);
  dv.setUint16(6, 0x154f, true);
  b[8] = 9;
  b[9] = 1;
  anchors.forEach(([angle, range, rssi], i) => {
    dv.setInt16(10 + i * 6, angle, true);
    dv.setUint16(12 + i * 6, range, true);
    dv.setInt16(14 + i * 6, rssi, true);
  });
  dv.setUint32(34, encodeTagDetail({ batteryVal: 400, devType: 2 }), true);
  dv.setInt16(50, -6, true);
  dv.setUint16(52, 96, true);
  dv.setInt32(54, 0, true);
  dv.setUint16(58, 45, true);
  b[60] = 3;
  return b;
}

describe('document example', () => {
  it('is 81 bytes', () => {
    expect(DOC_EXAMPLE.length).toBe(81);
    expect(DOC_EXAMPLE.length).toBe(LOC_LEN);
  });

  it('has the documented envelope', () => {
    expect(DOC_EXAMPLE[0]).toBe(0x2a); // 包头
    expect(DOC_EXAMPLE[DOC_EXAMPLE.length - 1]).toBe(0x23); // 包尾
    const cmdLen = DOC_EXAMPLE[1]! | (DOC_EXAMPLE[2]! << 8);
    expect(cmdLen).toBe(0x4c); // 76
    expect(DOC_EXAMPLE.length).toBe(cmdLen + ENVELOPE_EXTRA);
  });

  it('checksums to the value printed in the document', () => {
    const cmdLen = DOC_EXAMPLE[1]! | (DOC_EXAMPLE[2]! << 8);
    expect(xorCrc(DOC_EXAMPLE, 3, cmdLen)).toBe(0x3d);
  });

  it('decodes every documented field', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    expect(f.kind).toBe('loc');
    expect(f.cmdType).toBe(CmdType.LOC);
    // The document's own example carries 05 at index 20.
    expect(f.cmdDirect).toBe(CmdDirect.ENGINE_REPORT);
    expect(f.saddr).toBe(0xddddddddddddddddn);
    expect(f.daddr).toBe(0xeeeeeeeeeeeeeeeen);
    expect(f.tagTime).toBe(0x001c2393);
    expect(f.ancAddr16).toBe(0x0000);
    expect(f.tagAddr16).toBe(0x64d8);
    expect(f.tagSn).toBe(0x87);
    expect(f.tagMask).toBe(0x01);
    expect(f.angle360).toBe(0x0045);
    // angle_dir is a uint8 at index 73 -- not a uint16, as the car firmware has it.
    expect(f.angleDir).toBe(0x03);
    expect(Array.from(f.reserve)).toEqual([0, 0, 0, 0, 0]);
  });

  it('decodes anchor 0 at 96 cm', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    const a0 = f.anchors[0]!;
    // 0xFFF9 little-endian as int16. The PDF's prose says "-6" but two's
    // complement of 0xFFF9 is -7; the raw bytes are the authority.
    expect(a0.angleDeg).toBe(-7);
    expect(a0.rangeCm).toBe(96); // 0x0060, as the PDF states
    expect(a0.rssi).toBeNull(); // plain LOC frame carries none
    expect(activeAnchors(f)).toHaveLength(1);
    expect(primaryAnchor(f)).toBe(a0);
  });

  it('leaves anchors 1-3 idle', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    for (const i of [1, 2, 3]) {
      expect(f.anchors[i]!.angleDeg).toBe(0);
      expect(f.anchors[i]!.rangeCm).toBe(0);
    }
  });

  it('repeats anchor 0 in the unfiltered self-measurement', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    expect(f.selfRawAngle).toBe(-7);
    expect(f.selfRawRange).toBe(96);
    expect(f.selfRawDegree).toBe(0);
  });

  it('places the tag just left of boresight', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    const xy = locXY(f)!;
    expect(xy.x).toBeCloseTo(0.96 * Math.sin((-7 * Math.PI) / 180), 6);
    expect(xy.y).toBeCloseTo(0.96 * Math.cos((-7 * Math.PI) / 180), 6);
    expect(xy.x).toBeLessThan(0);
  });

  it('decodes tag_detail_para 0x020017FC', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    const d = f.detail;
    expect(d.raw).toBe(0x020017fc);
    expect(d.isChrg).toBe(true);
    expect(d.isTdby).toBe(true);
    expect(d.isAlarm).toBe(false);
    expect(d.isLowbattery).toBe(false);
    expect(d.batteryVal).toBe(383);
    expect(batteryVolts(d)).toBeCloseTo(3.83, 2);
    expect(d.devType).toBe(1);
    expect(devTypeName(d)).toBe('wristband');
  });
});

describe('tag_detail_para bitfield', () => {
  it('round-trips through encode/decode', () => {
    const raw = encodeTagDetail({
      isAlarm: true,
      isChrg: true,
      batteryVal: 412,
      turnLeft: true,
      mode: 5,
      lock: true,
      devType: 2,
    });
    const d = decodeTagDetail(raw);
    expect(d.isAlarm).toBe(true);
    expect(d.isChrg).toBe(true);
    expect(d.isLowbattery).toBe(false);
    expect(d.batteryVal).toBe(412);
    expect(batteryVolts(d)).toBeCloseTo(4.12, 6);
    expect(d.turnLeft).toBe(true);
    expect(d.turnRight).toBe(false);
    expect(d.mode).toBe(5);
    expect(d.lock).toBe(true);
    expect(d.devType).toBe(2);
    expect(devTypeName(d)).toBe('remote');
    expect(encodeTagDetail(d)).toBe(raw);
  });

  it('matches the worked examples in 备注 1', () => {
    // 【是否报警:无 / (遥控专用)模式:无/】 0x02001A04
    const noAlarm = decodeTagDetail(0x02001a04);
    expect(noAlarm.isAlarm).toBe(false);
    expect(noAlarm.mode).toBe(0);
    expect(noAlarm.devType).toBe(1);

    // 【是否报警:有】 0x02001A06 -- bit 1 set
    const alarm = decodeTagDetail(0x02001a06);
    expect(alarm.isAlarm).toBe(true);
    expect(alarm.batteryVal).toBe(noAlarm.batteryVal);

    // 【(遥控专用)模式:有】 0x02101A24 -- mode field non-zero
    const withMode = decodeTagDetail(0x02101a24);
    expect(withMode.mode).toBe(1);
  });

  it('keeps battery_val inside its 10 bits', () => {
    const d = decodeTagDetail(encodeTagDetail({ batteryVal: 0x3ff }));
    expect(d.batteryVal).toBe(0x3ff);
    expect(d.isOffsetRangeZero).toBe(false);
  });
});

describe('build / parse round trip', () => {
  it('rebuilds a frame byte-for-byte', () => {
    const f = parseFrame(DOC_EXAMPLE) as LocFrame;
    const payload = DOC_EXAMPLE.slice(21, 79);
    const rebuilt = buildFrame(f.cmdType, payload, f.saddr, f.daddr, f.cmdDirect);
    expect(toHex(rebuilt)).toBe(toHex(DOC_EXAMPLE));
  });

  it('builds a config frame the device would accept', () => {
    const frame = buildConfigFrame(CmdType.ANCHOR_CFG, 'setcfg 1 1 1111 1 100 1 0');
    const parsed = parseFrame(frame);
    expect(parsed.kind).toBe('config');
    if (parsed.kind !== 'config') throw new Error('unreachable');
    expect(parsed.text).toBe('setcfg 1 1 1111 1 100 1 0');
    expect(parsed.cmdType).toBe(CmdType.ANCHOR_CFG);
    expect(parsed.cmdDirect).toBe(CmdDirect.ENGINE_REQ);
  });

  it('refuses a non-config cmd_type', () => {
    expect(() => buildConfigFrame(CmdType.LOC, 'getcfg')).toThrow(/not a config/);
  });
});

describe('RSSI frames', () => {
  const frame = buildFrame(
    CmdType.LOC_RSSI,
    rssiPayload([
      [-6, 96, -72],
      [12, 140, -81],
      [0, 0, 0],
      [0, 0, 0],
    ]),
    0xddddddddddddddddn,
    0xeeeeeeeeeeeeeeeen,
    CmdDirect.DEV_REPORT,
  );

  it('is 89 bytes', () => {
    expect(frame.length).toBe(LOC_RSSI_LEN);
  });

  it('shifts every field below the anchors by 8 bytes', () => {
    const f = parseFrame(frame) as LocFrame;
    expect(f.cmdType).toBe(CmdType.LOC_RSSI);
    expect(f.anchors[0]).toMatchObject({ angleDeg: -6, rangeCm: 96, rssi: -72 });
    expect(f.anchors[1]).toMatchObject({ angleDeg: 12, rangeCm: 140, rssi: -81 });
    expect(activeAnchors(f)).toHaveLength(2);
    expect(f.selfRawAngle).toBe(-6);
    expect(f.selfRawRange).toBe(96);
    expect(f.angle360).toBe(45);
    expect(f.angleDir).toBe(3);
    expect(batteryVolts(f.detail)).toBeCloseTo(4.0, 6);
    expect(devTypeName(f.detail)).toBe('remote');
  });

  it('treats 0/0 anchors as never having ranged', () => {
    const f = parseFrame(frame) as LocFrame;
    expect(f.anchors[2]!.rangeCm).toBe(0);
    expect(activeAnchors(f).map((a) => a.index)).toEqual([0, 1]);
  });
});

describe('parseFrame rejects malformed input', () => {
  it('rejects a bad head', () => {
    const bad = DOC_EXAMPLE.slice();
    bad[0] = 0x2b;
    expect(() => parseFrame(bad)).toThrow(FrameError);
  });

  it('rejects a bad foot', () => {
    const bad = DOC_EXAMPLE.slice();
    bad[bad.length - 1] = 0x24;
    expect(() => parseFrame(bad)).toThrow(FrameError);
  });

  it('rejects a bad checksum', () => {
    const bad = DOC_EXAMPLE.slice();
    bad[40] ^= 0xff;
    expect(() => parseFrame(bad)).toThrow(/checksum/);
  });

  it('accepts a bad checksum when verification is off', () => {
    const bad = DOC_EXAMPLE.slice();
    bad[40] ^= 0xff;
    expect(() => parseFrame(bad, false)).not.toThrow();
  });

  it('rejects a truncated buffer', () => {
    expect(() => parseFrame(DOC_EXAMPLE.slice(0, 40))).toThrow(FrameError);
  });
});

describe('FrameStream', () => {
  const three = (() => {
    const out = new Uint8Array(DOC_EXAMPLE.length * 3);
    for (let i = 0; i < 3; i++) out.set(DOC_EXAMPLE, i * DOC_EXAMPLE.length);
    return out;
  })();

  it('extracts every frame from a clean stream', () => {
    const s = new FrameStream();
    expect(s.feed(three)).toHaveLength(3);
    expect(s.stats.frames).toBe(3);
    expect(s.stats.resyncs).toBe(0);
    expect(s.stats.droppedBytes).toBe(0);
  });

  it('survives being fed one byte at a time', () => {
    const s = new FrameStream();
    let n = 0;
    for (const b of three) n += s.feed(Uint8Array.of(b)).length;
    expect(n).toBe(3);
    expect(s.buffered).toBe(0);
  });

  it('resyncs past leading garbage', () => {
    const s = new FrameStream();
    const noisy = new Uint8Array(5 + three.length);
    noisy.set([0x00, 0xff, 0x2a, 0x13, 0x37], 0);
    noisy.set(three, 5);
    expect(s.feed(noisy)).toHaveLength(3);
    expect(s.stats.droppedBytes).toBeGreaterThan(0);
  });

  it('recovers the following frames after a corrupt one', () => {
    const corrupt = three.slice();
    corrupt[DOC_EXAMPLE.length + 40] ^= 0xff; // break frame 2's checksum
    const s = new FrameStream();
    const frames = s.feed(corrupt);
    expect(frames.length).toBe(2);
    expect(s.stats.badChecksum).toBe(1);
    expect(s.stats.resyncs).toBeGreaterThan(0);
  });

  it('joining mid-frame loses only the partial frame', () => {
    const s = new FrameStream();
    const frames = s.feed(three.slice(30)); // start 30 bytes into frame 1
    expect(frames).toHaveLength(2);
  });

  it('does not buffer forever on a corrupt length field', () => {
    const s = new FrameStream({ maxBuffer: 1024 });
    const junk = new Uint8Array(4096).fill(0x2a);
    s.feed(junk);
    expect(s.buffered).toBeLessThanOrEqual(1024);
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    expect(toHex(fromHex('2a 4c 00'))).toBe('2A 4C 00');
    expect(toHex(fromHex('0x2A,0x4C'), '')).toBe('2A4C');
  });

  it('rejects an odd digit count', () => {
    expect(() => fromHex('2a4')).toThrow(/odd/);
  });
});

describe('anchor geometry', () => {
  it('puts a positive angle to the right of boresight', () => {
    const { x, y } = anchorXY({ index: 0, angleDeg: 90, rangeCm: 200, rssi: null });
    expect(x).toBeCloseTo(2.0, 6);
    expect(y).toBeCloseTo(0.0, 6);
  });

  it('puts zero degrees straight ahead', () => {
    const { x, y } = anchorXY({ index: 0, angleDeg: 0, rangeCm: 350, rssi: null });
    expect(x).toBeCloseTo(0.0, 6);
    expect(y).toBeCloseTo(3.5, 6);
  });
});
