import { useEffect, useState } from 'react';

import { api, type PanTiltState } from '../api';

const STEPS = [2, 5, 10, 20];

export function PanTiltPanel() {
  const [state, setState] = useState<PanTiltState | null>(null);
  const [step, setStep] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .panTiltStatus()
      .then((r) => setState(r.state))
      .catch(() => undefined);
  }, []);

  async function run(action: () => Promise<{ state: PanTiltState }>) {
    setBusy(true);
    setError(null);
    try {
      const { state: next } = await action();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const move = (direction: 'up' | 'down' | 'left' | 'right') =>
    run(() => api.panTiltMove(direction, step));

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">pan / tilt</span>
        <label className="field">
          step
          <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
            {STEPS.map((s) => (
              <option key={s} value={s}>
                {s}°
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="panel-body">
        <div className="pantilt-pad">
          <span />
          <button className="ghost icon" disabled={busy} onClick={() => void move('up')} aria-label="Tilt up">
            ▲
          </button>
          <span />
          <button
            className="ghost icon"
            disabled={busy}
            onClick={() => void move('left')}
            aria-label="Pan left"
          >
            ◀
          </button>
          <button className="ghost icon" disabled={busy} onClick={() => void run(() => api.panTiltCenter())}>
            ●
          </button>
          <button
            className="ghost icon"
            disabled={busy}
            onClick={() => void move('right')}
            aria-label="Pan right"
          >
            ▶
          </button>
          <span />
          <button
            className="ghost icon"
            disabled={busy}
            onClick={() => void move('down')}
            aria-label="Tilt down"
          >
            ▼
          </button>
          <span />
        </div>
        {state ? (
          <p className="panel-sub pantilt-readout">
            pan {state.pan.toFixed(0)}° · tilt {state.tilt.toFixed(0)}°
          </p>
        ) : null}
        {state && !state.available ? (
          <p className="hint">{state.error ?? 'Pan-tilt HAT not detected.'}</p>
        ) : null}
        {error ? <p className="camera-error">{error}</p> : null}
      </div>
    </section>
  );
}
