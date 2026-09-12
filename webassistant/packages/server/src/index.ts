/**
 * Server entry point: REST for control, WebSocket for telemetry, static files
 * for the built UI.
 *
 *     npm run dev     # this, plus the Vite dev server on :5173
 *     npm run build && npm start   # single process on :8787
 */

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '@mauwb/protocol';

import { createApi } from './api.js';
import { Session } from './session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
/** Where `npm run build -w @mauwb/web` puts the bundle. */
const WEB_DIST = path.resolve(HERE, '../../web/dist');

const session = new Session();
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use('/api', createApi(session));

// Serve the built UI when it exists; in dev, Vite serves it on its own port and
// proxies /api and /ws back here.
app.use(express.static(WEB_DIST, { index: 'index.html' }));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
    if (err) {
      res
        .status(404)
        .type('text/plain')
        .send('UI bundle not built. Run "npm run build -w @mauwb/web", or use "npm run dev".');
    }
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, { type: 'hello', state: session.state, protocolVersion: 1 });

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'setIncludeRaw':
        session.setIncludeRaw(Boolean(msg.value));
        break;
      case 'ping':
        send(ws, { type: 'state', state: session.state });
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

session.on('frames', (frames) => broadcast({ type: 'frames', frames }));
session.on('state', (state) => broadcast({ type: 'state', state }));
session.on('notice', (level, message) => {
  broadcast({ type: 'notice', level, message });
  const line = `[${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
});

server.listen(PORT, HOST, () => {
  console.log(`MaUWB webassistant listening on http://${HOST}:${PORT}`);
  console.log(`  REST  http://${HOST}:${PORT}/api/status`);
  console.log(`  WS    ws://${HOST}:${PORT}/ws`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} -- closing link`);
  await session.disconnect().catch(() => undefined);
  for (const ws of clients) ws.close();
  server.close(() => process.exit(0));
  // Do not hang on a stuck socket.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
