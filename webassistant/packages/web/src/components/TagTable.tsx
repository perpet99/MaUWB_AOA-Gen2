/**
 * One row per tag: the newest measurement plus the decoded `tag_detail_para`
 * flags. This is the readout the polar/Cartesian panels cannot give you --
 * battery, device type, remote buttons, and per-anchor RSSI.
 */

import { batteryVolts, devTypeName, tagFlags } from '@mauwb/protocol';

import type { TagTrack } from '../useSession';
import { slotVar } from './colors';

interface Props {
  tracks: TagTrack[];
  now: number;
  staleMs: number;
}

export function TagTable({ tracks, now, staleMs }: Props) {
  if (!tracks.length) {
    return <div className="empty">No tags yet. Connect a source to start decoding.</div>;
  }

  const sorted = [...tracks].sort((a, b) => a.slot - b.slot);

  return (
    <table>
      <thead>
        <tr>
          <th>tag</th>
          <th className="num">angle</th>
          <th className="num">range</th>
          <th className="num">rssi</th>
          <th className="num">batt</th>
          <th>type</th>
          <th>flags</th>
          <th className="num">n</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const f = t.frame;
          const stale = now - t.last > staleMs;
          const a = f?.anchors.find((x) => x.valid) ?? null;
          const d = f?.detail ?? null;
          const flags = d ? tagFlags(d) : [];
          const volts = d ? batteryVolts(d) : 0;

          return (
            <tr key={t.addr} className={stale ? 'stale' : undefined}>
              <td className="mono">
                <span className="swatch" style={{ background: slotVar(t.slot) }} />
                0x{t.addr.toString(16).toUpperCase().padStart(4, '0')}
              </td>
              <td className="num mono">{a ? `${a.angleDeg > 0 ? '+' : ''}${a.angleDeg}°` : '—'}</td>
              <td className="num mono">{a ? `${(a.rangeCm / 100).toFixed(2)} m` : '—'}</td>
              <td className="num mono">{a?.rssi !== null && a?.rssi !== undefined ? a.rssi : '—'}</td>
              <td className="num mono" style={d?.isLowbattery ? { color: 'var(--warning)' } : undefined}>
                {d ? `${volts.toFixed(2)}V` : '—'}
              </td>
              <td>{d ? devTypeName(d) : '—'}</td>
              <td>
                {flags.map((fl) => (
                  <span
                    key={fl}
                    className={`badge ${fl === 'ALARM' ? 'alarm' : fl === 'LOWBAT' ? 'low' : ''}`}
                    style={{ marginRight: 3 }}
                  >
                    {fl}
                  </span>
                ))}
              </td>
              <td className="num mono">{t.count}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
