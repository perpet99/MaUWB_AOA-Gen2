/**
 * Application shell.
 *
 * Layout mirrors mauwb_viewer.py: the anchor's own polar view beside the same
 * tags in metres, with the numeric readouts the plots cannot carry underneath
 * and the control surface on the right.
 *
 * On a phone the two charts stack and each panel is given the exact aspect its
 * SVG reports, so the drawing fills the width with no dead space, and label
 * and marker sizes are scaled up to survive the reduction. Either chart can be
 * expanded to the whole viewport -- useful in landscape, where a half disc
 * finally has room to be big.
 */

import { useEffect, useMemo, useState } from 'react';

import { CartesianView, cartesianGeometry } from './components/CartesianView';
import { CameraPanel } from './components/CameraPanel';
import { CommandPanel } from './components/CommandPanel';
import { ConnectionBar } from './components/ConnectionBar';
import { FrameLog } from './components/FrameLog';
import { PolarView, polarGeometry } from './components/PolarView';
import { RecordPanel } from './components/RecordPanel';
import { TagTable } from './components/TagTable';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';
import { useSession } from './useSession';

const STALE_MS = 2000;

type Expanded = 'polar' | 'cartesian' | null;

export default function App() {
  const [rangeM, setRangeM] = useState(10);
  const [fov, setFov] = useState(90);
  const [trail, setTrail] = useState(120);
  const [showLoc, setShowLoc] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Expanded>(null);

  const isPhone = useMediaQuery(PHONE_QUERY);
  // Label sizes live in viewBox units, so they shrink with the SVG. A handset
  // renders the wedge at roughly 1:1 with the viewBox, where 7 units is ~7 px.
  const uiScale = isPhone ? 1.9 : 1;

  const { state, connected, notices, dismissNotice, tracks, log, clear, setIncludeRaw } = useSession({
    trail,
  });

  // A clock that ticks twice a second, so "stale" dimming happens even when no
  // frames are arriving to trigger a render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Leave an expanded chart with Escape, the way any lightbox behaves.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const liveCount = useMemo(
    () => tracks.filter((t) => now - t.last <= STALE_MS).length,
    [tracks, now],
  );

  const polarAspect = polarGeometry(fov, uiScale).aspect;
  const cartAspect = cartesianGeometry(uiScale).aspect;
  const s = state.stats;

  const chartStyle = (aspect: number) =>
    ({ ['--chart-aspect' as string]: String(aspect.toFixed(3)) }) as React.CSSProperties;

  const expandButton = (which: Exclude<Expanded, null>) => (
    <button
      className="ghost icon"
      onClick={() => setExpanded(expanded === which ? null : which)}
      aria-label={expanded === which ? 'Shrink chart' : 'Expand chart to full screen'}
      title={expanded === which ? 'Shrink (Esc)' : 'Expand'}
    >
      {expanded === which ? '⤡' : '⤢'}
    </button>
  );

  return (
    <div className={`app${expanded ? ' has-expanded' : ''}`}>
      <ConnectionBar state={state} wsConnected={connected} onError={setLocalError} onClear={clear} />

      {localError ? (
        <div className="notice error" onClick={() => setLocalError(null)} role="alert">
          {localError} <span className="panel-sub">(click to dismiss)</span>
        </div>
      ) : null}

      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`} onClick={() => dismissNotice(n.id)}>
          {n.message}
        </div>
      ))}

      <div className="app-main">
        <div className="column">
          <div className="views">
            <section className={`panel chart-panel${expanded === 'polar' ? ' expanded' : ''}`}>
              <header className="panel-head">
                <span className="panel-title">anchor view (angle, range)</span>
                <div className="row tight" style={{ alignItems: 'center' }}>
                  <span className="panel-sub">
                    ±{fov}° · {rangeM} m
                  </span>
                  {expandButton('polar')}
                </div>
              </header>
              <div className="panel-body chart" style={chartStyle(polarAspect)}>
                <PolarView
                  tracks={tracks}
                  rangeM={rangeM}
                  fovDeg={fov}
                  now={now}
                  staleMs={STALE_MS}
                  uiScale={uiScale}
                />
              </div>
            </section>

            <section className={`panel chart-panel${expanded === 'cartesian' ? ' expanded' : ''}`}>
              <header className="panel-head">
                <span className="panel-title">position (metres from anchor)</span>
                <div className="row tight" style={{ alignItems: 'center' }}>
                  <span className="panel-sub">
                    {liveCount}/{tracks.length} live
                  </span>
                  {expandButton('cartesian')}
                </div>
              </header>
              <div className="panel-body chart" style={chartStyle(cartAspect)}>
                <CartesianView
                  tracks={tracks}
                  rangeM={rangeM}
                  now={now}
                  staleMs={STALE_MS}
                  uiScale={uiScale}
                />
              </div>
            </section>
          </div>

          <section className="panel">
            <header className="panel-head wrap">
              <span className="panel-title">tags</span>
              <div className="row tight">
                <label className="field">
                  range
                  <select value={rangeM} onChange={(e) => setRangeM(Number(e.target.value))}>
                    {[3, 5, 7, 10, 15, 20, 30].map((r) => (
                      <option key={r} value={r}>
                        {r} m
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  fov
                  <select value={fov} onChange={(e) => setFov(Number(e.target.value))}>
                    {[45, 60, 90, 120, 180].map((f) => (
                      <option key={f} value={f}>
                        ±{f}°
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  trail
                  <select value={trail} onChange={(e) => setTrail(Number(e.target.value))}>
                    {[30, 60, 120, 250, 500].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ghost" onClick={clear}>
                  Clear
                </button>
              </div>
            </header>
            <div className="panel-body flush tag-table">
              <TagTable tracks={tracks} now={now} staleMs={STALE_MS} />
            </div>
          </section>

          <section className="panel log-panel">
            <header className="panel-head">
              <span className="panel-title">frames</span>
              <label className="row tight" style={{ alignItems: 'center', fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={showLoc}
                  onChange={(e) => setShowLoc(e.target.checked)}
                  style={{ width: 14, height: 14 }}
                />
                show positioning frames
              </label>
            </header>
            <FrameLog frames={log} follow showLoc={showLoc} />
          </section>
        </div>

        <div className="column side">
          <CameraPanel />

          <section className="panel">
            <header className="panel-head">
              <span className="panel-title">config commands</span>
            </header>
            <div className="panel-body">
              <CommandPanel state={state} onError={setLocalError} />
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <span className="panel-title">record</span>
            </header>
            <div className="panel-body">
              <RecordPanel
                state={state}
                frames={log}
                includeRaw={state.includeRaw}
                onIncludeRaw={setIncludeRaw}
                onError={setLocalError}
              />
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <span className="panel-title">report format</span>
            </header>
            <div className="panel-body">
              <p className="hint">
                The anchor&apos;s <code>setcfg</code> 7th argument selects the upper-computer report
                format. This tool decodes <strong>0 (generic binary)</strong> only. If no frames
                arrive, that value is almost certainly not 0:
              </p>
              <pre className="log" style={{ padding: 8, marginTop: 8, maxHeight: 90 }}>
                {'anchor  getcfg\nanchor  setcfg 1 1 1111 1 100 1 0\nanchor  saver'}
              </pre>
            </div>
          </section>
        </div>
      </div>

      <div className="statbar">
        <Stat k="frames" v={s.frames.toLocaleString()} />
        <Stat k="loc/s" v={s.locPerSec.toFixed(1)} />
        <Stat k="tags" v={`${liveCount}/${tracks.length}`} />
        <Stat k="bytes in" v={fmtBytes(s.bytesIn)} />
        <Stat k="bad crc" v={s.badChecksum.toString()} tone={s.badChecksum ? 'bad' : undefined} />
        <Stat k="resyncs" v={s.resyncs.toString()} tone={s.resyncs ? 'warn' : undefined} />
        <Stat k="dropped" v={fmtBytes(s.droppedBytes)} tone={s.droppedBytes ? 'warn' : undefined} />
        {state.error ? <Stat k="error" v={state.error} tone="bad" /> : null}
      </div>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`v${tone ? ` ${tone}` : ''}`}>{v}</span>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
