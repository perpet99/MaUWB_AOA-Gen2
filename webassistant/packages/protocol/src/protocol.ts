/**
 * Jiuling (久凌电子) AOA UWB serial protocol - frame definitions, parsing and building.
 *
 * Reference
 * ---------
 * "久凌 AOA 通信协议" -- 久凌(温州)电子科技有限公司, rev 2025-03-24.
 * Shipped as `d3b51756734822.pdf` inside `MaUWB_AOA_Assistant.zip`.
 *
 * All multi-byte fields are little-endian ("低位在前").
 *
 * Frame envelope (common to every frame type):
 *
 *     off  size  field
 *     0    1     head        0x2A
 *     1    2     cmd_len     length of bytes[3 : 3+cmd_len]
 *     3    8     cmd_saddr   own long address
 *     11   8     cmd_daddr   peer long address
 *     19   1     cmd_type
 *     20   1     cmd_direct
 *     21   *     payload
 *     *    1     check       XOR of bytes[3 : 3+cmd_len]
 *     *    1     foot        0x23
 *
 * Total frame size is therefore `cmd_len + 5`.
 *
 * This module is isomorphic: it touches no Node or DOM-only API, so the server
 * and the browser decode bytes through the exact same code path.
 */

export const HEAD = 0x2a;
export const FOOT = 0x23;

/** bytes added around the cmd_len-covered region: head(1) + cmd_len(2) + check(1) + foot(1) */
export const ENVELOPE_EXTRA = 5;

/** total frame length of a plain positioning frame (cmd_type=1) */
export const LOC_LEN = 81;
/** total frame length of a positioning frame carrying RSSI (cmd_type=0x64) */
export const LOC_RSSI_LEN = 89;

/** `cmd_type` values (byte 19). */
export const CmdType = {
  LOC: 0x01, // 基站定位帧   - anchor positioning report
  ANCHOR_CFG: 0x02, // 基站配置帧   - anchor config
  TAG_CFG: 0x03, // 标签配置帧   - tag config
  OTA: 0x04, // OTA 升级帧
  ROBOT_CFG: 0x05, // 整机配置帧   - whole-machine (robot) config
  LOC_RSSI: 0x64, // 基站定位帧 RSSI
} as const;

const CMD_TYPE_NAMES: Record<number, string> = {
  [CmdType.LOC]: 'LOC',
  [CmdType.ANCHOR_CFG]: 'ANCHOR_CFG',
  [CmdType.TAG_CFG]: 'TAG_CFG',
  [CmdType.OTA]: 'OTA',
  [CmdType.ROBOT_CFG]: 'ROBOT_CFG',
  [CmdType.LOC_RSSI]: 'LOC_RSSI',
};

export function cmdTypeName(v: number): string {
  return CMD_TYPE_NAMES[v] ?? `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * `cmd_direct` values (byte 20). "engine" == the PC side.
 *
 * The document numbers these from 1:
 *   命令帧方向(1:引擎请求 2:设备回复 3:设备请求 4:引擎回复 5:引擎上报 6:设备上报)
 *
 * The car firmware's `Cmd_Direct_e` starts at 0 and is therefore off by one
 * against the document. The value actually seen on the wire for an anchor
 * positioning report is 5 -- which is what the document's own example frame
 * ([备注 6]) carries at index 20.
 */
export const CmdDirect = {
  ENGINE_REQ: 1, // 引擎请求
  DEV_REPLY: 2, // 设备回复
  DEV_REQ: 3, // 设备请求
  ENGINE_REPLY: 4, // 引擎回复
  ENGINE_REPORT: 5, // 引擎上报
  DEV_REPORT: 6, // 设备上报
} as const;

const CMD_DIRECT_NAMES: Record<number, string> = {
  [CmdDirect.ENGINE_REQ]: 'ENGINE_REQ',
  [CmdDirect.DEV_REPLY]: 'DEV_REPLY',
  [CmdDirect.DEV_REQ]: 'DEV_REQ',
  [CmdDirect.ENGINE_REPLY]: 'ENGINE_REPLY',
  [CmdDirect.ENGINE_REPORT]: 'ENGINE_REPORT',
  [CmdDirect.DEV_REPORT]: 'DEV_REPORT',
};

export function cmdDirectName(v: number): string {
  return CMD_DIRECT_NAMES[v] ?? String(v);
}

/** 设备类型 - tag_detail_para.dev_type */
export const DEV_TYPE_NAMES: Record<number, string> = {
  0: 'learn-board',
  1: 'wristband',
  2: 'remote',
};

export class FrameError extends Error {
  override readonly name = 'FrameError';
}

/**
 * XOR checksum, per [备注 2：校验计算程式].
 *
 *     check = data[offset] ^ data[offset+1] ^ ... ^ data[offset+length-1]
 */
export function xorCrc(data: Uint8Array, offset = 0, length?: number): number {
  const end = length === undefined ? data.length : offset + length;
  let crc = 0;
  for (let i = offset; i < end; i++) crc ^= data[i]!;
  return crc & 0xff;
}

/** One anchor's filtered measurement of a tag. */
export interface AnchorMeas {
  index: number;
  /** int16, degrees, signed */
  angleDeg: number;
  /** uint16, centimetres */
  rangeCm: number;
  /** int16, only present in LOC_RSSI frames */
  rssi: number | null;
}

/** Heuristic: an anchor that never ranged reports 0/0. */
export function anchorValid(a: AnchorMeas): boolean {
  return !(a.angleDeg === 0 && a.rangeCm === 0);
}

export function anchorRangeM(a: AnchorMeas): number {
  return a.rangeCm / 100;
}

/**
 * Cartesian offset (metres) of the tag relative to this anchor.
 * The anchor boresight is +Y; a positive angle is to the right (+X).
 */
export function anchorXY(a: AnchorMeas): { x: number; y: number } {
  const rad = (a.angleDeg * Math.PI) / 180;
  const r = anchorRangeM(a);
  return { x: r * Math.sin(rad), y: r * Math.cos(rad) };
}

/**
 * Decoded `tag_detail_para` bitfield, per [备注 1：位结构体].
 *
 * Bit layout of the uint32 (LSB first, as emitted by a little-endian C bitfield):
 *
 *     0      is_lowbattery              1
 *     1      is_alarm                   1
 *     2      is_chrg                    1
 *     3      is_tdby                    1
 *     4-13   battery_val               10   (350 == 3.50 V)
 *     14     is_offset_range_zero_bit    1
 *     15     is_offset_pdoa_zero_bit     1
 *     16     turn_up                     1   (remote only)
 *     17     turn_down                   1
 *     18     turn_left                   1
 *     19     turn_right                  1
 *     20-22  mode                        3   (remote only)
 *     23     recal                       1   (remote only)
 *     24     lock                        1   (remote only)
 *     25-27  dev_type                    3   (0 learn-board / 1 wristband / 2 remote)
 *     28-31  reserve                     4
 */
export interface TagDetail {
  raw: number;
  isLowbattery: boolean;
  isAlarm: boolean;
  isChrg: boolean;
  isTdby: boolean;
  /** raw, hundredths of a volt */
  batteryVal: number;
  isOffsetRangeZero: boolean;
  isOffsetPdoaZero: boolean;
  turnUp: boolean;
  turnDown: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  mode: number;
  recal: boolean;
  lock: boolean;
  devType: number;
  reserve: number;
}

export function decodeTagDetail(v: number): TagDetail {
  const u = v >>> 0;
  const b = (shift: number) => ((u >>> shift) & 1) === 1;
  return {
    raw: u,
    isLowbattery: b(0),
    isAlarm: b(1),
    isChrg: b(2),
    isTdby: b(3),
    batteryVal: (u >>> 4) & 0x3ff,
    isOffsetRangeZero: b(14),
    isOffsetPdoaZero: b(15),
    turnUp: b(16),
    turnDown: b(17),
    turnLeft: b(18),
    turnRight: b(19),
    mode: (u >>> 20) & 0x7,
    recal: b(23),
    lock: b(24),
    devType: (u >>> 25) & 0x7,
    reserve: (u >>> 28) & 0xf,
  };
}

export function emptyTagDetail(): TagDetail {
  return decodeTagDetail(0);
}

export function encodeTagDetail(d: Partial<TagDetail>): number {
  let v = 0;
  v |= (d.isLowbattery ? 1 : 0) << 0;
  v |= (d.isAlarm ? 1 : 0) << 1;
  v |= (d.isChrg ? 1 : 0) << 2;
  v |= (d.isTdby ? 1 : 0) << 3;
  v |= ((d.batteryVal ?? 0) & 0x3ff) << 4;
  v |= (d.isOffsetRangeZero ? 1 : 0) << 14;
  v |= (d.isOffsetPdoaZero ? 1 : 0) << 15;
  v |= (d.turnUp ? 1 : 0) << 16;
  v |= (d.turnDown ? 1 : 0) << 17;
  v |= (d.turnLeft ? 1 : 0) << 18;
  v |= (d.turnRight ? 1 : 0) << 19;
  v |= ((d.mode ?? 0) & 0x7) << 20;
  v |= (d.recal ? 1 : 0) << 23;
  v |= (d.lock ? 1 : 0) << 24;
  v |= ((d.devType ?? 0) & 0x7) << 25;
  v |= ((d.reserve ?? 0) & 0xf) << 28;
  return v >>> 0;
}

export function batteryVolts(d: TagDetail): number {
  return d.batteryVal / 100;
}

export function devTypeName(d: TagDetail): string {
  return DEV_TYPE_NAMES[d.devType] ?? `type${d.devType}`;
}

export function tagFlags(d: TagDetail): string[] {
  const out: string[] = [];
  if (d.isLowbattery) out.push('LOWBAT');
  if (d.isAlarm) out.push('ALARM');
  if (d.isChrg) out.push('CHRG');
  if (d.isTdby) out.push('FULL');
  if (d.lock) out.push('LOCK');
  if (d.recal) out.push('RECALL');
  if (d.turnUp) out.push('UP');
  if (d.turnDown) out.push('DOWN');
  if (d.turnLeft) out.push('LEFT');
  if (d.turnRight) out.push('RIGHT');
  return out;
}

interface FrameBase {
  saddr: bigint;
  daddr: bigint;
  cmdType: number;
  cmdDirect: number;
  raw: Uint8Array;
}

/** A positioning report (`cmd_type` 0x01 or 0x64). */
export interface LocFrame extends FrameBase {
  kind: 'loc';
  /** uint32, tag communication timestamp */
  tagTime: number;
  /** anchor short address */
  ancAddr16: number;
  /** tag short address */
  tagAddr16: number;
  /** rolling sequence number */
  tagSn: number;
  /** communication-valid mask */
  tagMask: number;
  anchors: AnchorMeas[];
  detail: TagDetail;
  /** accelerometer x/y/z (uint16 raw) */
  acc: [number, number, number];
  /** gyroscope x/y/z (uint16 raw) */
  gyro: [number, number, number];
  /** int16, unfiltered angle measured by this anchor */
  selfRawAngle: number;
  /** uint16 cm, unfiltered range */
  selfRawRange: number;
  /** int32, raw tag angle (anchor calibration) */
  selfRawDegree: number;
  /** uint16, 360-degree angle (robot builds) */
  angle360: number;
  /** uint8, coarse direction sector */
  angleDir: number;
  reserve: Uint8Array;
}

/** A config frame (`cmd_type` 2/3/5) whose payload is an ASCII command. */
export interface ConfigFrame extends FrameBase {
  kind: 'config';
  text: string;
  payload: Uint8Array;
}

/** Any well-formed frame we do not decode further (e.g. OTA). */
export interface RawFrame extends FrameBase {
  kind: 'raw';
  payload: Uint8Array;
}

export type Frame = LocFrame | ConfigFrame | RawFrame;

export function hasRssi(f: LocFrame): boolean {
  return f.cmdType === CmdType.LOC_RSSI;
}

/** Anchors that actually produced a measurement. */
export function activeAnchors(f: LocFrame): AnchorMeas[] {
  return f.anchors.filter(anchorValid);
}

/** Best single measurement to plot: the first anchor that ranged. */
export function primaryAnchor(f: LocFrame): AnchorMeas | null {
  return activeAnchors(f)[0] ?? null;
}

export function locXY(f: LocFrame): { x: number; y: number } | null {
  const p = primaryAnchor(f);
  return p ? anchorXY(p) : null;
}

const dvOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Decode the body of a positioning frame.
 *
 * Plain (0x01) and RSSI (0x64) frames share a layout up to offset 31; from
 * there the RSSI variant inserts an int16 after each anchor's range, which
 * shifts everything below it by 8 bytes.
 */
function parseLoc(buf: Uint8Array, withRssi: boolean): LocFrame {
  const dv = dvOf(buf);
  const anchors: AnchorMeas[] = [];
  const off = 31;
  const stride = withRssi ? 6 : 4;
  for (let i = 0; i < 4; i++) {
    const base = off + i * stride;
    anchors.push({
      index: i,
      angleDeg: dv.getInt16(base, true),
      rangeCm: dv.getUint16(base + 2, true),
      rssi: withRssi ? dv.getInt16(base + 4, true) : null,
    });
  }

  const p = off + 4 * stride; // 47 plain / 55 rssi

  return {
    kind: 'loc',
    saddr: dv.getBigUint64(3, true),
    daddr: dv.getBigUint64(11, true),
    cmdType: buf[19]!,
    cmdDirect: buf[20]!,
    tagTime: dv.getUint32(21, true),
    ancAddr16: dv.getUint16(25, true),
    tagAddr16: dv.getUint16(27, true),
    tagSn: buf[29]!,
    tagMask: buf[30]!,
    anchors,
    detail: decodeTagDetail(dv.getUint32(p, true)),
    acc: [dv.getUint16(p + 4, true), dv.getUint16(p + 6, true), dv.getUint16(p + 8, true)],
    gyro: [
      dv.getUint16(p + 10, true),
      dv.getUint16(p + 12, true),
      dv.getUint16(p + 14, true),
    ],
    selfRawAngle: dv.getInt16(p + 16, true),
    selfRawRange: dv.getUint16(p + 18, true),
    selfRawDegree: dv.getInt32(p + 20, true),
    angle360: dv.getUint16(p + 24, true),
    // angle_dir is a uint8 per the document (index 73 plain / 81 RSSI).
    angleDir: buf[p + 26]!,
    reserve: buf.slice(p + 27, p + 32),
    raw: buf.slice(),
  };
}

/**
 * Decode one complete frame.
 *
 * `buf` must be exactly one frame: head .. foot inclusive.
 * Throws `FrameError` if malformed.
 */
export function parseFrame(buf: Uint8Array, verify = true): Frame {
  if (buf.length < ENVELOPE_EXTRA + 18) {
    throw new FrameError(`too short: ${buf.length} bytes`);
  }
  if (buf[0] !== HEAD) {
    throw new FrameError(`bad head 0x${buf[0]!.toString(16).padStart(2, '0')}`);
  }

  const dv = dvOf(buf);
  const cmdLen = dv.getUint16(1, true);
  const total = cmdLen + ENVELOPE_EXTRA;
  if (buf.length !== total) {
    throw new FrameError(
      `length mismatch: cmd_len=${cmdLen} implies ${total} bytes, got ${buf.length}`,
    );
  }
  if (buf[buf.length - 1] !== FOOT) {
    throw new FrameError(`bad foot 0x${buf[buf.length - 1]!.toString(16).padStart(2, '0')}`);
  }

  if (verify) {
    const want = buf[3 + cmdLen]!;
    const got = xorCrc(buf, 3, cmdLen);
    if (want !== got) {
      throw new FrameError(
        `checksum mismatch: frame says 0x${want.toString(16)}, computed 0x${got.toString(16)}`,
      );
    }
  }

  const ctype = buf[19]!;

  if (ctype === CmdType.LOC || ctype === CmdType.LOC_RSSI) {
    const withRssi = ctype === CmdType.LOC_RSSI;
    const need = withRssi ? LOC_RSSI_LEN : LOC_LEN;
    if (buf.length < need) {
      throw new FrameError(`${cmdTypeName(ctype)} frame needs ${need} bytes, got ${buf.length}`);
    }
    return parseLoc(buf, withRssi);
  }

  const payload = buf.slice(21, 3 + cmdLen);
  const base = {
    saddr: dv.getBigUint64(3, true),
    daddr: dv.getBigUint64(11, true),
    cmdType: ctype,
    cmdDirect: buf[20]!,
    raw: buf.slice(),
  };

  if (ctype === CmdType.ANCHOR_CFG || ctype === CmdType.TAG_CFG || ctype === CmdType.ROBOT_CFG) {
    return {
      kind: 'config',
      ...base,
      text: decodeAscii(payload).replace(/\0+$/, '').trim(),
      payload,
    };
  }

  return { kind: 'raw', ...base, payload };
}

function decodeAscii(b: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8', { fatal: false }).decode(b);
  }
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

function encodeAscii(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Assemble a frame around `payload` (the bytes that follow `cmd_direct`). */
export function buildFrame(
  cmdType: number,
  payload: Uint8Array,
  saddr: bigint | number = 0n,
  daddr: bigint | number = 0n,
  cmdDirect: number = CmdDirect.ENGINE_REQ,
): Uint8Array {
  const body = new Uint8Array(18 + payload.length);
  const bdv = new DataView(body.buffer);
  const mask = 0xffffffffffffffffn;
  bdv.setBigUint64(0, BigInt(saddr) & mask, true);
  bdv.setBigUint64(8, BigInt(daddr) & mask, true);
  body[16] = cmdType & 0xff;
  body[17] = cmdDirect & 0xff;
  body.set(payload, 18);

  const out = new Uint8Array(body.length + ENVELOPE_EXTRA);
  const odv = new DataView(out.buffer);
  out[0] = HEAD;
  odv.setUint16(1, body.length, true);
  out.set(body, 3);
  out[3 + body.length] = xorCrc(body);
  out[4 + body.length] = FOOT;
  return out;
}

/** Build an anchor/tag/robot config frame carrying an ASCII `command`. */
export function buildConfigFrame(
  cmdType: number,
  command: string,
  saddr: bigint | number = 0n,
  daddr: bigint | number = 0n,
  cmdDirect: number = CmdDirect.ENGINE_REQ,
): Uint8Array {
  if (cmdType !== CmdType.ANCHOR_CFG && cmdType !== CmdType.TAG_CFG && cmdType !== CmdType.ROBOT_CFG) {
    throw new Error(`not a config cmd_type: ${cmdType}`);
  }
  return buildFrame(cmdType, encodeAscii(command), saddr, daddr, cmdDirect);
}

/* ------------------------------------------------------------------ hex --- */

export function toHex(b: Uint8Array, sep = ' '): string {
  const parts: string[] = [];
  for (const x of b) parts.push(x.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(sep);
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex string has an odd number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hex16(v: number): string {
  return `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function hex64(v: bigint): string {
  return `0x${v.toString(16).toUpperCase().padStart(16, '0')}`;
}

/** One-line human summary, mirroring `LocFrame.summary()` in pyassistant. */
export function summarizeLoc(f: LocFrame): string {
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const parts = [
    `t=${String(f.tagTime).padStart(10)}`,
    `anc=${hex16(f.ancAddr16)}`,
    `tag=${hex16(f.tagAddr16)}`,
    `sn=${String(f.tagSn).padStart(3)}`,
    `mask=0x${f.tagMask.toString(16).padStart(2, '0')}`,
  ];
  for (const a of f.anchors) {
    if (!anchorValid(a)) continue;
    let s = `A${a.index}: ${sign(a.angleDeg)}deg ${a.rangeCm}cm`;
    if (a.rssi !== null) s += ` ${sign(a.rssi)}dBm`;
    parts.push(s);
  }
  parts.push(`raw=${sign(f.selfRawAngle)}deg/${f.selfRawRange}cm`);
  parts.push(`bat=${batteryVolts(f.detail).toFixed(2)}V`);
  parts.push(devTypeName(f.detail));
  const fl = tagFlags(f.detail);
  if (fl.length) parts.push(`[${fl.join(',')}]`);
  return parts.join(' ');
}
