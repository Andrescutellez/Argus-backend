/**
 * @fileoverview Servicio WebSocket de geolocalización en tiempo real.
 *
 * PROPÓSITO:
 *   Recibe posiciones GPS de trackers (ESP32 o app) y las rebroadcastea
 *   a todos los participantes de la misma sala de recuperación.
 *   Se monta sobre el httpServer existente en la ruta /geo, compartiendo
 *   el mismo puerto que la API REST (no requiere puerto adicional).
 *
 * PROTOCOLO DE MENSAJES (cliente → servidor):
 *   1. Autenticación (primer mensaje obligatorio):
 *      { type: "auth", token: "<geo-token JWT>" }
 *   2. Actualización GPS (solo TRACKER):
 *      { type: "gps", lat, lng, accuracy?, timestamp? }
 *
 * PROTOCOLO DE MENSAJES (servidor → cliente):
 *   - { type: "auth_ok", userId, role, roomName }
 *   - { type: "last_position", lat, lng, accuracy, timestamp, receivedAt }
 *   - { type: "gps_update", vehicleId, lat, lng, accuracy, timestamp, receivedAt }
 *   - { type: "error", code, message }
 *
 * INTEGRACIÓN:
 *   Llamar initGeoStream(httpServer) desde server.js después de crear el httpServer.
 *   Los clientes se conectan a ws://<host>/geo (mismo host que la API REST).
 *
 * @module services/geoStreamService
 */

'use strict';

const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');

// ── Estado en memoria ──────────────────────────────────────────────────────────

/**
 * Última posición conocida por sala.
 * Clave: roomName (livekitRoomName)
 * Valor: { vehicleId, lat, lng, accuracy, timestamp, receivedAt }
 *
 * En producción con múltiples instancias Node.js: migrar a Redis Pub/Sub.
 */
const lastKnownPositions = new Map();

/**
 * Suscriptores por sala.
 * Clave: roomName
 * Valor: Set<WebSocket>
 */
const roomSubscribers = new Map();

/**
 * Metadata del socket autenticado.
 * Clave: WebSocket
 * Valor: { userId, role, roomName, permissions }
 */
const socketMeta = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendJSON(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function subscribeToRoom(ws, roomName) {
  if (!roomSubscribers.has(roomName)) roomSubscribers.set(roomName, new Set());
  roomSubscribers.get(roomName).add(ws);
}

function unsubscribeFromAll(ws) {
  for (const [roomName, subs] of roomSubscribers) {
    subs.delete(ws);
    if (subs.size === 0) roomSubscribers.delete(roomName);
  }
  socketMeta.delete(ws);
}

function broadcastGps(senderWs, roomName, data) {
  const subs = roomSubscribers.get(roomName);
  if (!subs) return;
  for (const ws of subs) {
    if (ws !== senderWs) sendJSON(ws, data);
  }
}

function validateGeoToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer:     'argus-secure',
    audience:   'argus-geo-stream',
  });
}

// ── Inicialización ─────────────────────────────────────────────────────────────

/**
 * Monta el servidor WebSocket de geo-stream sobre el httpServer existente.
 * Los clientes se conectan a ws://<host>/geo
 *
 * @param {import('http').Server} httpServer  El mismo servidor HTTP de Express
 */
function initGeoStream(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  // Interceptar el handshake de upgrade solo para la ruta /geo
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/geo') return;  // dejar que socket.io maneje el resto

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;

    const authTimeout = setTimeout(() => {
      if (!socketMeta.has(ws)) {
        sendJSON(ws, { type: 'error', code: 'AUTH_TIMEOUT', message: 'Autenticar en 10s' });
        ws.close(1008, 'Auth timeout');
      }
    }, 10_000);

    ws.on('message', (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        sendJSON(ws, { type: 'error', code: 'INVALID_JSON', message: 'Mensaje debe ser JSON' });
        return;
      }

      const { type } = msg;

      // ── Autenticación ───────────────────────────────────────────────────────
      if (type === 'auth') {
        clearTimeout(authTimeout);

        if (!msg.token) {
          sendJSON(ws, { type: 'error', code: 'NO_TOKEN', message: 'Token requerido' });
          ws.close(1008, 'No token');
          return;
        }

        let payload;
        try {
          payload = validateGeoToken(msg.token);
        } catch (err) {
          sendJSON(ws, { type: 'error', code: 'INVALID_TOKEN', message: err.message });
          ws.close(1008, 'Invalid token');
          return;
        }

        const meta = {
          userId:      payload.sub,
          role:        payload.role,
          roomName:    payload.roomName,
          permissions: payload.permissions,
        };
        socketMeta.set(ws, meta);
        subscribeToRoom(ws, payload.roomName);

        sendJSON(ws, { type: 'auth_ok', userId: meta.userId, role: meta.role, roomName: meta.roomName });

        // Enviar última posición si existe (para quien se une tarde)
        const lastPos = lastKnownPositions.get(meta.roomName);
        if (lastPos) sendJSON(ws, { type: 'last_position', ...lastPos });

        return;
      }

      // ── Verificar autenticación para cualquier otro mensaje ─────────────────
      const meta = socketMeta.get(ws);
      if (!meta) {
        sendJSON(ws, { type: 'error', code: 'NOT_AUTHENTICATED', message: 'Autenticar primero' });
        return;
      }

      // ── Actualización GPS ────────────────────────────────────────────────────
      if (type === 'gps') {
        if (!meta.permissions?.canPublishGps) {
          sendJSON(ws, { type: 'error', code: 'FORBIDDEN', message: `El rol '${meta.role}' no puede publicar GPS` });
          return;
        }

        const { lat, lng, accuracy, timestamp } = msg;
        if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          sendJSON(ws, { type: 'error', code: 'INVALID_COORDS', message: 'lat y lng requeridos y en rango' });
          return;
        }

        const gpsData = {
          type:       'gps_update',
          roomName:   meta.roomName,
          vehicleId:  meta.userId,
          lat,
          lng,
          accuracy:   accuracy ?? null,
          timestamp:  timestamp ?? new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        };

        lastKnownPositions.set(meta.roomName, gpsData);
        broadcastGps(ws, meta.roomName, gpsData);
        return;
      }

      sendJSON(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `Tipo desconocido: ${type}` });
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      unsubscribeFromAll(ws);
    });

    ws.on('error', () => {
      unsubscribeFromAll(ws);
    });
  });

  console.log('[GeoStream] WebSocket montado en ws://<host>/geo');
  return wss;
}

/**
 * Elimina la última posición conocida de una sala al cerrarla.
 * Llamar desde secureRoomService.closeRoom().
 * @param {string} roomName
 */
function clearRoomData(roomName) {
  lastKnownPositions.delete(roomName);
  roomSubscribers.delete(roomName);
}

module.exports = { initGeoStream, clearRoomData, lastKnownPositions };
