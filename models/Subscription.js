/**
 * @fileoverview Funciones de acceso a datos para la tabla subscriptions.
 *
 * PROPÓSITO:
 *   Gestiona el plan (FREEMIUM/PREMIUM) de cada usuario. Un usuario tiene una
 *   suscripción activa a la vez; las anteriores quedan como historial.
 *
 * INVARIANTE: nunca se borran filas — solo se cambia status a EXPIRED/CANCELLED.
 *   Esto permite auditar el historial completo de planes de un usuario.
 *
 * @module models/Subscription
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Crea una suscripción FREEMIUM para un usuario recién registrado.
 *        Se llama desde authController.register() al crear la cuenta.
 * @param {string} userId  UUID
 * @param {'FREEMIUM'|'PREMIUM'} plan
 * @returns {Promise<object>} Fila creada.
 */
async function createSubscription(userId, plan = 'FREEMIUM') {
  const { rows } = await getPool().query(
    `INSERT INTO subscriptions (user_id, plan)
     VALUES ($1, $2)
     RETURNING *`,
    [userId, plan],
  );
  return rows[0];
}

/**
 * @brief Retorna la suscripción activa de un usuario.
 * @param {string} userId  UUID
 * @returns {Promise<object|null>}
 */
async function getActiveSubscription(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Sube el plan de un usuario a PREMIUM.
 *        Expira la suscripción activa anterior y crea una nueva PREMIUM.
 * @param {string} userId  UUID
 * @param {Date|null} expiresAt  Fecha de vencimiento. null = sin vencimiento.
 * @returns {Promise<object>} Nueva suscripción PREMIUM.
 */
async function upgradeToPremium(userId, expiresAt = null) {
  const pool = getPool();

  await pool.query(
    `UPDATE subscriptions SET status = 'EXPIRED'
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId],
  );

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, plan, expires_at)
     VALUES ($1, 'PREMIUM', $2)
     RETURNING *`,
    [userId, expiresAt],
  );
  return rows[0];
}

/**
 * @brief Cancela la suscripción activa de un usuario.
 * @param {string} userId  UUID
 * @returns {Promise<void>}
 */
async function cancelSubscription(userId) {
  await getPool().query(
    `UPDATE subscriptions SET status = 'CANCELLED'
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
}

module.exports = { createSubscription, getActiveSubscription, upgradeToPremium, cancelSubscription };
