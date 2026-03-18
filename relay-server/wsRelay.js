// ============================================================
//  wsRelay.js — WebSocket Relay Server
//
//  Serves dashboard files from ../dashboard_ip/
//  Upgrades /ws/telemetry to WebSocket.
//  Forwards frames IMMEDIATELY when dataRouter receives them —
//  no push timer, zero additional latency.
//  Falls back to a 5s heartbeat timer when no real source is
//  live, so the browser stays connected during offline/mock mode.
// ============================================================

import http                from 'http';
import fs                  from 'fs';
import path                from 'path';
import { fileURLToPath }   from 'url';
import { WebSocketServer } from 'ws';
import { config }          from './config.js';
import { getBestFrame, getSourceStatus, onFrame } from './dataRouter.js';

// ── Dashboard directory ───────────────────────────────────────────────────
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, '..', 'dashboard_ip');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json',
  '.md':   'text/plain; charset=utf-8',
};

// ── State ─────────────────────────────────────────────────────────────────
let _wss           = null;
let _httpServer    = null;
let _heartbeatTimer = null;
let _stats         = { pushed: 0, clients: 0, errors: 0, startMs: Date.now() };

// ── Broadcast to all open clients ─────────────────────────────────────────
function _broadcast(data, source) {
  if (!_wss || _wss.clients.size === 0) return;

  const payload = JSON.stringify({
    ...data,
    _relay: { source, server_ts: Date.now() },
  });

  for (const client of _wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
        _stats.pushed++;
      } catch (err) {
        _stats.errors++;
        console.error('[wsRelay] send error:', err.message);
      }
    }
  }
}

// ── HTTP handler — static files + /status ─────────────────────────────────
function _httpHandler(req, res) {
  // ── GET /api/telemetry — HTTP fallback for telemetryPoller ─────────────
  // telemetryPoller.js falls back to HTTP polling on WS failure.
  // Return the best available frame so the dashboard stays alive during reconnect.
  if (req.method === 'GET' && req.url.startsWith('/api/telemetry')) {
    const frame = getBestFrame();
    if (!frame) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no data available' }));
      return;
    }
    const body = JSON.stringify({
      ...frame.data,
      _relay: { source: frame.source, server_ts: Date.now() },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    const body = JSON.stringify({
      server:   'SGS Relay Server',
      uptime_s: Math.floor((Date.now() - _stats.startMs) / 1000),
      clients:  _wss ? _wss.clients.size : 0,
      pushed:   _stats.pushed,
      errors:   _stats.errors,
      sources:  getSourceStatus(),
    }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(DASHBOARD_DIR, urlPath));
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404: ${urlPath}`);
      return;
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── Public API ────────────────────────────────────────────────────────────

export function start() {
  if (_httpServer) return;

  _httpServer = http.createServer(_httpHandler);

  _wss = new WebSocketServer({ server: _httpServer, path: '/ws/telemetry' });

  _wss.on('connection', (ws, req) => {
    console.info(`[wsRelay] client connected (total: ${_wss.clients.size})`);

    // Send latest frame immediately on connect — no blank wait
    const frame = getBestFrame();
    if (frame) {
      try {
        ws.send(JSON.stringify({
          ...frame.data,
          _relay: { source: frame.source, server_ts: Date.now() },
        }));
      } catch (_) {}
    }

    ws.on('message', (msg) => {
      try {
        const obj = JSON.parse(msg.toString('utf8'));
        if (obj?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      console.info(`[wsRelay] client disconnected (remaining: ${_wss.clients.size})`);
    });

    ws.on('error', (err) => {
      _stats.errors++;
      console.error('[wsRelay] client error:', err.message);
    });
  });

  _wss.on('error', (err) => {
    _stats.errors++;
    console.error('[wsRelay] server error:', err.message);
  });

  // Register immediate-forward callback with dataRouter
  // Every frame that arrives from ESP32/MQTT is instantly broadcast
  onFrame((data, source) => {
    _broadcast(data, source);
  });

  // Heartbeat timer — only used in mock/offline mode to keep
  // the browser connection alive when no real source is pushing
  _heartbeatTimer = setInterval(() => {
    if (!_wss || _wss.clients.size === 0) return;
    const frame = getBestFrame();
    if (frame && frame.source === 'mock') {
      _broadcast(frame.data, frame.source);
    }
  }, 500);

  _httpServer.listen(config.server.port, config.server.host, () => {
    console.info(`[wsRelay] listening  ws://localhost:${config.server.port}/ws/telemetry`);
    console.info(`[wsRelay] dashboard  http://localhost:${config.server.port}`);
  });
}

export function stop() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_wss) {
    for (const c of _wss.clients) { try { c.close(1001, 'shutdown'); } catch (_) {} }
    _wss.close();
    _wss = null;
  }
  if (_httpServer) {
    _httpServer.close(() => console.info('[wsRelay] stopped'));
    _httpServer = null;
  }
}

export function getStats() {
  return { ..._stats, clients: _wss ? _wss.clients.size : 0 };
}