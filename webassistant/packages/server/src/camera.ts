import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Response } from 'express';

const DEVICE = process.env.CAMERA_DEVICE ?? '/dev/video0';
const WIDTH = process.env.CAMERA_WIDTH ?? '640';
const HEIGHT = process.env.CAMERA_HEIGHT ?? '480';
const FPS = process.env.CAMERA_FPS ?? '15';
const JPEG_QUALITY = process.env.CAMERA_JPEG_QUALITY ?? '6';
const BACKEND = process.env.CAMERA_BACKEND ?? 'rpicam';

const clients = new Set<Response>();
let ffmpeg: ChildProcessWithoutNullStreams | null = null;
let frameBuffer = Buffer.alloc(0);

function startCamera(): void {
  if (ffmpeg) return;

  const command = BACKEND === 'ffmpeg' ? 'ffmpeg' : 'rpicam-vid';
  const args =
    BACKEND === 'ffmpeg'
      ? [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'v4l2',
          '-video_size',
          `${WIDTH}x${HEIGHT}`,
          '-framerate',
          FPS,
          '-i',
          DEVICE,
          '-vf',
          'format=yuvj420p',
          '-f',
          'mjpeg',
          '-q:v',
          JPEG_QUALITY,
          'pipe:1',
        ]
      : [
          '--nopreview',
          '--codec',
          'mjpeg',
          '--width',
          WIDTH,
          '--height',
          HEIGHT,
          '--framerate',
          FPS,
          '--timeout',
          '0',
          '--output',
          '-',
        ];

  ffmpeg = spawn(command, args);

  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    publishFrames();
  });

  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    console.error(`[camera] ${chunk.toString().trim()}`);
  });

  ffmpeg.once('error', (error) => {
    console.error(`[camera] unable to start ffmpeg: ${error.message}`);
    ffmpeg = null;
    frameBuffer = Buffer.alloc(0);
  });

  ffmpeg.once('close', (code) => {
    if (code !== 0 && clients.size > 0) {
      console.error(`[camera] ffmpeg exited with code ${code ?? 'unknown'}`);
    }
    ffmpeg = null;
    frameBuffer = Buffer.alloc(0);
    if (clients.size > 0) setTimeout(startCamera, 500).unref();
  });
}

function publishFrames(): void {
  while (true) {
    const start = frameBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      frameBuffer = frameBuffer.subarray(Math.max(0, frameBuffer.length - 1));
      return;
    }

    const end = frameBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (start > 0) frameBuffer = frameBuffer.subarray(start);
      return;
    }

    const frame = frameBuffer.subarray(start, end + 2);
    frameBuffer = frameBuffer.subarray(end + 2);
    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    for (const client of clients) {
      if (!client.writableEnded) {
        client.write(header);
        client.write(frame);
        client.write('\r\n');
      }
    }
  }
}

export function streamCamera(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  startCamera();

  const close = () => {
    clients.delete(res);
    if (clients.size === 0 && ffmpeg) {
      ffmpeg.kill('SIGTERM');
      ffmpeg = null;
      frameBuffer = Buffer.alloc(0);
    }
  };
  res.on('close', close);
  res.on('error', close);
}

export function stopCamera(): void {
  for (const client of clients) client.end();
  clients.clear();
  ffmpeg?.kill('SIGTERM');
  ffmpeg = null;
  frameBuffer = Buffer.alloc(0);
}
