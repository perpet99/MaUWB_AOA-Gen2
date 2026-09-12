/**
 * CSV schema for decoded positioning frames -- one row per frame.
 *
 * Isomorphic on purpose: the server writes the same columns to disk that the
 * browser offers as a download, so a capture analysed in pandas and one
 * exported from the UI are interchangeable.
 */

import { batteryVolts, devTypeName, hex16 } from './protocol.js';
import type { WireLocFrame } from './wire.js';

export const CSV_COLUMNS = [
  'host_time',
  'tag_time',
  'cmd_type',
  'cmd_direct',
  'anc_addr16',
  'tag_addr16',
  'tag_sn',
  'tag_mask',
  'a0_angle',
  'a0_range',
  'a0_rssi',
  'a1_angle',
  'a1_range',
  'a1_rssi',
  'a2_angle',
  'a2_range',
  'a2_rssi',
  'a3_angle',
  'a3_range',
  'a3_rssi',
  'x_m',
  'y_m',
  'self_raw_angle',
  'self_raw_range',
  'self_raw_degree',
  'angle_360',
  'angle_dir',
  'battery_v',
  'dev_type',
  'lowbattery',
  'alarm',
  'chrg',
  'full',
  'turn_up',
  'turn_down',
  'turn_left',
  'turn_right',
  'mode',
  'recal',
  'lock',
  'acc_x',
  'acc_y',
  'acc_z',
  'gyro_x',
  'gyro_y',
  'gyro_z',
  'detail_raw',
] as const;

const bit = (b: boolean) => (b ? 1 : 0);

/** Flatten one positioning frame into a row matching `CSV_COLUMNS`. */
export function locToCsvRow(f: WireLocFrame): (string | number)[] {
  const d = f.detail;
  const row: (string | number)[] = [
    (f.hostTime / 1000).toFixed(6),
    f.tagTime,
    f.cmdType,
    f.cmdDirect,
    hex16(f.ancAddr16),
    hex16(f.tagAddr16),
    f.tagSn,
    f.tagMask,
  ];
  for (let i = 0; i < 4; i++) {
    const a = f.anchors[i];
    if (!a) row.push('', '', '');
    else row.push(a.angleDeg, a.rangeCm, a.rssi === null ? '' : a.rssi);
  }
  row.push(f.xy ? f.xy.x.toFixed(4) : '', f.xy ? f.xy.y.toFixed(4) : '');
  row.push(f.selfRawAngle, f.selfRawRange, f.selfRawDegree, f.angle360, f.angleDir);
  row.push(
    batteryVolts(d).toFixed(2),
    devTypeName(d),
    bit(d.isLowbattery),
    bit(d.isAlarm),
    bit(d.isChrg),
    bit(d.isTdby),
    bit(d.turnUp),
    bit(d.turnDown),
    bit(d.turnLeft),
    bit(d.turnRight),
    d.mode,
    bit(d.recal),
    bit(d.lock),
  );
  row.push(...f.acc, ...f.gyro);
  row.push(`0x${d.raw.toString(16).toUpperCase().padStart(8, '0')}`);
  return row;
}

/** Quote a single CSV field per RFC 4180. */
export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: readonly (string | number)[]): string {
  return values.map(csvField).join(',');
}

/** Full CSV document for a batch of frames, header included. */
export function framesToCsv(frames: WireLocFrame[]): string {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const f of frames) lines.push(csvLine(locToCsvRow(f)));
  return lines.join('\r\n') + '\r\n';
}
