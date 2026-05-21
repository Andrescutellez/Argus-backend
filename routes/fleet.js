'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { getFleet } = require('../controllers/fleetController');

const router = Router();

// Solo ADMIN y SUPER_ADMIN pueden ver la flota completa
router.get('/', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), getFleet);

module.exports = router;
