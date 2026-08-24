export function buildSandboxTunnelClientSource(): string {
  return String.raw`import fs from 'node:fs';
import net from 'node:net';

const configPath = process.argv[2];
if (!configPath) throw new Error('tunnel config path is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (typeof config.url !== 'string' || typeof config.token !== 'string') {
  throw new Error('invalid tunnel config');
}

const allowedPorts = new Set([60000, 60001, 12000, 12001]);
const streams = new Map();
let control;
let reconnectTimer;
let pingTimer;
let shuttingDown = false;

function send(frame) {
  if (control && control.readyState === 1) {
    control.send(JSON.stringify(frame));
  }
}

function dropStream(streamId, notify) {
  const socket = streams.get(streamId);
  if (!socket) return;
  streams.delete(streamId);
  socket.destroy();
  if (notify) send({ type: 'close', streamId });
}

function dropAllStreams() {
  for (const streamId of [...streams.keys()]) dropStream(streamId, false);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 1000);
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'ready' || frame.type === 'pong') return;

  if (frame.type === 'open') {
    if (typeof frame.streamId !== 'string' || !allowedPorts.has(frame.port)) {
      send({ type: 'error', streamId: String(frame.streamId || ''), message: 'unsupported port' });
      return;
    }

    dropStream(frame.streamId, false);
    const socket = net.createConnection({ host: '127.0.0.1', port: frame.port });
    streams.set(frame.streamId, socket);

    socket.on('data', (chunk) => {
      send({ type: 'data', streamId: frame.streamId, data: chunk.toString('base64') });
    });
    socket.on('error', (error) => {
      if (streams.get(frame.streamId) !== socket) return;
      streams.delete(frame.streamId);
      send({ type: 'error', streamId: frame.streamId, message: error.message });
      socket.destroy();
    });
    socket.on('close', () => {
      if (streams.get(frame.streamId) !== socket) return;
      streams.delete(frame.streamId);
      send({ type: 'close', streamId: frame.streamId });
    });
    return;
  }

  if (frame.type === 'data' && typeof frame.streamId === 'string' && typeof frame.data === 'string') {
    const socket = streams.get(frame.streamId);
    if (socket) socket.write(Buffer.from(frame.data, 'base64'));
    return;
  }

  if ((frame.type === 'close' || frame.type === 'error') && typeof frame.streamId === 'string') {
    dropStream(frame.streamId, false);
  }
}

function connect() {
  if (shuttingDown) return;
  const ws = new WebSocket(config.url);
  control = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: config.token }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 30000);
  });

  ws.addEventListener('message', (event) => {
    try {
      handleFrame(JSON.parse(String(event.data)));
    } catch {
      // Invalid control frames are ignored; the gateway remains the authority.
    }
  });

  ws.addEventListener('close', () => {
    if (control === ws) control = undefined;
    clearInterval(pingTimer);
    pingTimer = undefined;
    dropAllStreams();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // A close event follows and owns reconnect/cleanup.
  });
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  dropAllStreams();
  if (control && control.readyState < 2) control.close();
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
connect();
`;
}
