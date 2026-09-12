/**
 * CSV and raw-capture writers.
 *
 * `RawLogger` stores the untouched byte stream so a session can be replayed
 * later through `file://` exactly as it arrived. `CsvLogger` flattens decoded
 * positioning frames into one row per frame, using the column set shared with
 * the browser's CSV export.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CSV_COLUMNS, csvLine, locToCsvRow, type WireLocFrame } from '@mauwb/protocol';

import { displayPath, resolveDataPath } from './paths.js';

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(path.resolve(filePath));
  await mkdir(dir, { recursive: true });
}

/** One row per positioning frame. */
export class CsvLogger {
  rows = 0;
  private fh: WriteStream | null = null;

  readonly filePath: string;
  /** the path as the operator typed it, for display */
  readonly label: string;

  constructor(filePath: string) {
    this.filePath = resolveDataPath(filePath);
    this.label = displayPath(this.filePath);
  }

  async open(): Promise<this> {
    await ensureDir(this.filePath);
    this.fh = createWriteStream(this.filePath, { encoding: 'utf8' });
    this.fh.write(csvLine(CSV_COLUMNS) + '\r\n');
    return this;
  }

  write(f: WireLocFrame): void {
    if (!this.fh) throw new Error('logger not open');
    this.fh.write(csvLine(locToCsvRow(f)) + '\r\n');
    this.rows++;
  }

  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    if (!fh) return;
    await new Promise<void>((resolve) => fh.end(() => resolve()));
  }
}

/** Byte-for-byte capture, replayable via `file://`. */
export class RawLogger {
  bytesWritten = 0;
  private fh: WriteStream | null = null;

  readonly filePath: string;
  /** the path as the operator typed it, for display */
  readonly label: string;

  constructor(filePath: string) {
    this.filePath = resolveDataPath(filePath);
    this.label = displayPath(this.filePath);
  }

  async open(): Promise<this> {
    await ensureDir(this.filePath);
    this.fh = createWriteStream(this.filePath);
    return this;
  }

  write(data: Uint8Array): void {
    if (!this.fh) throw new Error('logger not open');
    this.fh.write(Buffer.from(data));
    this.bytesWritten += data.length;
  }

  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    if (!fh) return;
    await new Promise<void>((resolve) => fh.end(() => resolve()));
  }
}
