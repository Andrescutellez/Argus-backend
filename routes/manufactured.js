/**
 * @fileoverview Rutas REST para el catálogo de devices manufacturados.
 *
 * PROPÓSITO:
 *   Expone los endpoints de gestión del inventario de MACs autorizadas.
 *   La lectura requiere rol ADMIN o superior.
 *   Las escrituras (add / remove) requieren SUPER_ADMIN.
 *
 * @module routes/manufactured
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { addDevice, listDevices, removeDevice, patchDevice } = require('../controllers/manufacturedDeviceController');

const router = Router();

// GET /api/manufactured — inventario completo (ADMIN+)
router.get('/',
  authenticate,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  listDevices,
);

// POST /api/manufactured — pre-registrar un device (SUPER_ADMIN)
router.post('/',
  authenticate,
  requireRole('SUPER_ADMIN'),
  addDevice,
);

// PATCH /api/manufactured/:deviceId — editar protocolo de un device (SUPER_ADMIN)
router.patch('/:deviceId',
  authenticate,
  requireRole('SUPER_ADMIN'),
  patchDevice,
);

// DELETE /api/manufactured/:deviceId — revocar un device (SUPER_ADMIN)
router.delete('/:deviceId',
  authenticate,
  requireRole('SUPER_ADMIN'),
  removeDevice,
);

module.exports = router;
