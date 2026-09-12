/**
 * Live session state: one WebSocket, per-tag rolling history, and the derived
 * numbers the views need.
 *
 * Tracks live in a ref, not in state. A batch of frames mutates the deques in
 * place and bumps a counter; React re-renders at the batch rate (20 Hz) instead
 * of rebuilding a few hundred arrays per second. That is the same trade the
 * matplotlib viewer makes by draining a queue inside the animation callback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ServerMessage, SessionState, WireFrame, WireLocFrame } from '@mauwb/protocol';

export interface TagTrack {
  addr: number;
  /** categorical colour slot, assigned in first-seen order */
  slot: number;
  xs: number[];
  ys: number[];
  angles: number[];
  ranges: number[];
  /** host clock of the newest frame, ms */
  last: number;
  frame: WireLocFrame | null;
  count: number;
}

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

const emptyState = (): SessionState => ({
  link: 'closed',
  spec: null,
  baud: 115200,
  transport: null,
  error: null,
  openedAt: null,
  stats: {
    frames: 0,
    badChecksum: 0,
    resyncs: 0,
    droppedBytes: 0,
    bytesIn: 0,
    locPerSec: 0,
  },
  csvPath: null,
  csvRows: 0,
  rawPath: null,
  rawBytes: 0,
  includeRaw: false,
});

export interface UseSessionOptions {
  /** samples kept per tag */
  trail?: number;
  /** lines kept in the frame log */
  logLines?: number;
  /** only track this tag short address */
  tagFilter?: number | null;
}

export function useSession(opts: UseSessionOptions = {}) {
  const trail = opts.trail ?? 120;
  const logLines = opts.logLines ?? 400;
  const tagFilter = opts.tagFilter ?? null;

  const [state, setState] = useState<SessionState>(emptyState);
  const [connected, setConnected] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [, bump] = useState(0);

  const tracksRef = useRef<Map<number, TagTrack>>(new Map());
  const nextSlot = useRef(0);
  const logRef = useRef<WireFrame[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const noticeId = useRef(0);

  // Keep the newest filter without making the socket effect depend on it.
  const filterRef = useRef<number | null>(tagFilter);
  filterRef.current = tagFilter;
  const trailRef = useRef(trail);
  trailRef.current = trail;

  const pushFrames = useCallback(
    (frames: WireFrame[]) => {
      const tracks = tracksRef.current;
      const keep = trailRef.current;
      const filter = filterRef.current;

      for (const f of frames) {
        logRef.current.push(f);

        if (f.kind !== 'loc') continue;
        if (filter !== null && f.tagAddr16 !== filter) continue;
        if (!f.xy) continue; // no anchor ranged, nothing to plot

        let t = tracks.get(f.tagAddr16);
        if (!t) {
          t = {
            addr: f.tagAddr16,
            slot: nextSlot.current++,
            xs: [],
            ys: [],
            angles: [],
            ranges: [],
            last: 0,
            frame: null,
            count: 0,
          };
          tracks.set(f.tagAddr16, t);
        }

        const primary = f.anchors.find((a) => a.valid);
        t.xs.push(f.xy.x);
        t.ys.push(f.xy.y);
        t.angles.push(primary ? primary.angleDeg : 0);
        t.ranges.push(primary ? primary.rangeCm / 100 : 0);
        if (t.xs.length > keep) {
          t.xs.shift();
          t.ys.shift();
          t.angles.shift();
          t.ranges.shift();
        }
        t.last = f.hostTime;
        t.frame = f;
        t.count++;
      }

      if (logRef.current.length > logLines) {
        logRef.current = logRef.current.slice(-logLines);
      }
      bump((n) => n + 1);
    },
    [logLines],
  );

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'hello':
          case 'state':
            setState(msg.state);
            break;
          case 'frames':
            pushFrames(msg.frames);
            break;
          case 'notice':
            setNotices((prev) =>
              [
                ...prev,
                { id: noticeId.current++, level: msg.level, message: msg.message, at: Date.now() },
              ].slice(-5),
            );
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!closed) retry = setTimeout(connect, 1000);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [pushFrames]);

  const setIncludeRaw = useCallback((value: boolean) => {
    wsRef.current?.send(JSON.stringify({ type: 'setIncludeRaw', value }));
  }, []);

  const clear = useCallback(() => {
    tracksRef.current.clear();
    nextSlot.current = 0;
    logRef.current = [];
    bump((n) => n + 1);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Recomputed every render rather than memoised: `bump` already re-renders on
  // each 20 Hz batch, and a memo keyed on mutable ref contents would be a lie.
  const tracks = Array.from(tracksRef.current.values());

  return {
    state,
    setState,
    connected,
    notices,
    dismissNotice,
    tracks,
    log: logRef.current,
    clear,
    setIncludeRaw,
  };
}

/** A track is stale once nothing has arrived for `timeoutMs`. */
export function isStale(t: TagTrack, now: number, timeoutMs = 2000): boolean {
  return now - t.last > timeoutMs;
}
