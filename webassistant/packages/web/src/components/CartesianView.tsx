/**
 * The same tags in metres, anchor at the origin, with a fading trail each.
 *
 * The panel spans -range..+range horizontally and a little below zero to
 * +range vertically, which is the natural frame for a forward-looking anchor:
 * the wedge in the polar panel maps onto the upper half of this one.
 *
 * The plot area is a fixed size in viewBox units; `uiScale` only grows the
 * margins that hold the tick labels, so enlarging text for a phone costs no
 * plotting space.
 */

import { batteryVolts } from '@mauwb/protocol';

import type { TagTrack } from '../useSession';
import { slotVar } from './colors';

const PLOT_W = 360;
const PLOT_H = 210;

export interface CartesianGeometry {
  w: number;
  h: number;
  pad: { top: number; right: number; bottom: number; left: number };
  aspect: number;
  fs: number;
  marker: number;
  stroke: number;
}

export function cartesianGeometry(uiScale = 1): CartesianGeometry {
  const fs = 7.5 * uiScale;
  const pad = {
    top: 8,
    right: 8,
    bottom: 4 + 2.3 * fs, // x ticks plus the axis caption
    left: 4 + 2.6 * fs, // y ticks plus the rotated caption
  };
  const w = PLOT_W + pad.left + pad.right;
  const h = PLOT_H + pad.top + pad.bottom;
  return {
    w,
    h,
    pad,
    aspect: w / h,
    fs,
    marker: 4.5 * uiScale,
    stroke: 1.2 * uiScale,
  };
}

/** Label offsets per slot, so tags that sit close together stay readable. */
const LABEL_OFFSETS: [number, number][] = [
  [1, -0.9],
  [1, 1.7],
  [-1, -0.9],
  [-1, 1.7],
];

interface Props {
  tracks: TagTrack[];
  rangeM: number;
  now: number;
  staleMs: number;
  uiScale?: number;
}

export function CartesianView({ tracks, rangeM, now, staleMs, uiScale = 1 }: Props) {
  const g = cartesianGeometry(uiScale);
  const { pad } = g;
  const yMin = -0.6;
  const yMax = rangeM;

  const sx = (x: number) => pad.left + ((x + rangeM) / (2 * rangeM)) * PLOT_W;
  const sy = (y: number) => pad.top + PLOT_H - ((y - yMin) / (yMax - yMin)) * PLOT_H;

  const step = rangeM <= 4 ? 1 : rangeM <= 12 ? 2 : 5;
  const xTicks: number[] = [];
  for (let v = -Math.floor(rangeM / step) * step; v <= rangeM; v += step) xTicks.push(v);
  const yTicks = xTicks.filter((v) => v >= 0);

  return (
    <svg
      viewBox={`0 0 ${g.w.toFixed(2)} ${g.h.toFixed(2)}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
      role="img"
      aria-label={`Tag positions in metres, ${tracks.length} tags`}
    >
      <rect
        x={pad.left}
        y={pad.top}
        width={PLOT_W}
        height={PLOT_H}
        fill="var(--surface)"
        stroke="var(--axis)"
        strokeWidth={g.stroke * 0.8}
      />

      {xTicks.map((v) => (
        <g key={`x${v}`}>
          <line
            x1={sx(v)}
            y1={pad.top}
            x2={sx(v)}
            y2={pad.top + PLOT_H}
            stroke="var(--grid)"
            strokeWidth={v === 0 ? g.stroke * 0.8 : g.stroke * 0.5}
          />
          <text
            x={sx(v)}
            y={pad.top + PLOT_H + g.fs * 1.2}
            fontSize={g.fs}
            fill="var(--muted)"
            textAnchor="middle"
            fontFamily="var(--mono)"
          >
            {v}
          </text>
        </g>
      ))}

      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line
            x1={pad.left}
            y1={sy(v)}
            x2={pad.left + PLOT_W}
            y2={sy(v)}
            stroke="var(--grid)"
            strokeWidth={v === 0 ? g.stroke * 0.8 : g.stroke * 0.5}
          />
          <text
            x={pad.left - g.fs * 0.45}
            y={sy(v) + g.fs * 0.35}
            fontSize={g.fs}
            fill="var(--muted)"
            textAnchor="end"
            fontFamily="var(--mono)"
          >
            {v}
          </text>
        </g>
      ))}

      <text
        x={pad.left + PLOT_W / 2}
        y={g.h - g.fs * 0.25}
        fontSize={g.fs}
        fill="var(--muted)"
        textAnchor="middle"
      >
        x (m)
      </text>
      <text
        x={g.fs}
        y={pad.top + PLOT_H / 2}
        fontSize={g.fs}
        fill="var(--muted)"
        textAnchor="middle"
        transform={`rotate(-90 ${g.fs} ${pad.top + PLOT_H / 2})`}
      >
        y (m)
      </text>

      {/* trails and markers first, so no marker can land on another tag's label */}
      {tracks.map((t) => {
        const stale = now - t.last > staleMs;
        const color = slotVar(t.slot);
        const pts = t.xs.map((x, i) => `${sx(x).toFixed(1)},${sy(t.ys[i] ?? 0).toFixed(1)}`).join(' ');
        const lx = t.xs[t.xs.length - 1];
        const ly = t.ys[t.ys.length - 1];
        if (lx === undefined || ly === undefined) return null;
        return (
          <g key={t.addr} opacity={stale ? 0.28 : 1}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth={g.stroke} opacity={0.35} />
            <circle
              cx={sx(lx)}
              cy={sy(ly)}
              r={g.marker}
              fill={color}
              stroke="var(--surface)"
              strokeWidth={g.stroke * 1.2}
            />
          </g>
        );
      })}

      {/* then every label, each carrying a halo so it reads over a trail */}
      {tracks.map((t) => {
        const lx = t.xs[t.xs.length - 1];
        const ly = t.ys[t.ys.length - 1];
        if (lx === undefined || ly === undefined) return null;

        const stale = now - t.last > staleMs;
        const d = t.frame?.detail;
        const alarming = d ? d.isAlarm || d.isLowbattery : false;
        const [ox, oy] = LABEL_OFFSETS[t.slot % 4]!;
        const anchorEnd = t.slot % 4 >= 2;

        // Scaled-up labels collide once tags cluster, so a small screen gets the
        // address and any alarm only -- the battery reading is in the table.
        const terse = uiScale > 1.2;
        let label = `0x${t.addr.toString(16).toUpperCase().padStart(4, '0')}`;
        if (d) {
          if (!terse) label += `  ${batteryVolts(d).toFixed(2)}V`;
          if (d.isAlarm) label += '  ALARM';
          else if (d.isLowbattery && !terse) label += '  LOW';
        }

        return (
          <text
            key={t.addr}
            x={sx(lx) + ox * g.fs}
            y={sy(ly) + oy * g.fs}
            fontSize={g.fs}
            fontWeight={600}
            fill={alarming ? 'var(--critical)' : 'var(--ink)'}
            stroke="var(--surface)"
            strokeWidth={g.stroke * 2.2}
            paintOrder="stroke"
            strokeLinejoin="round"
            textAnchor={anchorEnd ? 'end' : 'start'}
            fontFamily="var(--mono)"
            opacity={stale ? 0.28 : 1}
          >
            {label}
          </text>
        );
      })}

      {/* the anchor sits at the origin */}
      <polygon
        points={`${sx(0)},${sy(0) - g.marker * 1.4} ${sx(0) - g.marker},${sy(0) + g.marker * 0.7} ${sx(0) + g.marker},${sy(0) + g.marker * 0.7}`}
        fill="var(--ink-2)"
      />
      <text
        x={sx(0)}
        y={sy(0) + g.marker * 0.7 + g.fs * 1.2}
        fontSize={g.fs * 0.92}
        fill="var(--muted)"
        textAnchor="middle"
      >
        anchor
      </text>
    </svg>
  );
}
