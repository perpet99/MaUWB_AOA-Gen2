/**
 * Transport picker. Accepts the same specs as the pyassistant CLI:
 * a serial port, tcp://host:port, or file://capture.bin.
 */

import { useEffect, useState } from 'react';

import type { SerialPortInfo, SessionState } from '@mauwb/protocol';

import { api } from '../api';

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface Props {
  state: SessionState;
  wsConnected: boolean;
  onError: (message: string) => void;
  onClear: () => void;
}

export function ConnectionBar({ state, wsConnected, onError, onClear }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [spec, setSpec] = useState('file://samples/demo.bin');
  const [baud, setBaud] = useState(115200);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [busy, setBusy] = useState(false);

  const isFile = spec.startsWith('file://');
  const open = state.link === 'open' || state.link === 'opening';

  const refreshPorts = async () => {
    try {
      const { ports: found } = await api.ports();
      setPorts(found);
      if (found.length && spec.startsWith('file://')) setSpec(found[0]!.path);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  useEffect(() => {
    void api
      .ports()
      .then(({ ports: found }) => setPorts(found))
      .catch(() => undefined);
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      onClear();
      await api.connect({ spec, baud, speed: isFile ? speed : undefined, loop: isFile ? loop : undefined });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnect();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="topbar">
      <div className="brand">
        MaUWB AOA
        <small>web assistant</small>
      </div>

      <label className="field grow">
        source
        <input
          className="mono"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          disabled={open}
          placeholder="COM7 | tcp://host:port | file://cap.bin"
          list="known-ports"
        />
        <datalist id="known-ports">
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.friendlyName ?? p.manufacturer ?? ''}
            </option>
          ))}
        </datalist>
      </label>

      {!isFile && (
        <label className="field">
          baud
          <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} disabled={open}>
            {BAUDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      )}

      {isFile && (
        <>
          <label className="field">
            speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={open}>
              <option value={1}>1x (wire rate)</option>
              <option value={2}>2x</option>
              <option value={5}>5x</option>
              <option value={0}>max</option>
            </select>
          </label>
          <label className="field">
            loop
            <input
              type="checkbox"
              checked={loop}
              onChange={(e) => setLoop(e.target.checked)}
              disabled={open}
              style={{ width: 16, height: 16 }}
            />
          </label>
        </>
      )}

      <button onClick={() => void refreshPorts()} disabled={open} className="ghost" title="Rescan serial ports">
        ports ({ports.length})
      </button>

      {open ? (
        <button className="danger" onClick={() => void disconnect()} disabled={busy}>
          Disconnect
        </button>
      ) : (
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          Connect
        </button>
      )}

      <div className="spacer" />

      <span className="panel-sub" title={state.transport ?? ''}>
        <span className={`dot ${state.link}`} /> {state.link}
        {state.transport ? ` · ${state.transport}` : ''}
        {!wsConnected ? ' · socket down' : ''}
      </span>
    </div>
  );
}
