/**
 * @fileoverview Controladores REST para las salas de recuperación Argus Secure.
 *
 * ENDPOINTS:
 *   POST   /api/secure/rooms              → createRoom
 *   POST   /api/secure/rooms/:name/join   → joinRoom
 *   DELETE /api/secure/rooms/:name        → closeRoom
 *   GET    /api/secure/rooms              → listRooms
 *
 * PERMISOS:
 *   createRoom: USER (propietario activa la sala desde la app)
 *   joinRoom:   cualquier usuario autenticado (OWNER, ALLY, REACTION)
 *   closeRoom:  USER (propietario) | REACTION | ADMIN
 *   listRooms:  REACTION | ADMIN | SUPER_ADMIN
 *
 * @module controllers/secureRoomController
 */

'use strict';

const svc    = require('../services/secureRoomService');
const { getIo } = require('../services/socketService');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extrae el usuario del JWT de Argus (ya adjuntado por authenticate middleware).
 * @param {import('express').Request} req
 * @returns {{ userId: string, email: string, role: string }}
 */
function extractUser(req) {
  return {
    userId: req.user.sub || req.user.id || req.user.userId,
    email:  req.user.email ?? null,
    role:   req.user.role,
  };
}

/**
 * Wrapper para errores del servicio que incluyen statusCode.
 */
function handleServiceError(err, res) {
  const status = err.statusCode ?? 500;
  const msg    = err.message   ?? 'Error interno';
  console.error(`[SecureRoom] ${status} — ${msg}`);
  return res.status(status).json({ message: msg });
}

// ── Controladores ──────────────────────────────────────────────────────────────

/**
 * POST /api/secure/rooms
 * Body: { vehicleId, lastKnownPosition?: { lat, lng } }
 *
 * El propietario activa la sala al detectar un robo.
 */
const createRoom = async (req, res) => {
  const { vehicleId, lastKnownPosition } = req.body ?? {};

  if (!vehicleId) {
    return res.status(400).json({ message: 'vehicleId es requerido' });
  }

  try {
    const owner  = extractUser(req);
    const result = await svc.createRoom(vehicleId, owner, lastKnownPosition ?? null);

    // Notificar a agentes REACTION via socket.io
    const io = getIo();
    if (io) {
      io.to('reaction').emit('secure:room_opened', {
        roomName:  result.roomName,
        vehicleId,
        ownerId:   owner.userId,
        createdAt: new Date().toISOString(),
      });
    }

    return res.status(201).json(result);
  } catch (err) {
    return handleServiceError(err, res);
  }
};

/**
 * POST /api/secure/rooms/:roomName/join
 * Body: { role: 'OWNER' | 'REACTION_CENTER' | 'ALLY' | 'TRACKER' }
 *
 * Cualquier participante autorizado se une a la sala.
 */
const joinRoom = async (req, res) => {
  const { roomName } = req.params;
  const { role }     = req.body ?? {};

  if (!role) {
    return res.status(400).json({ message: 'role es requerido (OWNER, REACTION_CENTER, ALLY, TRACKER)' });
  }

  try {
    const user   = extractUser(req);
    const result = await svc.joinRoom(roomName, user, role);
    return res.status(200).json(result);
  } catch (err) {
    return handleServiceError(err, res);
  }
};

/**
 * DELETE /api/secure/rooms/:roomName
 * Body: { resolution?: 'RECOVERED' | 'NOT_FOUND' | 'FALSE_ALARM' }
 *
 * Cierra la sala y desconecta a todos los participantes.
 */
const closeRoom = async (req, res) => {
  const { roomName }              = req.params;
  const { resolution = 'RECOVERED' } = req.body ?? {};

  try {
    const user   = extractUser(req);
    const result = await svc.closeRoom(roomName, user.userId, resolution);

    // Notificar a todos los participantes via socket.io
    const io = getIo();
    if (io) {
      io.to('reaction').emit('secure:room_closed', {
        ...result,
        closedAt: new Date().toISOString(),
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return handleServiceError(err, res);
  }
};

/**
 * GET /api/secure/rooms
 * Lista las salas activas — solo para agentes REACTION y admins.
 */
const listRooms = async (req, res) => {
  try {
    const rooms = await svc.listActiveRooms();
    return res.status(200).json({ rooms, total: rooms.length });
  } catch (err) {
    return handleServiceError(err, res);
  }
};

module.exports = { createRoom, joinRoom, closeRoom, listRooms };
