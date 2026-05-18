/**
 * @fileoverview Rutas REST para el recurso Alert del sistema Argus.
 *
 * PROPÓSITO:
 *   Definir los endpoints públicos del módulo de alertas y conectarlos
 *   con el controlador correspondiente.
 *
 * RUTAS:
 *   GET  /api/alerts/:deviceId        — historial de alertas de un device
 *   PATCH /api/alerts/:alertId/ack    — marcar alerta como atendida
 *
 * MONTAJE:
 *   Este router se monta en server.js bajo el prefijo /api/alerts:
 *     app.use('/api/alerts', alertRoutes)
 *   Por eso las rutas aquí usan '/:deviceId' y '/:alertId/ack', no '/api/alerts/...'.
 *
 * @module routes/alert
 */

'use strict';

const { Router } = require('express');
const { getAlerts, acknowledgeAlert } = require('../controllers/alertController');
const { authenticate, requireRole, canAccessDevice } = require('../middleware/auth');

const router = Router();

// GET /api/alerts/:deviceId — USER solo sus devices, ADMIN toda la flota
router.get('/:deviceId', authenticate, canAccessDevice, getAlerts);

// PATCH /api/alerts/:alertId/ack — solo operadores pueden marcar como atendida
router.patch('/:alertId/ack', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), acknowledgeAlert);

module.exports = router;
