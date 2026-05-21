/**
 * @fileoverview Controlador REST para suscripciones de usuario.
 * @module controllers/subscriptionController
 */

'use strict';

const Subscription = require('../models/Subscription');

/**
 * @brief Retorna la suscripción activa del usuario autenticado.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: { plan, status, starts_at, expires_at }
 */
const getMySubscription = async (req, res) => {
  try {
    const sub = await Subscription.getActiveSubscription(req.user.sub);
    if (!sub) return res.status(404).json({ message: 'Sin suscripción activa' });
    return res.status(200).json({
      plan:       sub.plan,
      status:     sub.status,
      starts_at:  sub.starts_at,
      expires_at: sub.expires_at,
    });
  } catch (err) {
    console.error('[SUBSCRIPTION] getMySubscription error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { getMySubscription };
