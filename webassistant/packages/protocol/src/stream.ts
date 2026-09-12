/**
 * Byte-stream framing: pull complete frames out of a noisy serial stream.
 *
 * A UART stream gives no frame boundaries, and you will routinely join it
 * mid-frame or lose bytes. `FrameStream` therefore never trusts a 0x2A byte on
 * its own -- it validates length, foot and checksum together, and on any failure
 * it slides forward by one byte and looks for the next candidate head. That
 * makes resynchronisation automatic and bounded.
 */

import { ENVELOPE_EXTRA, FOOT, HEAD, parseFrame, xorCrc, type Frame } from './protocol.js';

/** Smallest legal cmd_len: saddr(8) + daddr(8) + cmd_type(1) + cmd_direct(1) */
export const MIN_CMD_LEN = 18;
/** Sanity ceiling so a corrupt length field cannot make us buffer forever. */
export const MAX_CMD_LEN = 4096;
/** Bytes we need before a length field can even be read. */
const MIN_HEADER = 3;

export interface StreamStats {
  /** frames handed out */
  frames: number;
  /** head+length+foot lined up but checksum did not */
  badChecksum: number;
  /** times we discarded a byte to hunt a new head */
  resyncs: number;
  /** total bytes thrown away by resync */
  droppedBytes: number;
  /** total bytes fed in */
  bytesIn: number;
}

export function emptyStats(): StreamStats {
  return { frames: 0, badChecksum: 0, resyncs: 0, droppedBytes: 0, bytesIn: 0 };
}

export function formatStats(s: StreamStats): string {
  return `frames=${s.frames} bad_crc=${s.badChecksum} resyncs=${s.resyncs} dropped=${s.droppedBytes}B`;
}

export interface FrameStreamOptions {
  verify?: boolean;
  maxBuffer?: number;
}

/**
 * Incremental frame extractor.
 *
 * Feed it whatever the transport returns; it yields complete, checksum-valid
 * frames:
 *
 *     const stream = new FrameStream();
 *     for (const frame of stream.feed(chunk)) handle(frame);
 */
export class FrameStream {
  readonly stats: StreamStats = emptyStats();

  private buf: Uint8Array;
  private len = 0;
  private readonly verify: boolean;
  private readonly maxBuffer: number;

  constructor(opts: FrameStreamOptions = {}) {
    this.verify = opts.verify ?? true;
    this.maxBuffer = opts.maxBuffer ?? 1 << 16;
    this.buf = new Uint8Array(4096);
  }

  get buffered(): number {
    return this.len;
  }

  reset(): void {
    this.len = 0;
  }

  /** Append `data` and return every complete frame now available. */
  feed(data: Uint8Array): Frame[] {
    if (data.length) {
      this.stats.bytesIn += data.length;
      this.append(data);
      if (this.len > this.maxBuffer) {
        // Runaway garbage: keep only the tail so we can still resync.
        const excess = this.len - this.maxBuffer;
        this.stats.droppedBytes += excess;
        this.consume(excess);
      }
    }
    return this.drain();
  }

  private append(data: Uint8Array): void {
    if (this.len + data.length > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + data.length) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** Drop the first `n` bytes of the working buffer. */
  private consume(n: number): void {
    if (n <= 0) return;
    if (n >= this.len) {
      this.len = 0;
      return;
    }
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }

  private indexOfHead(from: number): number {
    for (let i = from; i < this.len; i++) if (this.buf[i] === HEAD) return i;
    return -1;
  }

  /**
   * Drop one byte and jump to the next plausible head.
   * Returns true if a candidate head remains in the buffer.
   */
  private resync(): boolean {
    this.stats.resyncs++;
    this.consume(1);
    this.stats.droppedBytes += 1;
    const idx = this.indexOfHead(0);
    if (idx < 0) {
      this.stats.droppedBytes += this.len;
      this.len = 0;
      return false;
    }
    if (idx > 0) {
      this.stats.droppedBytes += idx;
      this.consume(idx);
    }
    return true;
  }

  private drain(): Frame[] {
    const out: Frame[] = [];
    for (;;) {
      // 1. Align on a head byte.
      if (this.len === 0) return out;
      if (this.buf[0] !== HEAD) {
        const idx = this.indexOfHead(0);
        if (idx < 0) {
          this.stats.droppedBytes += this.len;
          this.len = 0;
          return out;
        }
        this.stats.droppedBytes += idx;
        this.consume(idx);
      }

      // 2. Need the length field.
      if (this.len < MIN_HEADER) return out;

      const cmdLen = this.buf[1]! | (this.buf[2]! << 8);
      if (cmdLen < MIN_CMD_LEN || cmdLen > MAX_CMD_LEN) {
        if (!this.resync()) return out;
        continue;
      }

      const total = cmdLen + ENVELOPE_EXTRA;

      // 3. Need the whole frame. Not an error -- just wait for more bytes.
      if (this.len < total) return out;

      const candidate = this.buf.slice(0, total);

      // 4. Foot must land where the length field says.
      if (candidate[total - 1] !== FOOT) {
        if (!this.resync()) return out;
        continue;
      }

      // 5. Checksum.
      if (this.verify && candidate[3 + cmdLen] !== xorCrc(candidate, 3, cmdLen)) {
        this.stats.badChecksum++;
        if (!this.resync()) return out;
        continue;
      }

      let frame: Frame;
      try {
        frame = parseFrame(candidate, false);
      } catch {
        if (!this.resync()) return out;
        continue;
      }

      this.consume(total);
      this.stats.frames++;
      out.push(frame);
    }
  }
}

/** Convenience: pull every frame out of an in-memory blob (e.g. a log file). */
export function iterFrames(data: Uint8Array, verify = true): Frame[] {
  return new FrameStream({ verify }).feed(data);
}
