/**
 * @fileoverview Rutas REST para la Sala de Recuperación (Argus Secure).
 *
 * PERMISOS:
 *   POST   /              → USER — propietario abre la sala al detectar robo
 *   GET    /              → REACTION | ADMIN | SUPER_ADMIN — panel de operador
 *   POST   /:name/join    → cualquier usuario autenticado — obtener tokens para unirse
 *   DELETE /:name         → USER | REACTION | ADMIN — cerrar sala
 *
 * @module routes/secureRoom
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { createRoom, joinRoom, closeRoom, listRooms } = require('../controllers/secureRoomController');

const router = Router();

// El propietario crea la sala al activar el modo de persecución
router.post(
  '/',
  authenticate,
  requireRole('USER', 'ADMIN', 'SUPER_ADMIN'),
  createRoom,
);

// Panel de operador REACTION: ver todas las salas activas
router.get(
  '/',
  authenticate,
  requireRole('REACTION', 'ADMIN', 'SUPER_ADMIN'),
  listRooms,
);

// Cualquier participante (ALLY, REACTION_CENTER, TRACKER) obtiene tokens para unirse
router.post(
  '/:roomName/join',
  authenticate,
  joinRoom,
);

// Cerrar sala — propietario, agente REACTION o admin
router.delete(
  '/:roomName',
  authenticate,
  requireRole('USER', 'REACTION', 'ADMIN', 'SUPER_ADMIN'),
  closeRoom,
);

module.exports = router;
