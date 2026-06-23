/**
 * @fileoverview Servicio de salas de recuperación: LiveKit + ciclo de vida.
 *
 * PROPÓSITO:
 *   Orquesta la creación, acceso y cierre de salas de recuperación.
 *   Abstrae la integración con LiveKit SFU y persiste el estado en MongoDB.
 *
 * TOKENS:
 *   Hay DOS tipos de tokens en este sistema — no confundir:
 *   1. LiveKit token  — firmado con LIVEKIT_API_SECRET, validado por el SFU.
 *                       Permite al cliente conectarse a la sala de voz.
 *   2. Geo-stream token — firmado con JWT_SECRET (el mismo de la API REST),
 *                         validado por geoStreamService.js.
 *                         Permite al cliente conectarse al WebSocket de GPS.
 *
 * MODO MOCK (sin LiveKit):
 *   Si LIVEKIT_API_KEY no está configurada, el servicio opera en modo mock
 *   (devuelve tokens de prueba y no llama al SFU real). Útil en desarrollo
 *   sin un servidor LiveKit levantado.
 *
 * @module services/secureRoomService
 */

'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const RecoveryRoom = require('../models/RecoveryRoom');

// ── Configuración LiveKit ──────────────────────────────────────────────────────

const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_HTTP_URL   = process.env.LIVEKIT_HTTP_URL || 'http://localhost:7880';
const MOCK_MODE          = !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET;

// El SDK de LiveKit se carga dinámicamente para que el servidor arranque
// aunque no esté instalado (útil si se ejecuta sin npm install reciente).
let RoomServiceClient, AccessToken, VideoGrants;

if (!MOCK_MODE) {
  try {
    const sdk = require('livekit-server-sdk');
    RoomServiceClient = sdk.RoomServiceClient;
    AccessToken       = sdk.AccessToken;
  } catch {
    console.warn('[SecureRoom] livekit-server-sdk no encontrado — activando modo mock.');
  }
}

const livekitSvc = !MOCK_MODE && RoomServiceClient
  ? new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

// ── Constantes ─────────────────────────────────────────────────────────────────

const ROOM_TTL_MS     = 2 * 60 * 60 * 1000;  // 2 horas
const TOKEN_TTL_SEC   = 60 * 60;              // 1 hora (el evento puede durar hasta 2h)
const MAX_PARTICIPANTS = 20;

/**
 * Permisos de LiveKit por rol.
 * canPublish: puede transmitir su micrófono.
 * canSubscribe: puede escuchar a otros.
 * canPublishData: puede enviar mensajes DataChannel (para PTT floor signal).
 */
const LIVEKIT_GRANTS = {
  OWNER:           { roomJoin: true, canPublish: true,  canSubscribe: true, canPublishData: true },
  REACTION_CENTER: { roomJoin: true, canPublish: true,  canSubscribe: true, canPublishData: true },
  ALLY:            { roomJoin: true, canPublish: true,  canSubscribe: true, canPublishData: true },
  TRACKER:         { roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false },
};

/**
 * Permisos para el geo-stream WebSocket por rol.
 * Estos se incluyen en el geo-token JWT.
 */
const GEO_PERMISSIONS = {
  OWNER:           { canPublishGps: true,  canViewMotoGps: true },
  REACTION_CENTER: { canPublishGps: false, canViewMotoGps: true },
  ALLY:            { canPublishGps: true,  canViewMotoGps: true },
  TRACKER:         { canPublishGps: true,  canViewMotoGps: false },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Genera el nombre de la sala en LiveKit.
 * SHA-256(vehicleId:timestamp)[:12] — nunca expone el vehicleId en claro.
 */
function buildRoomName(vehicleId) {
  const ts   = Date.now().toString();
  const hash = crypto.createHash('sha256').update(`${vehicleId}:${ts}`).digest('hex').slice(0, 12);
  return `room_${hash}_${ts}`;
}

/**
 * Genera un token LiveKit para un participante.
 * @param {string} userId
 * @param {string} roomName
 * @param {string} role
 * @returns {Promise<string>} JWT firmado con LIVEKIT_API_SECRET
 */
async function generateLivekitToken(userId, roomName, role) {
  if (MOCK_MODE || !AccessToken) {
    return `mock_livekit_${userId}_${role}_${Date.now()}`;
  }

  const grants = LIVEKIT_GRANTS[role] ?? LIVEKIT_GRANTS.ALLY;
  const at     = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl:      TOKEN_TTL_SEC,
  });
  at.addGrant({ ...grants, room: roomName });
  return await at.toJwt();
}

/**
 * Genera un token JWT (firmado con JWT_SECRET) para autenticarse en el
 * WebSocket de geo-stream.
 * @param {string} userId
 * @param {string} roomName
 * @param {string} role
 * @returns {string}
 */
function generateGeoToken(userId, roomName, role) {
  const permissions = GEO_PERMISSIONS[role] ?? GEO_PERMISSIONS.ALLY;
  return jwt.sign(
    { sub: userId, roomName, role, permissions },
    process.env.JWT_SECRET,
    { expiresIn: `${TOKEN_TTL_SEC}s`, algorithm: 'HS256', issuer: 'argus-secure', audience: 'argus-geo-stream' },
  );
}

// ── API pública del servicio ───────────────────────────────────────────────────

/**
 * Crea una sala de recuperación.
 *
 * FLUJO:
 *   1. Verificar que no hay sala ACTIVE para este vehicleId (evitar duplicados).
 *   2. Generar nombre hasheado para LiveKit.
 *   3. Crear sala en LiveKit SFU.
 *   4. Persistir en MongoDB.
 *   5. Generar tokens (LiveKit + Geo) para el OWNER.
 *   6. Retornar tokens y metadatos.
 *
 * @param {string} vehicleId
 * @param {{ userId: string, email: string, role: string }} owner
 * @param {{ lat: number, lng: number } | null} lastKnownPosition
 * @returns {Promise<object>}
 */
async function createRoom(vehicleId, owner, lastKnownPosition = null) {
  const existing = await RecoveryRoom.findOne({ vehicleId, status: 'ACTIVE' });
  if (existing) {
    throw Object.assign(new Error('Ya existe una sala activa para este vehículo'), { statusCode: 409 });
  }

  const roomName = buildRoomName(vehicleId);

  // Crear sala en LiveKit (si no estamos en modo mock)
  if (livekitSvc) {
    await livekitSvc.createRoom({
      name:            roomName,
      emptyTimeout:    3600,
      maxParticipants: MAX_PARTICIPANTS,
      metadata:        JSON.stringify({ vehicleId, ownerId: owner.userId, type: 'RECOVERY_ROOM' }),
    });
  } else {
    console.log(`[SecureRoom] MOCK — sala creada: ${roomName}`);
  }

  const expiresAt = new Date(Date.now() + ROOM_TTL_MS);

  const room = await RecoveryRoom.create({
    livekitRoomName:   roomName,
    vehicleId,
    ownerId:           owner.userId,
    lastKnownPosition: lastKnownPosition ?? {},
    expiresAt,
    participants: [{
      userId:    owner.userId,
      userEmail: owner.email ?? null,
      role:      'OWNER',
    }],
  });

  const [livekitToken, geoToken] = await Promise.all([
    generateLivekitToken(owner.userId, roomName, 'OWNER'),
    generateGeoToken(owner.userId, roomName, 'OWNER'),
  ]);

  const livekitUrl = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';
  const geoWsUrl   = process.env.GEO_STREAM_WS_URL || `ws://localhost:${process.env.PORT || 3000}/geo`;

  return {
    roomId:       room._id,
    roomName,
    livekitUrl,
    livekitToken,
    geoWsUrl,
    geoToken,
    expiresAt:    expiresAt.toISOString(),
    mockMode:     MOCK_MODE,
  };
}

/**
 * Genera tokens para que un participante se una a una sala existente.
 *
 * FLUJO:
 *   1. Buscar sala ACTIVE por roomName.
 *   2. Verificar que no expiró.
 *   3. Verificar límite de participantes.
 *   4. Registrar participante en MongoDB.
 *   5. Retornar tokens LiveKit + Geo.
 *
 * @param {string} roomName
 * @param {{ userId: string, email: string }} user
 * @param {string} role
 * @returns {Promise<object>}
 */
async function joinRoom(roomName, user, role) {
  if (!LIVEKIT_GRANTS[role]) {
    throw Object.assign(new Error(`Rol inválido: ${role}`), { statusCode: 400 });
  }

  const room = await RecoveryRoom.findOne({ livekitRoomName: roomName, status: 'ACTIVE' });
  if (!room) {
    throw Object.assign(new Error('Sala no encontrada o ya cerrada'), { statusCode: 404 });
  }

  if (new Date() > room.expiresAt) {
    await RecoveryRoom.findByIdAndUpdate(room._id, { status: 'EXPIRED', closedAt: new Date(), resolution: 'TIMEOUT' });
    throw Object.assign(new Error('La sala ha expirado'), { statusCode: 410 });
  }

  const alreadyIn = room.participants.find(p => p.userId === user.userId);
  if (!alreadyIn) {
    if (room.participants.length >= MAX_PARTICIPANTS) {
      throw Object.assign(new Error(`Sala llena (máx ${MAX_PARTICIPANTS} participantes)`), { statusCode: 409 });
    }
    room.participants.push({ userId: user.userId, userEmail: user.email ?? null, role });
    await room.save();
  }

  const [livekitToken, geoToken] = await Promise.all([
    generateLivekitToken(user.userId, roomName, role),
    generateGeoToken(user.userId, roomName, role),
  ]);

  return {
    roomName,
    role,
    livekitUrl:   process.env.LIVEKIT_WS_URL || 'ws://localhost:7880',
    livekitToken,
    geoWsUrl:     process.env.GEO_STREAM_WS_URL || `ws://localhost:${process.env.PORT || 3000}/geo`,
    geoToken,
    mockMode:     MOCK_MODE,
  };
}

/**
 * Cierra una sala de recuperación y desconecta a todos los participantes.
 *
 * @param {string} roomName
 * @param {string} closedBy  userId de quien cierra
 * @param {'RECOVERED'|'NOT_FOUND'|'FALSE_ALARM'} resolution
 * @returns {Promise<object>}
 */
async function closeRoom(roomName, closedBy, resolution = 'RECOVERED') {
  const room = await RecoveryRoom.findOne({ livekitRoomName: roomName, status: 'ACTIVE' });
  if (!room) {
    throw Object.assign(new Error('Sala no encontrada o ya cerrada'), { statusCode: 404 });
  }

  const validResolutions = ['RECOVERED', 'NOT_FOUND', 'FALSE_ALARM', 'TIMEOUT'];
  if (!validResolutions.includes(resolution)) {
    throw Object.assign(new Error(`Resolución inválida: ${resolution}`), { statusCode: 400 });
  }

  if (livekitSvc) {
    try {
      await livekitSvc.deleteRoom(roomName);
    } catch (err) {
      // Si la sala ya no existe en LiveKit (ej. expiró), no es error fatal.
      if (!err.message?.includes('not found')) throw err;
    }
  }

  room.status     = 'CLOSED';
  room.closedAt   = new Date();
  room.closedBy   = closedBy;
  room.resolution = resolution;
  await room.save();

  const durationMin = Math.round((room.closedAt - room.createdAt) / 60000);

  return {
    roomName,
    resolution,
    closedBy,
    durationMin,
    participants: room.participants.length,
  };
}

/**
 * Lista las salas activas con resumen para el panel de operador.
 * @returns {Promise<Array>}
 */
async function listActiveRooms() {
  const rooms = await RecoveryRoom.find({ status: 'ACTIVE' }).lean();
  const now   = new Date();

  return rooms
    .filter(r => now < r.expiresAt)
    .map(r => ({
      roomName:          r.livekitRoomName,
      vehicleId:         r.vehicleId,
      ownerId:           r.ownerId,
      participants:      r.participants.length,
      elapsedMin:        Math.round((now - new Date(r.createdAt)) / 60000),
      remainingMin:      Math.round((new Date(r.expiresAt) - now) / 60000),
      lastKnownPosition: r.lastKnownPosition,
      createdAt:         r.createdAt,
    }));
}

module.exports = {
  createRoom,
  joinRoom,
  closeRoom,
  listActiveRooms,
  generateGeoToken,
};
