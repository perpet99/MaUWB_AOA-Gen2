/** Thin REST client. Every call returns parsed JSON or throws the server's message. */

import type {
  CommandSpec,
  ConnectRequest,
  SendResponse,
  SerialPortInfo,
  SessionState,
  WireFrame,
} from '@mauwb/protocol';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  ports: () => request<{ ports: SerialPortInfo[] }>('/api/ports'),

  status: () => request<{ state: SessionState }>('/api/status'),

  connect: (req: ConnectRequest) => post<{ state: SessionState }>('/api/connect', req),

  disconnect: () => post<{ state: SessionState }>('/api/disconnect'),

  send: (req: {
    target: 'anchor' | 'tag' | 'robot';
    command: string;
    saddr?: string;
    daddr?: string;
    dryRun?: boolean;
  }) => post<SendResponse>('/api/send', req),

  decode: (hex: string, verify = true) =>
    post<{ frame: WireFrame }>('/api/decode', { hex, verify }),

  commands: () =>
    request<{
      catalog: CommandSpec[];
      reportFormats: Record<string, string>;
      robotModes: Record<string, string>;
    }>('/api/commands'),

  startCsv: (path: string) => post<{ state: SessionState }>('/api/log/csv', { path }),
  stopCsv: () => post<{ rows: number; state: SessionState }>('/api/log/csv', { enable: false }),

  startRaw: (path: string) => post<{ state: SessionState }>('/api/log/raw', { path }),
  stopRaw: () => post<{ bytes: number; state: SessionState }>('/api/log/raw', { enable: false }),

  makeSample: (opts: { path?: string; tags?: number; seconds?: number; rssi?: boolean }) =>
    post<{ path: string; frames: number }>('/api/sample', opts),
};
