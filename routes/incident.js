/**
 * @fileoverview Rutas REST para incidentes de seguridad comunitaria.
 *
 * PERMISOS:
 *   POST   /              → USER (dueño reporta robo) | ADMIN
 *   GET    /active        → REACTION | ADMIN | SUPER_ADMIN
 *   POST   /:id/sighting  → cualquier usuario autenticado
 *   POST   /:id/pursue    → cualquier usuario autenticado
 *   DELETE /:id/pursue    → cualquier usuario autenticado
 *   PATCH  /:id/resolve   → USER dueño | ADMIN | SUPER_ADMIN
 *
 * @module routes/incident
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  createIncident,
  getActiveIncidents,
  addSighting,
  joinPursuit,
  leavePursuit,
  resolveIncident,
} = require('../controllers/incidentController');

const router = Router();

// Reportar robo — el dueño desde la app, o un admin desde el operador
router.post(
  '/',
  authenticate,
  requireRole('USER', 'ADMIN', 'SUPER_ADMIN'),
  createIncident,
);

// Consultar incidentes activos — agentes de reacción + admins
router.get(
  '/active',
  authenticate,
  requireRole('REACTION', 'ADMIN', 'SUPER_ADMIN'),
  getActiveIncidents,
);

// Reportar avistamiento — cualquier usuario autenticado
router.post('/:id/sighting', authenticate, addSighting);

// Unirse a persecución
router.post('/:id/pursue', authenticate, joinPursuit);

// Salir de persecución
router.delete('/:id/pursue', authenticate, leavePursuit);

// Cerrar incidente
router.patch(
  '/:id/resolve',
  authenticate,
  requireRole('USER', 'REACTION', 'ADMIN', 'SUPER_ADMIN'),
  resolveIncident,
);

module.exports = router;
