const net = require('net');
const { log } = require('./logger');
const { isAllowed, verifySignature } = require('./deviceAuth');
const { enqueue } = require('./queue');

const TCP_PORT = parseInt(process.env.TCP_PORT || '80', 10);
const INACTIVITY_TIMEOUT_MS = 60_000;
const RATE_LIMIT_MS = 5_000;

// Map<deviceId, socket>
const connectedDevices = new Map();
// Map<deviceId, string[]>  — pending commands to push on next ACK
const commandQueues = new Map();
// Map<deviceId, number>  — epoch ms of last accepted packet
const lastSeen = new Map();

// Format: ARGUS|device_id|timestamp|lat|lng|signature
function parsePacket(line) {
  const parts = line.trim().split('|');
  if (parts.length !== 6 || parts[0] !== 'ARGUS') return null;
  const [, deviceId, timestamp, lat, lng, signature] = parts;
  if (!deviceId || !timestamp || !lat || !lng || !signature) return null;
  return { deviceId, timestamp, lat: parseFloat(lat), lng: parseFloat(lng), signature };
}

function flushCommands(socket, deviceId) {
  const q = commandQueues.get(deviceId);
  if (!q || q.length === 0) return;
  const cmd = q.shift();
  socket.write(`CMD|${cmd}\n`);
  log('info', 'tcp.cmd.sent', { deviceId, cmd });
}

function createTcpServer(io) {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log('info', 'tcp.connect', { remote });

    socket.setTimeout(INACTIVITY_TIMEOUT_MS);
      socket.setKeepAlive && socket.setKeepAlive(true, 30000);

    let buffer = '';
    let deviceId = null; // set after first successful auth
      let failedAuthAttempts = 0;
      const MAX_FAILED_AUTH = 3;

    socket.on('data', (chunk) => {
      // Log raw incoming bytes and UTF-8 interpretation for debugging
      try {
        log('debug', 'tcp.raw', { remote, rawHex: chunk.toString('hex'), rawUtf8: chunk.toString('utf8') });
      } catch (e) {
        // ignore logging failures
      }

      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // retain incomplete trailing line

      for (const line of lines) {
        if (!line || !line.trim()) continue;

        const packet = parsePacket(line);
        if (!packet) {
          log('warn', 'tcp.packet.malformed', { remote, raw: line.slice(0, 100) });
          socket.write('ERR\r\n');
          continue;
        }

        // --- Device auth ---
        if (!isAllowed(packet.deviceId)) {
          log('warn', 'tcp.auth.unknown_device', { deviceId: packet.deviceId, remote });
          failedAuthAttempts += 1;
          socket.write('ERR\r\n');
          if (failedAuthAttempts >= MAX_FAILED_AUTH) {
            log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
            socket.destroy();
            return;
          }
          continue;
        }

        if (!verifySignature(packet.deviceId, packet.timestamp, packet.lat, packet.lng, packet.signature)) {
          log('warn', 'tcp.auth.bad_signature', { deviceId: packet.deviceId, remote });
          failedAuthAttempts += 1;
          socket.write('ERR\r\n');
          if (failedAuthAttempts >= MAX_FAILED_AUTH) {
            log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
            socket.destroy();
            return;
          }
          continue;
        }

        // --- Rate limit ---
        const now = Date.now();
        const last = lastSeen.get(packet.deviceId) || 0;
        if (now - last < RATE_LIMIT_MS) {
          log('warn', 'tcp.ratelimit', { deviceId: packet.deviceId, msSinceLast: now - last });
          socket.write('ERR\n');
          continue;
        }
        lastSeen.set(packet.deviceId, now);

        // --- Register device on first valid packet ---
        if (deviceId !== packet.deviceId) {
          deviceId = packet.deviceId;
          connectedDevices.set(deviceId, socket);
          if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
          log('info', 'tcp.auth.ok', { deviceId, remote });
        }

        // --- Validate coordinates ---
        const { lat, lng } = packet;
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          log('warn', 'tcp.packet.invalid_coords', { deviceId, lat, lng });
          socket.write('ERR\r\n');
          continue;
        }

        // --- Non-blocking DB write via queue ---
        enqueue({
          deviceId,
          lat,
          lon: lng,
          timestamp: new Date(Number(packet.timestamp) || now),
        });

        // --- Real-time push to connected app clients ---
        if (io) {
          io.emit('gps:update', {
            deviceId,
            lat,
            lon: lng,
            speed: 0,
            timestamp: new Date(Number(packet.timestamp) || now).toISOString(),
          });
        }

        socket.write('ACK\r\n');
        log('info', 'tcp.packet.accepted', { deviceId, lat, lng });

        flushCommands(socket, deviceId);
      }
    });

    socket.on('timeout', () => {
      log('warn', 'tcp.timeout', { remote, deviceId });
      socket.destroy();
    });

    socket.on('close', () => {
      if (deviceId) connectedDevices.delete(deviceId);
      log('info', 'tcp.disconnect', { remote, deviceId });
    });

    socket.on('error', (err) => {
      // 'close' fires after 'error'; cleanup happens there
      log('error', 'tcp.socket.error', { remote, message: err.message });
    });
  });

  server.on('error', (err) => {
    log('error', 'tcp.server.error', { message: err.message });
  });

  return server;
}

// Push a command to a device. Returns false if device is unknown.
function sendCommand(deviceId, action) {
  if (!commandQueues.has(deviceId)) return false;
  commandQueues.get(deviceId).push(action);
  // Deliver immediately if the socket is live
  const socket = connectedDevices.get(deviceId);
  if (socket && !socket.destroyed) flushCommands(socket, deviceId);
  return true;
}

function startTcpServer(io) {
  const server = createTcpServer(io);
  server.listen(TCP_PORT, '0.0.0.0', () => {
    log('info', 'tcp.server.start', { port: TCP_PORT });
  });
  return server;
}

module.exports = { startTcpServer, sendCommand, connectedDevices };
