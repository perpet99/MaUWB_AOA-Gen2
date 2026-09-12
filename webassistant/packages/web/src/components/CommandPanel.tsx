/**
 * Config command sender.
 *
 * The catalogue comes from the server (which reads it from @mauwb/protocol),
 * so the picker always matches the documented command sets rather than a
 * hard-coded copy. Dry run builds the frame and shows the bytes without
 * touching the link -- the safe way to check an argument list before a
 * `setcfg` that would reconfigure a working anchor.
 */

import { useEffect, useState } from 'react';

import type { CommandSpec, SessionState } from '@mauwb/protocol';

import { api } from '../api';

type Target = 'anchor' | 'tag' | 'robot';

interface Props {
  state: SessionState;
  onError: (message: string) => void;
}

export function CommandPanel({ state, onError }: Props) {
  const [catalog, setCatalog] = useState<CommandSpec[]>([]);
  const [target, setTarget] = useState<Target>('anchor');
  const [command, setCommand] = useState('getcfg');
  const [args, setArgs] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .commands()
      .then(({ catalog: c }) => setCatalog(c))
      .catch((err: Error) => onError(err.message));
  }, [onError]);

  const forTarget = catalog.filter((c) => c.target === target);
  const spec = forTarget.find((c) => c.command === command) ?? null;
  const full = args.trim() ? `${command} ${args.trim()}` : command;
  const connected = state.link === 'open';

  const pick = (cmd: string) => {
    setCommand(cmd);
    const found = forTarget.find((c) => c.command === cmd);
    setArgs(found?.args ?? '');
    setResult(null);
  };

  const switchTarget = (t: Target) => {
    setTarget(t);
    const first = catalog.find((c) => c.target === t);
    if (first) {
      setCommand(first.command);
      setArgs(first.args ?? '');
    }
    setResult(null);
  };

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.send({ target, command: full, dryRun });
      setResult(`${res.sent ? 'sent' : 'dry run'} · ${res.bytes} bytes\n${res.hex}`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row tight">
        {(['anchor', 'tag', 'robot'] as Target[]).map((t) => (
          <button
            key={t}
            className={target === t ? 'primary' : 'ghost'}
            onClick={() => switchTarget(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <label className="field">
        command
        <select value={command} onChange={(e) => pick(e.target.value)}>
          {forTarget.map((c) => (
            <option key={c.command} value={c.command}>
              {c.command} — {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        arguments
        <input
          className="mono"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder={spec?.args ?? '(none)'}
        />
      </label>

      <div className="panel-sub" style={{ wordBreak: 'break-all' }}>
        → {full}
      </div>

      {spec?.writes ? (
        <div className="warnbox">
          This command writes to the device. Dry run first if you are not certain of the arguments —
          <code> setcfg</code> with the wrong 7th argument switches the report format and the binary
          stream stops.
        </div>
      ) : null}

      <div className="row tight">
        <button onClick={() => void run(true)} disabled={busy}>
          Dry run
        </button>
        <button className="primary" onClick={() => void run(false)} disabled={busy || !connected}>
          Send
        </button>
      </div>

      {!connected ? <p className="hint">Connect a source to enable Send.</p> : null}

      {result ? (
        <pre
          className="log"
          style={{ maxHeight: 120, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}
        >
          {result}
        </pre>
      ) : null}
    </div>
  );
}
