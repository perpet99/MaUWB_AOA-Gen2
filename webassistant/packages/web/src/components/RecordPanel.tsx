/**
 * Recording controls.
 *
 * Two independent sinks, exactly as in pyassistant: a raw byte capture that can
 * be replayed through `file://`, and a decoded CSV. The browser can also export
 * whatever is currently in its own buffer, which needs no server round trip.
 */

import { useState } from 'react';

import { framesToCsv, type SessionState, type WireFrame, type WireLocFrame } from '@mauwb/protocol';

import { api } from '../api';

interface Props {
  state: SessionState;
  frames: WireFrame[];
  includeRaw: boolean;
  onIncludeRaw: (v: boolean) => void;
  onError: (message: string) => void;
}

function download(name: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function RecordPanel({ state, frames, includeRaw, onIncludeRaw, onError }: Props) {
  const [csvPath, setCsvPath] = useState('captures/session.csv');
  const [rawPath, setRawPath] = useState('captures/session.bin');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const locFrames = frames.filter((f): f is WireLocFrame => f.kind === 'loc');

  return (
    <div className="stack">
      <label className="field">
        server-side CSV
        <div className="row tight">
          <input
            className="mono"
            style={{ flex: 1, minWidth: 0 }}
            value={csvPath}
            onChange={(e) => setCsvPath(e.target.value)}
            disabled={!!state.csvPath}
          />
          {state.csvPath ? (
            <button className="danger" disabled={busy} onClick={() => void guard(api.stopCsv)}>
              Stop
            </button>
          ) : (
            <button disabled={busy} onClick={() => void guard(() => api.startCsv(csvPath))}>
              Start
            </button>
          )}
        </div>
      </label>
      {state.csvPath ? (
        <p className="hint">
          {state.csvRows.toLocaleString()} rows → <code>{state.csvPath}</code>
        </p>
      ) : null}

      <label className="field">
        server-side raw capture
        <div className="row tight">
          <input
            className="mono"
            style={{ flex: 1, minWidth: 0 }}
            value={rawPath}
            onChange={(e) => setRawPath(e.target.value)}
            disabled={!!state.rawPath}
          />
          {state.rawPath ? (
            <button className="danger" disabled={busy} onClick={() => void guard(api.stopRaw)}>
              Stop
            </button>
          ) : (
            <button disabled={busy} onClick={() => void guard(() => api.startRaw(rawPath))}>
              Start
            </button>
          )}
        </div>
      </label>
      {state.rawPath ? (
        <p className="hint">
          {(state.rawBytes / 1024).toFixed(1)} KB → <code>{state.rawPath}</code> (replay with{' '}
          <code>file://{state.rawPath}</code>)
        </p>
      ) : null}

      <label className="row tight" style={{ alignItems: 'center', fontSize: 12 }}>
        <input
          type="checkbox"
          checked={includeRaw}
          onChange={(e) => onIncludeRaw(e.target.checked)}
          style={{ width: 15, height: 15 }}
        />
        stream frame hex to the browser
      </label>
      <p className="hint">
        Off by default: at a 10 ms slot the hex is a few hundred KB/s that only the frame log reads.
      </p>

      <div className="row tight">
        <button
          disabled={!locFrames.length}
          onClick={() =>
            download(`mauwb-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, framesToCsv(locFrames))
          }
        >
          Export buffer ({locFrames.length})
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void guard(async () => {
              const r = await api.makeSample({ path: 'samples/demo.bin', tags: 3, seconds: 20 });
              setNote(`wrote ${r.frames} frames to ${r.path} — connect to file://${r.path}`);
            })
          }
          title="Generate a synthetic capture to replay without hardware"
        >
          Make sample
        </button>
      </div>

      {note ? <p className="hint">{note}</p> : null}
    </div>
  );
}
