/**
 * Transports: where the byte stream comes from.
 *
 * Three sources are supported behind one small interface, so every part of the
 * server works identically against live hardware, a TCP bridge, or a recorded
 * log:
 *
 *   SerialTransport -- a USB/UART anchor (the normal case)
 *   TcpTransport    -- an anchor reached over a serial-to-Ethernet bridge
 *   FileTransport   -- replay of a `.bin` capture, optionally in real time
 *
 * Node's serial and socket APIs are push-based, so unlike the Python original
 * these emit `data` rather than offering a blocking `read`.
 */

import { EventEmitter } from 'node:events';
import { createReadStream, type ReadStream } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import type { SerialPortInfo } from '@mauwb/protocol';

import { displayPath, resolveDataPath } from './paths.js';

export interface TransportEvents {
  data: (chunk: Uint8Array) => void;
  /** no more data will ever arrive (finite sources only) */
  eof: () => void;
  error: (err: Error) => void;
}

export abstract class Transport extends EventEmitter {
  abstract readonly name: string;

  abstract open(): Promise<void>;
  abstract close(): Promise<void>;

  /** Returns the number of bytes written. Read-only transports return 0. */
  write(_data: Uint8Array): Promise<number> {
    return Promise.resolve(0);
  }

  override on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * A serialport-backed UART link.
 *
 * The anchors enumerate as a CP210x/CH340-class USB-UART. 115200 8N1 is the
 * factory default; MaUWB_Assistant also offers 921600 for high slot rates.
 *
 * `serialport` is a native module and is declared optional, so it is imported
 * lazily: the rest of the server (TCP, replay) still works without it.
 */
export class SerialTransport extends Transport {
  readonly name: string;
  private port: import('serialport').SerialPort | null = null;

  constructor(
    readonly path: string,
    readonly baudRate = 115200,
  ) {
    super();
    this.name = `serial:${path}@${baudRate}`;
  }

  async open(): Promise<void> {
    const { SerialPort } = await loadSerialPort();
    const port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });

    // Some USB-UART bridges hold the device in reset until these are set.
    await new Promise<void>((resolve) => {
      port.set({ dtr: true, rts: false }, () => resolve());
    });

    port.on('data', (buf: Buffer) => this.emit('data', new Uint8Array(buf)));
    port.on('error', (err: Error) => this.emit('error', err));
    port.on('close', () => this.emit('eof'));

    this.port = port;
  }

  override async write(data: Uint8Array): Promise<number> {
    const port = this.port;
    if (!port) throw new Error('port not open');
    await new Promise<void>((resolve, reject) => {
      port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      port.drain((err) => (err ? reject(err) : resolve()));
    });
    return data.length;
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = null;
    if (!port || !port.isOpen) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }
}

/** Anchor behind a serial-to-Ethernet bridge (transparent TCP). */
export class TcpTransport extends Transport {
  readonly name: string;
  private sock: net.Socket | null = null;

  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super();
    this.name = `tcp:${host}:${port}`;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const onFail = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onFail);
      sock.setTimeout(5000, () => onFail(new Error('connect timed out')));
      sock.once('connect', () => {
        sock.setTimeout(0);
        sock.off('error', onFail);
        sock.on('data', (buf: Buffer) => this.emit('data', new Uint8Array(buf)));
        sock.on('error', (err: Error) => this.emit('error', err));
        sock.on('close', () => this.emit('eof'));
        this.sock = sock;
        resolve();
      });
    });
  }

  override write(data: Uint8Array): Promise<number> {
    const sock = this.sock;
    if (!sock) throw new Error('socket not open');
    return new Promise((resolve, reject) => {
      sock.write(Buffer.from(data), (err) => (err ? reject(err) : resolve(data.length)));
    });
  }

  async close(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    await new Promise<void>((resolve) => sock.end(() => resolve()));
    sock.destroy();
  }
}

/**
 * Replay a raw capture.
 *
 * `speed` scales playback: 1.0 approximates the original wire rate by pacing on
 * chunk/baud, 0 replays as fast as the event loop allows.
 */
export class FileTransport extends Transport {
  readonly name: string;
  private stopped = false;
  private stream: ReadStream | null = null;

  readonly path: string;

  constructor(
    filePath: string,
    readonly opts: { chunk?: number; speed?: number; baudRate?: number; loop?: boolean } = {},
  ) {
    super();
    this.path = resolveDataPath(filePath);
    this.name = `file:${displayPath(this.path)}`;
  }

  async open(): Promise<void> {
    // Fail fast on a missing file rather than inside the pump.
    const fh = await fsOpen(this.path, 'r');
    await fh.close();
    this.stopped = false;
    void this.pump();
  }

  private async pump(): Promise<void> {
    const chunk = this.opts.chunk ?? 256;
    const speed = this.opts.speed ?? 1.0;
    const baud = this.opts.baudRate ?? 115200;

    do {
      const stream = createReadStream(this.path, { highWaterMark: chunk });
      this.stream = stream;
      try {
        for await (const buf of stream as AsyncIterable<Buffer>) {
          if (this.stopped) return;
          this.emit('data', new Uint8Array(buf));
          if (speed > 0) {
            // 10 bits per byte on the wire (8N1 + start + stop).
            await sleep((buf.length * 10 * 1000) / baud / speed);
          } else {
            // Yield so a fast replay cannot starve the socket writes.
            await sleep(0);
          }
        }
      } catch (err) {
        if (!this.stopped) this.emit('error', err as Error);
        return;
      }
    } while (this.opts.loop && !this.stopped);

    if (!this.stopped) this.emit('eof');
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.stream?.destroy();
    this.stream = null;
  }
}

async function loadSerialPort(): Promise<typeof import('serialport')> {
  try {
    return await import('serialport');
  } catch (err) {
    throw new Error(
      'serialport is not installed (it is an optional native dependency). ' +
        'Run "npm install serialport -w @mauwb/server", or use a tcp:// or file:// source.',
    );
  }
}

/** Return every serial port present, or [] when serialport is unavailable. */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const { SerialPort } = await loadSerialPort();
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      friendlyName: (p as { friendlyName?: string }).friendlyName,
    }));
  } catch {
    return [];
  }
}

export interface OpenOptions {
  baud?: number;
  /** file:// replay only */
  speed?: number;
  loop?: boolean;
}

/**
 * Build a transport from a URL-ish string.
 *
 *   COM7 / /dev/ttyUSB0        serial port
 *   tcp://192.168.1.50:8888    serial-to-Ethernet bridge
 *   file://capture.bin         replay a raw capture
 */
export function openTransport(spec: string, opts: OpenOptions = {}): Transport {
  const baud = opts.baud ?? 115200;

  if (spec.startsWith('tcp://')) {
    const rest = spec.slice('tcp://'.length);
    const idx = rest.lastIndexOf(':');
    if (idx <= 0) throw new Error('tcp:// spec needs host:port');
    const host = rest.slice(0, idx);
    const port = Number(rest.slice(idx + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`bad tcp port: ${rest.slice(idx + 1)}`);
    }
    return new TcpTransport(host, port);
  }

  if (spec.startsWith('file://')) {
    return new FileTransport(spec.slice('file://'.length), {
      speed: opts.speed ?? 1.0,
      baudRate: baud,
      loop: opts.loop ?? false,
    });
  }

  return new SerialTransport(spec, baud);
}
