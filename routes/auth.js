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
const { saveFcmToken } = require('../models/User');

const router = Router();

router.post('/register', register);
router.post('/login',    login);
router.get('/me',        authenticate, me);

// Gestión de agentes de reacción — solo SUPER_ADMIN
router.post('/agents', authenticate, requireRole('SUPER_ADMIN'), createAgent);
router.get('/agents',  authenticate, requireRole('SUPER_ADMIN'), listAgents);

/**
 * POST /api/auth/fcm-token
 * Guarda o actualiza el token FCM del usuario autenticado.
 * La app Flutter llama esto al arrancar para que el backend sepa a dónde enviar push.
 * Body: { token: string }
 */
router.post('/fcm-token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token requerido' });
  }
  try {
    await saveFcmToken(req.user.id, token);
    console.log(`[Push] token guardado userId=${req.user.id} token=${token.slice(0, 20)}...`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
