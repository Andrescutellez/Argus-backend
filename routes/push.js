/**
 * @fileoverview Rutas Web Push (VAPID) — suscripción de browsers a notificaciones.
 *
 * PROPÓSITO:
 *   Permite que la web usuario registre su browser para recibir push notifications
 *   incluso cuando la pestaña no está abierta (background push via Service Worker).
 *
 *   Flujo:
 *   1. Frontend llama GET /api/push/vapid-public-key → obtiene la clave pública VAPID.
 *   2. Frontend registra un Service Worker y suscribe al Push Manager con esa clave.
 *   3. Frontend llama POST /api/push/subscribe con el objeto PushSubscription.
 *   4. Backend guarda la suscripción en users.web_push_subscription.
 *   5. Cuando hay una alarma, pushService.js usa web-push para enviar al endpoint.
 *
 * @module routes/push
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const { authenticate } = require('../middleware/auth');
const { saveWebPushSub } = require('../models/User');

/**
 * GET /api/push/vapid-public-key
 * Devuelve la clave pública VAPID necesaria para que el browser cree una suscripción.
 * No requiere autenticación — es información pública.
 */
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ message: 'Web push no configurado en este servidor' });
  res.json({ publicKey: key });
});

/**
 * POST /api/push/subscribe
 * Guarda o actualiza la suscripción push del browser del usuario autenticado.
 * Body: objeto PushSubscription serializado (endpoint, keys.auth, keys.p256dh).
 */
router.post('/subscribe', authenticate, async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) {
    return res.status(400).json({ message: 'Suscripción inválida: falta endpoint' });
  }
  try {
    await saveWebPushSub(req.user.sub, sub);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Push] Error guardando suscripción:', err.message);
    res.status(500).json({ message: 'Error interno' });
  }
});

module.exports = router;
