/**
 * The anchor's own view: a +/-FOV wedge in (angle, range).
 *
 * Boresight is straight up, a positive angle goes to the right -- the same
 * convention `anchorXY` uses, so a tag that reads +30 degrees here sits to the
 * right of the origin in the Cartesian panel too.
 *
 * The viewBox is sized to the wedge rather than fixed, and `polarGeometry` is
 * exported so the layout can give the panel exactly that aspect. On a phone
 * that matters twice over: no dead space around the drawing, and label sizes
 * that survive being scaled down to a 390 px wide screen.
 */

import type { TagTrack } from '../useSession';
import { slotVar } from './colors';

/** Radius of the wedge in viewBox units. Everything else is derived from it. */
const R = 180;

/** How far past the arc the angle labels sit, as a fraction of R. */
const LABEL_PUSH = 1.045;

const rad = (deg: number) => (deg * Math.PI) / 180;

export interface PolarGeometry {
  fov: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** width / height of the viewBox -- give the panel this shape and the drawing fills it */
  aspect: number;
  /** base label size, in viewBox units */
  fs: number;
  marker: number;
  stroke: number;
}

/**
 * Size the viewBox to the wedge itself.
 *
 * A +/-90 degree wedge is a half disc (2:1); a +/-45 one is far closer to
 * square. A viewBox fixed at 2:1 pads the narrow cases with empty space, which
 * is exactly the space a phone does not have.
 *
 * `uiScale` grows labels and markers relative to the drawing. The viewBox grows
 * with them, so the wedge gives up a little radius in exchange for text that is
 * still legible once the SVG is scaled to a handset.
 */
export function polarGeometry(fovDeg: number, uiScale = 1): PolarGeometry {
  const fov = Math.min(Math.max(fovDeg, 5), 180);
  const fs = 7 * uiScale;

  // Horizontal reach peaks at 90 degrees; past that the wedge grows downward.
  const xExt = R * (fov >= 90 ? 1 : Math.sin(rad(fov)));
  const yBot = fov > 90 ? R * -Math.cos(rad(fov)) : 0;

  // Just enough room for the angle labels, which ride a hair outside the arc
  // (LABEL_PUSH) and are centred on their spoke. Tuned so the wedge keeps the
  // radius it had with a fixed 2:1 box while the labels grow.
  const padX = 8 + 1.15 * fs;
  const padT = 4 + 1.15 * fs;
  const padB = 4 + 1.0 * fs;

  const w = 2 * xExt + 2 * padX;
  const h = R + yBot + padT + padB;

  return {
    fov,
    w,
    h,
    cx: w / 2,
    cy: padT + R,
    aspect: w / h,
    fs,
    marker: 4.5 * uiScale,
    stroke: 1.2 * uiScale,
  };
}

/** Polar (degrees from boresight, metres) -> SVG user units. */
function project(g: PolarGeometry, angleDeg: number, rangeM: number, maxRange: number) {
  const r = (Math.min(rangeM, maxRange) / maxRange) * R;
  const a = rad(angleDeg);
  return { x: g.cx + r * Math.sin(a), y: g.cy - r * Math.cos(a) };
}

/**
 * The two `A` commands sweeping radius `rangeM` from -fov to +fov via boresight.
 *
 * A single arc from -fov to +fov is degenerate at fov = 180 (its endpoints
 * coincide); splitting at 0 keeps each segment under half a turn, so the same
 * code draws a 10 degree sliver and a full half-plane.
 */
function arcSegments(g: PolarGeometry, rangeM: number, fov: number, maxRange: number): string {
  const radius = (Math.min(rangeM, maxRange) / maxRange) * R;
  const seg = (to: number, sweep: 0 | 1) => {
    const p = project(g, to, rangeM, maxRange);
    return `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 ${sweep} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  };
  return `${seg(0, 1)} ${seg(fov, 1)}`;
}

/** A standalone arc: the range rings. */
function arcPath(g: PolarGeometry, rangeM: number, fov: number, maxRange: number): string {
  const start = project(g, -fov, rangeM, maxRange);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} ${arcSegments(g, rangeM, fov, maxRange)}`;
}

/** The filled wedge: pole, out to the left edge, around the arc, back to the pole. */
function wedgePath(g: PolarGeometry, maxRange: number): string {
  const edge = project(g, -g.fov, maxRange, maxRange);
  return (
    `M ${g.cx.toFixed(2)} ${g.cy.toFixed(2)} L ${edge.x.toFixed(2)} ${edge.y.toFixed(2)} ` +
    `${arcSegments(g, maxRange, g.fov, maxRange)} Z`
  );
}

interface Props {
  tracks: TagTrack[];
  rangeM: number;
  fovDeg: number;
  now: number;
  staleMs: number;
  /** >1 enlarges labels and markers relative to the wedge; use on small screens */
  uiScale?: number;
}

export function PolarView({ tracks, rangeM, fovDeg, now, staleMs, uiScale = 1 }: Props) {
  const g = polarGeometry(fovDeg, uiScale);
  const { fov } = g;

  // The outermost ring is the wedge boundary, already drawn by wedgePath, and
  // its label would land on top of the 0 degree spoke label at the apex. The
  // panel header carries the range instead.
  const rings = [0.25, 0.5, 0.75].map((f) => f * rangeM);
  const spokes: number[] = [];
  const step = fov > 60 ? 30 : 15;
  for (let a = -Math.floor(fov / step) * step; a <= fov; a += step) spokes.push(a);

  return (
    <svg
      viewBox={`0 0 ${g.w.toFixed(2)} ${g.h.toFixed(2)}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
      role="img"
      aria-label={`Anchor view, ${tracks.length} tags within ${rangeM} metres, field of view plus/minus ${fov} degrees`}
    >
      {/* wedge outline */}
      <path
        d={wedgePath(g, rangeM)}
        fill="var(--surface)"
        stroke="var(--axis)"
        strokeWidth={g.stroke * 0.8}
      />

      {/* range rings */}
      {rings.map((m) => (
        <g key={m}>
          <path
            d={arcPath(g, m, fov, rangeM)}
            fill="none"
            stroke="var(--grid)"
            strokeWidth={g.stroke * 0.6}
          />
          <text
            x={g.cx + g.fs * 0.4}
            y={g.cy - (m / rangeM) * R - g.fs * 0.3}
            fontSize={g.fs}
            fill="var(--muted)"
            fontFamily="var(--mono)"
          >
            {m.toFixed(m < 10 ? 1 : 0)}m
          </text>
        </g>
      ))}

      {/* angle spokes */}
      {spokes.map((a) => {
        const p = project(g, a, rangeM, rangeM);
        // project() clamps to maxRange, so push the label out from the pole
        // rather than asking for a radius beyond the outer ring.
        const lx = g.cx + (p.x - g.cx) * LABEL_PUSH;
        const ly = g.cy + (p.y - g.cy) * LABEL_PUSH;
        return (
          <g key={a}>
            <line
              x1={g.cx}
              y1={g.cy}
              x2={p.x}
              y2={p.y}
              stroke="var(--grid)"
              strokeWidth={a === 0 ? g.stroke * 0.8 : g.stroke * 0.5}
              strokeDasharray={a === 0 ? undefined : `${g.stroke * 1.6} ${g.stroke * 2.4}`}
            />
            <text
              x={lx}
              y={ly + g.fs * 0.35}
              fontSize={g.fs}
              fill="var(--muted)"
              textAnchor="middle"
              fontFamily="var(--mono)"
            >
              {a > 0 ? `+${a}` : a}
            </text>
          </g>
        );
      })}

      {/* tags */}
      {tracks.map((t) => {
        const stale = now - t.last > staleMs;
        const color = slotVar(t.slot);
        const pts = t.angles
          .map((a, i) => {
            const p = project(g, a, t.ranges[i] ?? 0, rangeM);
            return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          })
          .join(' ');
        const lastA = t.angles[t.angles.length - 1];
        const lastR = t.ranges[t.ranges.length - 1];
        if (lastA === undefined || lastR === undefined) return null;
        const head = project(g, lastA, lastR, rangeM);
        return (
          <g key={t.addr} opacity={stale ? 0.28 : 1}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth={g.stroke} opacity={0.35} />
            <circle
              cx={head.x}
              cy={head.y}
              r={g.marker}
              fill={color}
              stroke="var(--surface)"
              strokeWidth={g.stroke * 1.2}
            />
          </g>
        );
      })}

      {/* the anchor itself */}
      <polygon
        points={`${g.cx},${g.cy - g.marker * 1.5} ${g.cx - g.marker},${g.cy + g.marker * 0.5} ${g.cx + g.marker},${g.cy + g.marker * 0.5}`}
        fill="var(--ink-2)"
      />
    </svg>
  );
}
