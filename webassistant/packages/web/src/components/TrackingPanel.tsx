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
  const [panMinDeg, setPanMinDeg] = useState(0);
  const [panMaxDeg, setPanMaxDeg] = useState(180);
  const [thresholdDeg, setThresholdDeg] = useState(10);
  const [stepDeg, setStepDeg] = useState(10);
  const [cooldownMs, setCooldownMs] = useState(400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to the first tag seen once one shows up, so the selector is not empty.
  useEffect(() => {
    if (tagAddr === null && tracks.length > 0) setTagAddr(tracks[0].addr);
  }, [tracks, tagAddr]);

  useEffect(() => {
    if (!tracking) return;
    setPanMinDeg(tracking.panMinDeg);
    setPanMaxDeg(tracking.panMaxDeg);
    setThresholdDeg(tracking.thresholdDeg);
    setStepDeg(tracking.stepDeg);
    setCooldownMs(tracking.cooldownMs);
  }, [tracking]);

  const active = tracking?.active ?? false;

  async function start() {
    if (tagAddr === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.trackingStart({ tagAddr, panMinDeg, panMaxDeg, thresholdDeg, stepDeg, cooldownMs });
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

  async function saveSettings(next: {
    panMinDeg?: number;
    panMaxDeg?: number;
    thresholdDeg?: number;
    stepDeg?: number;
    cooldownMs?: number;
  }) {
    if (!tracking) return;
    setBusy(true);
    setError(null);
    try {
      await api.trackingSettings({
        panMinDeg: next.panMinDeg ?? tracking.panMinDeg,
        panMaxDeg: next.panMaxDeg ?? tracking.panMaxDeg,
        thresholdDeg: next.thresholdDeg ?? tracking.thresholdDeg,
        stepDeg: next.stepDeg ?? tracking.stepDeg,
        cooldownMs: next.cooldownMs ?? tracking.cooldownMs,
      });
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
            pan min
            <input
              type="number"
              min="0"
              max="179"
              value={panMinDeg}
              disabled={active || busy}
              onChange={(e) => void saveSettings({ panMinDeg: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            pan max
            <input
              type="number"
              min="1"
              max="180"
              value={panMaxDeg}
              disabled={active || busy}
              onChange={(e) => void saveSettings({ panMaxDeg: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            threshold
            <select
              value={thresholdDeg}
              disabled={active || busy}
              onChange={(e) => void saveSettings({ thresholdDeg: Number(e.target.value) })}
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
            <select
              value={stepDeg}
              disabled={active || busy}
              onChange={(e) => void saveSettings({ stepDeg: Number(e.target.value) })}
            >
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
              disabled={active || busy}
              onChange={(e) => void saveSettings({ cooldownMs: Number(e.target.value) })}
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
