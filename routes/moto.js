/**
 * @fileoverview Rutas REST para gestión de motos.
 *
 * MONTAJE: app.use('/api/motos', motoRoutes)
 *
 * ENDPOINTS:
 *   POST   /api/motos                        — crear moto
 *   GET    /api/motos                        — listar motos del usuario
 *   GET    /api/motos/:motoId                — detalle de una moto + device instalado
 *   PUT    /api/motos/:motoId                — actualizar moto
 *   DELETE /api/motos/:motoId                — eliminar moto
 *   POST   /api/motos/:motoId/assign-device  — asignar device ESP32 a la moto
 *
 * @module routes/moto
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  createMoto, getMotos, getMoto,
  updateMoto, deleteMoto, assignDevice,
} = require('../controllers/motoController');

const router = Router();

// Todos los endpoints requieren estar autenticado
router.use(authenticate);

router.post('/',                      createMoto);
router.get('/',                       getMotos);
router.get('/:motoId',               getMoto);
router.put('/:motoId',               updateMoto);
router.delete('/:motoId',            requireRole('ADMIN', 'SUPER_ADMIN'), deleteMoto);
router.post('/:motoId/assign-device', assignDevice);

module.exports = router;
