import { useEffect, useState } from 'react';

import { api } from '../api';
import type { TagTrack } from '../useSession';
import type { TrackingState } from '@mauwb/protocol';

export function TrackingPanel({
  tracks,
  tracking,
}: {
  tracks: TagTrack[];
  tracking: TrackingState | null;
}) {
  const [tagAddr, setTagAddr] = useState<number | null>(null);
  const [thresholdDeg, setThresholdDeg] = useState(10);
  const [stepDeg, setStepDeg] = useState(10);
  const [cooldownMs, setCooldownMs] = useState(400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to the first tag seen once one shows up, so the selector is not empty.
  useEffect(() => {
    if (tagAddr === null && tracks.length > 0) setTagAddr(tracks[0].addr);
  }, [tracks, tagAddr]);

  const active = tracking?.active ?? false;

  async function start() {
    if (tagAddr === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.trackingStart({ tagAddr, thresholdDeg, stepDeg, cooldownMs });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.trackingStop();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">tracking</span>
      </header>
      <div className="panel-body stack">
        <label className="field">
          tag
          <select
            value={tagAddr ?? ''}
            disabled={active}
            onChange={(e) => setTagAddr(Number(e.target.value))}
          >
            {tracks.length === 0 ? <option value="">no tags seen</option> : null}
            {tracks.map((t) => (
              <option key={t.addr} value={t.addr}>
                0x{t.addr.toString(16).toUpperCase().padStart(4, '0')}
              </option>
            ))}
          </select>
        </label>

        <div className="row tight">
          <label className="field">
            threshold
            <select
              value={thresholdDeg}
              disabled={active}
              onChange={(e) => setThresholdDeg(Number(e.target.value))}
            >
              {[5, 10, 15, 20].map((v) => (
                <option key={v} value={v}>
                  {v}°
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            step
            <select value={stepDeg} disabled={active} onChange={(e) => setStepDeg(Number(e.target.value))}>
              {[5, 10, 15, 20].map((v) => (
                <option key={v} value={v}>
                  {v}°
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            cooldown
            <select
              value={cooldownMs}
              disabled={active}
              onChange={(e) => setCooldownMs(Number(e.target.value))}
            >
              {[200, 400, 600, 1000].map((v) => (
                <option key={v} value={v}>
                  {v} ms
                </option>
              ))}
            </select>
          </label>
        </div>

        {active ? (
          <button className="danger" disabled={busy} onClick={() => void stop()}>
            Stop tracking
          </button>
        ) : (
          <button className="primary" disabled={busy || tagAddr === null} onClick={() => void start()}>
            Start tracking
          </button>
        )}

        {tracking?.active ? (
          <p className="panel-sub">
            angle {tracking.lastAngleDeg?.toFixed(1) ?? '--'}°
            {tracking.stale ? ' · tag signal lost' : ''}
            {tracking.panLimitReached ? ' · pan limit reached' : ''}
          </p>
        ) : null}
        {error ? <p className="camera-error">{error}</p> : null}
      </div>
    </section>
  );
}
