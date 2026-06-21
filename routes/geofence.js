'use strict';

const { Router } = require('express');
const { authenticate, canAccessDevice } = require('../middleware/auth');
const { createGeofenceHandler, getGeofenceHandler, deleteGeofenceHandler } = require('../controllers/geofenceController');

const router = Router();

// Todas las rutas requieren JWT válido + acceso al device específico.
router.post(  '/:deviceId', authenticate, canAccessDevice, createGeofenceHandler);
router.get(   '/:deviceId', authenticate, canAccessDevice, getGeofenceHandler);
router.delete('/:deviceId', authenticate, canAccessDevice, deleteGeofenceHandler);

module.exports = router;
