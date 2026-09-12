/**
 * REST surface. Everything that changes the link or writes to the device goes
 * through here; the WebSocket is read-only telemetry.
 *
 * Routes deliberately mirror the pyassistant CLI verbs -- ports / connect /
 * send / log -- so the two front-ends stay conceptually interchangeable.
 */

import { Router, type Request, type Response } from 'express';

import {
  Anchor,
  CMD_TYPE_FOR_TARGET,
  COMMAND_CATALOG,
  CmdDirect,
  REPORT_FORMATS,
  ROBOT_MODES,
  Robot,
  Tag,
  buildConfigFrame,
  parseFrame,
  fromHex,
  toHex,
  toWireFrame,
  type ConnectRequest,
  type SendRequest,
  type SendResponse,
} from '@mauwb/protocol';

import { writeSample } from './sample.js';
import type { Session } from './session.js';
import { listSerialPorts } from './transport.js';

/** Express 5 forwards rejected promises to the error handler, but being explicit keeps the 500s readable. */
function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(400).json({ error: message });
    }
  };
}

function parseAddr(v: unknown, field: string): bigint {
  if (v === undefined || v === null || v === '') return 0n;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v !== 'string') throw new Error(`${field} must be a string or number`);
  const s = v.trim();
  try {
    return BigInt(s.startsWith('0x') || s.startsWith('0X') ? s : `0x${s}`);
  } catch {
    throw new Error(`${field} is not a valid 64-bit hex address: "${v}"`);
  }
}

export function createApi(session: Session): Router {
  const api = Router();

  api.get(
    '/ports',
    wrap(async (_req, res) => {
      res.json({ ports: await listSerialPorts() });
    }),
  );

  api.get('/status', (_req, res) => {
    res.json({ state: session.state });
  });

  api.post(
    '/connect',
    wrap(async (req, res) => {
      const body = req.body as ConnectRequest;
      if (!body?.spec || typeof body.spec !== 'string') {
        throw new Error('spec is required: COM7 | /dev/ttyUSB0 | tcp://host:port | file://cap.bin');
      }
      await session.connect(body.spec, {
        baud: body.baud ?? 115200,
        speed: body.speed ?? 1.0,
        loop: body.loop ?? false,
        verify: body.verify ?? true,
      });
      res.json({ state: session.state });
    }),
  );

  api.post(
    '/disconnect',
    wrap(async (_req, res) => {
      await session.disconnect();
      res.json({ state: session.state });
    }),
  );

  /**
   * Build a config frame and (unless dryRun) write it to the device.
   * The reply, if any, arrives asynchronously on the WebSocket as a config frame.
   */
  api.post(
    '/send',
    wrap(async (req, res) => {
      const body = req.body as SendRequest;
      const target = body?.target;
      if (target !== 'anchor' && target !== 'tag' && target !== 'robot') {
        throw new Error('target must be one of: anchor, tag, robot');
      }
      const command = String(body?.command ?? '').trim();
      if (!command) throw new Error('command is required');

      const frame = buildConfigFrame(
        CMD_TYPE_FOR_TARGET[target],
        command,
        parseAddr(body.saddr, 'saddr'),
        parseAddr(body.daddr, 'daddr'),
        CmdDirect.ENGINE_REQ,
      );

      let sent = false;
      if (!body.dryRun) {
        await session.send(frame);
        sent = true;
      }
      const out: SendResponse = { hex: toHex(frame), bytes: frame.length, sent };
      res.json(out);
    }),
  );

  /** Decode a frame pasted as hex -- the equivalent of `mauwb_cli.py decode`. */
  api.post(
    '/decode',
    wrap(async (req, res) => {
      const hex = String((req.body as { hex?: string })?.hex ?? '');
      if (!hex.trim()) throw new Error('hex is required');
      const verify = (req.body as { verify?: boolean })?.verify ?? true;
      const bytes = fromHex(hex);
      const frame = parseFrame(bytes, verify);
      res.json({ frame: toWireFrame(frame, Date.now(), true) });
    }),
  );

  /** The documented command catalogue, so the UI does not hard-code it. */
  api.get('/commands', (_req, res) => {
    res.json({
      catalog: COMMAND_CATALOG,
      reportFormats: REPORT_FORMATS,
      robotModes: ROBOT_MODES,
    });
  });

  api.post(
    '/log/csv',
    wrap(async (req, res) => {
      const body = req.body as { path?: string; enable?: boolean };
      if (body?.enable === false) {
        const rows = await session.stopCsv();
        res.json({ stopped: true, rows, state: session.state });
        return;
      }
      if (!body?.path) throw new Error('path is required');
      await session.startCsv(body.path);
      res.json({ state: session.state });
    }),
  );

  api.post(
    '/log/raw',
    wrap(async (req, res) => {
      const body = req.body as { path?: string; enable?: boolean };
      if (body?.enable === false) {
        const bytes = await session.stopRaw();
        res.json({ stopped: true, bytes, state: session.state });
        return;
      }
      if (!body?.path) throw new Error('path is required');
      await session.startRaw(body.path);
      res.json({ state: session.state });
    }),
  );

  /** Generate a synthetic capture, so a fresh clone has something to replay. */
  api.post(
    '/sample',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        path?: string;
        tags?: number;
        seconds?: number;
        rate?: number;
        rssi?: boolean;
        garbage?: boolean;
      };
      const result = await writeSample(body.path ?? 'samples/demo.bin', {
        tags: body.tags ?? 3,
        seconds: body.seconds ?? 20,
        rate: body.rate ?? 20,
        rssi: body.rssi ?? false,
        garbage: body.garbage ?? false,
      });
      res.json(result);
    }),
  );

  /**
   * The typed command builders, exposed so the UI can offer argument fields
   * with range checking instead of a bare text box. POST the arguments, get
   * back the exact ASCII the device will see -- the link is never touched, so
   * this is safe to call on every keystroke.
   */
  api.post(
    '/preview/:target/:command',
    wrap(async (req, res) => {
      const { target, command } = req.params as { target: string; command: string };
      const b = (req.body ?? {}) as Record<string, never>;
      const n = (key: string, fallback: number): number => {
        const v = (b as Record<string, unknown>)[key];
        return v === undefined || v === null || v === '' ? fallback : Number(v);
      };
      const flag = (key: string, fallback: boolean): boolean => {
        const v = (b as Record<string, unknown>)[key];
        return v === undefined ? fallback : Boolean(v);
      };

      let frame: Uint8Array;
      switch (`${target}.${command}`) {
        case 'anchor.setcfg':
          frame = new Anchor().setcfg(
            n('discoverTags', 1),
            n('bindTags', 1),
            n('panId', 0x1111),
            n('anchorId', 0),
            n('refresh', 100),
            n('filt', 1),
            n('reportFormat', 0),
          );
          break;
        case 'anchor.setslot':
          frame = new Anchor().setslot(n('ms', 10));
          break;
        case 'anchor.setfilter':
          frame = new Anchor().setfilter(flag('enable', true), n('coeff', 30));
          break;
        case 'anchor.addtag':
          frame = new Anchor().addtag(
            parseAddr((b as Record<string, unknown>).longAddr, 'longAddr'),
            n('shortAddr', 0),
            n('fastest', 0x0001),
            n('slowest', 0x000a),
            n('mode', 0),
          );
          break;
        case 'anchor.deltag':
          frame = new Anchor().deltag(parseAddr((b as Record<string, unknown>).longAddr, 'longAddr'));
          break;
        case 'tag.settag':
          frame = new Tag().settag(
            n('accMin', 90),
            n('accMax', 110),
            n('stillCount', 10),
            flag('workWhileCharging', false),
            n('alarmVoltage', 3.5),
            flag('paEnable', false),
            n('uwbPower', 0x1f),
            n('rebindRetries', 10),
          );
          break;
        case 'robot.smode':
          frame = new Robot().smode(n('mode', 1));
          break;
        default:
          throw new Error(`no typed builder for ${target}.${command}`);
      }

      const parsed = parseFrame(frame);
      res.json({
        hex: toHex(frame),
        bytes: frame.length,
        text: parsed.kind === 'config' ? parsed.text : '',
      });
    }),
  );

  return api;
}
