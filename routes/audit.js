/**
 * @fileoverview Rutas REST para consulta del audit log.
 *
 * MONTAJE: app.use('/api/audit', auditRoutes)
 *
 * ENDPOINTS:
 *   GET /api/audit — listar entradas del log (solo ADMIN/SUPER_ADMIN)
 *     Query params: userId, action, targetId, limit
 *
 * @module routes/audit
 */

'use strict';

const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { getLogs } = require('../controllers/auditController');

const router = Router();

router.get('/', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), getLogs);

module.exports = router;
