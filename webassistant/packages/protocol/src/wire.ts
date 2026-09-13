/**
 * JSON-safe shapes for the server -> browser link, plus the REST/WebSocket
 * message contracts.
 *
 * `Frame` carries `bigint` addresses and `Uint8Array` payloads, neither of which
 * survives `JSON.stringify`. Everything crossing the socket goes through
 * `toWireFrame` first, so the browser gets a plain object it can render and the
 * two sides share one compile-checked definition of the protocol.
 */

import {
  type AnchorMeas,
  type Frame,
  type TagDetail,
  anchorValid,
  cmdDirectName,
  cmdTypeName,
  locXY,
  toHex,
} from './protocol.js';

export interface WireAnchor {
  index: number;
  angleDeg: number;
  rangeCm: number;
  rssi: number | null;
  valid: boolean;
}

interface WireFrameBase {
  /** host clock, ms since epoch, stamped when the frame left the stream */
  hostTime: number;
  cmdType: number;
  cmdTypeName: string;
  cmdDirect: number;
  cmdDirectName: string;
  /** 0x-prefixed 16 hex digits */
  saddr: string;
  daddr: string;
  /** space-separated hex of the whole frame; present only when requested */
  raw?: string;
}

export interface WireLocFrame extends WireFrameBase {
  kind: 'loc';
  tagTime: number;
  ancAddr16: number;
  tagAddr16: number;
  tagSn: number;
  tagMask: number;
  anchors: WireAnchor[];
  detail: TagDetail;
  acc: [number, number, number];
  gyro: [number, number, number];
  selfRawAngle: number;
  selfRawRange: number;
  selfRawDegree: number;
  angle360: number;
  angleDir: number;
  /** metres from the anchor, derived from the first anchor that ranged */
  xy: { x: number; y: number } | null;
}

export interface WireConfigFrame extends WireFrameBase {
  kind: 'config';
  text: string;
}

export interface WireRawFrame extends WireFrameBase {
  kind: 'raw';
  payload: string;
}

export type WireFrame = WireLocFrame | WireConfigFrame | WireRawFrame;

const hex64 = (v: bigint) => `0x${v.toString(16).toUpperCase().padStart(16, '0')}`;

function wireAnchor(a: AnchorMeas): WireAnchor {
  return {
    index: a.index,
    angleDeg: a.angleDeg,
    rangeCm: a.rangeCm,
    rssi: a.rssi,
    valid: anchorValid(a),
  };
}

export function toWireFrame(f: Frame, hostTime: number, includeRaw = false): WireFrame {
  const base: WireFrameBase = {
    hostTime,
    cmdType: f.cmdType,
    cmdTypeName: cmdTypeName(f.cmdType),
    cmdDirect: f.cmdDirect,
    cmdDirectName: cmdDirectName(f.cmdDirect),
    saddr: hex64(f.saddr),
    daddr: hex64(f.daddr),
  };
  if (includeRaw) base.raw = toHex(f.raw);

  switch (f.kind) {
    case 'loc':
      return {
        ...base,
        kind: 'loc',
        tagTime: f.tagTime,
        ancAddr16: f.ancAddr16,
        tagAddr16: f.tagAddr16,
        tagSn: f.tagSn,
        tagMask: f.tagMask,
        anchors: f.anchors.map(wireAnchor),
        detail: f.detail,
        acc: f.acc,
        gyro: f.gyro,
        selfRawAngle: f.selfRawAngle,
        selfRawRange: f.selfRawRange,
        selfRawDegree: f.selfRawDegree,
        angle360: f.angle360,
        angleDir: f.angleDir,
        xy: locXY(f),
      };
    case 'config':
      return { ...base, kind: 'config', text: f.text };
    case 'raw':
      return { ...base, kind: 'raw', payload: toHex(f.payload) };
  }
}

/* --------------------------------------------------------- session state --- */

export type LinkState = 'closed' | 'opening' | 'open' | 'error';

export interface SessionStats {
  frames: number;
  badChecksum: number;
  resyncs: number;
  droppedBytes: number;
  bytesIn: number;
  /** positioning frames per second, averaged over a short window */
  locPerSec: number;
}

export interface SessionState {
  link: LinkState;
  /** the transport spec as given: COM7 | /dev/ttyUSB0 | tcp://h:p | file://cap.bin */
  spec: string | null;
  baud: number;
  /** human label, e.g. "serial:COM7@115200" */
  transport: string | null;
  error: string | null;
  openedAt: number | null;
  stats: SessionStats;
  csvPath: string | null;
  csvRows: number;
  rawPath: string | null;
  rawBytes: number;
  includeRaw: boolean;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

/* ------------------------------------------------------------- ws frames --- */

export type ServerMessage =
  | { type: 'hello'; state: SessionState; protocolVersion: 1 }
  | { type: 'frames'; frames: WireFrame[] }
  | { type: 'state'; state: SessionState }
  | { type: 'tracking'; state: TrackingState }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

/** Auto-pan-to-follow-tag state; see server/src/tracking.ts for the control loop. */
export interface TrackingState {
  active: boolean;
  /** short address (`tagAddr16`) of the tag being followed */
  tagAddr: number | null;
  panMinDeg: number;
  panMaxDeg: number;
  thresholdDeg: number;
  stepDeg: number;
  cooldownMs: number;
  lastAngleDeg: number | null;
  lastCorrectionAt: number | null;
  /** no LOC frame for the tracked tag within the stale window */
  stale: boolean;
  /** the last correction did not move the servo -- pan is pinned at its configured limit */
  panLimitReached: boolean;
}

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'setIncludeRaw'; value: boolean };

/* ------------------------------------------------------------------ rest --- */

export interface ConnectRequest {
  spec: string;
  baud?: number;
  /** file:// replay only */
  speed?: number;
  loop?: boolean;
  verify?: boolean;
}

export interface SendRequest {
  target: 'anchor' | 'tag' | 'robot';
  command: string;
  saddr?: string;
  daddr?: string;
  dryRun?: boolean;
}

export interface SendResponse {
  hex: string;
  bytes: number;
  sent: boolean;
}

export interface ApiError {
  error: string;
}
