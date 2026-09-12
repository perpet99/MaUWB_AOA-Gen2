/**
 * The single live link to an anchor.
 *
 * One process owns one transport, one `FrameStream` and one set of loggers;
 * every connected browser is a subscriber to the same decoded stream. That
 * mirrors the hardware -- a serial port cannot be opened twice -- and keeps
 * statistics, CSV rows and the UI in agreement.
 *
 * Decoded frames are flushed to subscribers on a timer rather than one message
 * per frame: four tags at a 10 ms slot is 400 frames/s, which is fine as four
 * batched messages but wasteful as 400 socket writes.
 */

import { EventEmitter } from 'node:events';

import {
  FrameStream,
  toWireFrame,
  type Frame,
  type SessionState,
  type WireFrame,
  type WireLocFrame,
} from '@mauwb/protocol';

import { CsvLogger, RawLogger } from './logging.js';
import { openTransport, type OpenOptions, type Transport } from './transport.js';

/** How often decoded frames are pushed to subscribers. */
const FLUSH_MS = 50;
/** Hard ceiling on one batch, so a fast replay cannot balloon memory. */
const MAX_BATCH = 2000;
/** Window used for the frames-per-second readout. */
const RATE_WINDOW_MS = 2000;

export interface SessionEvents {
  frames: (frames: WireFrame[]) => void;
  state: (state: SessionState) => void;
  notice: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ConnectOptions extends OpenOptions {
  verify?: boolean;
}

export class Session extends EventEmitter {
  private transport: Transport | null = null;
  private stream = new FrameStream();
  private pending: WireFrame[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private rateBuckets: { t: number; n: number }[] = [];

  private link: SessionState['link'] = 'closed';
  private spec: string | null = null;
  private baud = 115200;
  private transportName: string | null = null;
  private error: string | null = null;
  private openedAt: number | null = null;
  private includeRaw = false;

  private csv: CsvLogger | null = null;
  private raw: RawLogger | null = null;

  override on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof SessionEvents>(
    event: K,
    ...args: Parameters<SessionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /* ------------------------------------------------------------- state --- */

  get state(): SessionState {
    return {
      link: this.link,
      spec: this.spec,
      baud: this.baud,
      transport: this.transportName,
      error: this.error,
      openedAt: this.openedAt,
      stats: {
        frames: this.stream.stats.frames,
        badChecksum: this.stream.stats.badChecksum,
        resyncs: this.stream.stats.resyncs,
        droppedBytes: this.stream.stats.droppedBytes,
        bytesIn: this.stream.stats.bytesIn,
        locPerSec: this.locPerSec(),
      },
      csvPath: this.csv?.label ?? null,
      csvRows: this.csv?.rows ?? 0,
      rawPath: this.raw?.label ?? null,
      rawBytes: this.raw?.bytesWritten ?? 0,
      includeRaw: this.includeRaw,
    };
  }

  private locPerSec(): number {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    const recent = this.rateBuckets.filter((b) => b.t >= cutoff);
    if (!recent.length) return 0;
    const total = recent.reduce((acc, b) => acc + b.n, 0);
    return (total * 1000) / RATE_WINDOW_MS;
  }

  private publishState(): void {
    this.emit('state', this.state);
  }

  setIncludeRaw(value: boolean): void {
    this.includeRaw = value;
    this.publishState();
  }

  /* ---------------------------------------------------------- lifecycle --- */

  async connect(spec: string, opts: ConnectOptions = {}): Promise<void> {
    await this.disconnect();

    this.spec = spec;
    this.baud = opts.baud ?? 115200;
    this.error = null;
    this.link = 'opening';
    this.stream = new FrameStream({ verify: opts.verify ?? true });
    this.rateBuckets = [];
    this.publishState();

    let transport: Transport;
    try {
      transport = openTransport(spec, opts);
    } catch (err) {
      this.fail(err);
      throw err;
    }

    this.transportName = transport.name;
    transport.on('data', (chunk) => this.onData(chunk));
    transport.on('error', (err) => {
      this.error = err.message;
      this.link = 'error';
      this.emit('notice', 'error', `${transport.name}: ${err.message}`);
      this.publishState();
    });
    transport.on('eof', () => {
      if (this.link === 'open') {
        this.emit('notice', 'info', `${transport.name}: end of stream`);
        this.link = 'closed';
        this.publishState();
      }
    });

    try {
      await transport.open();
    } catch (err) {
      this.transportName = null;
      this.fail(err);
      throw err;
    }

    this.transport = transport;
    this.link = 'open';
    this.openedAt = Date.now();
    this.startFlushing();
    this.emit('notice', 'info', `opened ${transport.name}`);
    this.publishState();
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.link = 'error';
    this.publishState();
  }

  async disconnect(): Promise<void> {
    this.stopFlushing();
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      transport.removeAllListeners();
      await transport.close().catch(() => undefined);
    }
    await this.stopCsv();
    await this.stopRaw();
    this.pending = [];
    if (this.link !== 'error') {
      this.link = 'closed';
      this.transportName = null;
      this.openedAt = null;
      this.publishState();
    }
  }

  /** Write an already-built frame to the device. */
  async send(frame: Uint8Array): Promise<number> {
    if (!this.transport || this.link !== 'open') throw new Error('not connected');
    return this.transport.write(frame);
  }

  /* --------------------------------------------------------------- data --- */

  private onData(chunk: Uint8Array): void {
    this.raw?.write(chunk);

    let frames: Frame[];
    try {
      frames = this.stream.feed(chunk);
    } catch (err) {
      this.emit('notice', 'error', `decode failed: ${(err as Error).message}`);
      return;
    }
    if (!frames.length) return;

    const now = Date.now();
    let locs = 0;

    for (const f of frames) {
      // Config replies are rare and their bytes are what you debug with, so
      // they always carry hex; positioning frames only when asked.
      const withRaw = this.includeRaw || f.kind !== 'loc';
      const wire = toWireFrame(f, now, withRaw);
      if (wire.kind === 'loc') {
        locs++;
        this.csv?.write(wire as WireLocFrame);
      }
      this.pending.push(wire);
    }

    if (locs) this.rateBuckets.push({ t: now, n: locs });
    if (this.rateBuckets.length > 512) {
      this.rateBuckets = this.rateBuckets.filter((b) => b.t >= now - RATE_WINDOW_MS);
    }

    if (this.pending.length > MAX_BATCH) {
      this.pending = this.pending.slice(-MAX_BATCH);
    }
  }

  private startFlushing(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    // Do not hold the process open just to run the flush timer.
    this.flushTimer.unref?.();
  }

  private stopFlushing(): void {
    if (!this.flushTimer) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  private flush(): void {
    if (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      this.emit('frames', batch);
    }
    this.publishState();
  }

  /* ------------------------------------------------------------ logging --- */

  async startCsv(filePath: string): Promise<void> {
    await this.stopCsv();
    this.csv = await new CsvLogger(filePath).open();
    this.emit('notice', 'info', `logging CSV to ${this.csv.label}`);
    this.publishState();
  }

  async stopCsv(): Promise<number> {
    const csv = this.csv;
    this.csv = null;
    if (!csv) return 0;
    await csv.close();
    return csv.rows;
  }

  async startRaw(filePath: string): Promise<void> {
    await this.stopRaw();
    this.raw = await new RawLogger(filePath).open();
    this.emit('notice', 'info', `capturing raw bytes to ${this.raw.label}`);
    this.publishState();
  }

  async stopRaw(): Promise<number> {
    const raw = this.raw;
    this.raw = null;
    if (!raw) return 0;
    await raw.close();
    return raw.bytesWritten;
  }
}
