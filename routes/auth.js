/**
 * @fileoverview Rutas REST de autenticación del sistema Argus.
 *
 * RUTAS:
 *   POST /api/auth/register  — crear cuenta nueva (email + password + deviceId opcional)
 *   POST /api/auth/login     — autenticar y recibir JWT
 *   GET  /api/auth/me        — perfil del usuario autenticado (requiere Bearer token)
 *
 * MONTAJE:
 *   app.use('/api/auth', authRoutes) en server.js
 *
 * @module routes/auth
 */

'use strict';

const { Router } = require('express');
const { register, login, me, createAgent, listAgents } = require('../controllers/authController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.post('/register', register);
router.post('/login',    login);
router.get('/me',        authenticate, me);

// Gestión de agentes de reacción — solo SUPER_ADMIN
router.post('/agents', authenticate, requireRole('SUPER_ADMIN'), createAgent);
router.get('/agents',  authenticate, requireRole('SUPER_ADMIN'), listAgents);

module.exports = router;
