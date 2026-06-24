/**
 * @fileoverview Rutas REST para configuración global del sistema.
 *
 * ENDPOINTS:
 *   GET /api/settings/nearby-alert  → leer radio de alertas a moteros cercanos
 *   PUT /api/settings/nearby-alert  → actualizar radio (solo ADMIN+)
 *
 * @module routes/settings
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { getNearbySetting, setNearbySetting } = require('../controllers/settingsController');

const router = Router();

// Lectura disponible para operadores (necesitan ver la configuración actual)
router.get(
  '/nearby-alert',
  authenticate,
  requireRole('REACTION', 'ADMIN', 'SUPER_ADMIN'),
  getNearbySetting,
);

// Escritura solo para administradores
router.put(
  '/nearby-alert',
  authenticate,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  setNearbySetting,
);

module.exports = router;
