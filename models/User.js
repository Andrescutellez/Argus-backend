/**
 * @fileoverview Funciones de acceso a datos para la tabla users y user_devices.
 *
 * PROPÓSITO:
 *   Abstrae todas las queries SQL de usuarios detrás de funciones nombradas.
 *   No usa ORM — queries directas con pg.Pool para máximo control y mínima
 *   complejidad (sin migraciones, sin modelos declarativos).
 *
 * PATRÓN:
 *   Cada función recibe los datos que necesita, ejecuta UN query SQL, y retorna
 *   el resultado limpio. El controlador nunca ve SQL directamente.
 *
 * @module models/User
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Busca un usuario por email (para login).
 * @param {string} email
 * @returns {Promise<object|null>} Fila de la tabla users, o null si no existe.
 */
async function findByEmail(email) {
  const { rows } = await getPool().query(
    'SELECT * FROM users WHERE email = $1',
    [email],
  );
  return rows[0] ?? null;
}

/**
 * @brief Busca un usuario por ID (para el middleware de autenticación).
 * @param {string} id  UUID
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await getPool().query(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * @brief Crea un nuevo usuario.
 * @param {{ email: string, passwordHash: string, role?: string }} data
 * @returns {Promise<object>} Fila creada (sin password_hash).
 */
async function createUser({ email, passwordHash, role = 'USER' }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, email, role, created_at`,
    [email, passwordHash, role],
  );
  return rows[0];
}

/**
 * @brief Asocia un deviceId a un usuario.
 *
 * Usa ON CONFLICT DO NOTHING para que sea idempotente: si ya existe el par
 * (user_id, device_id), no falla.
 *
 * @param {string} userId  UUID
 * @param {string} deviceId  p.ej. 'ARGUS-1237E630'
 * @returns {Promise<void>}
 */
async function addDevice(userId, deviceId) {
  await getPool().query(
    `INSERT INTO user_devices (user_id, device_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, deviceId],
  );
}

/**
 * @brief Retorna los deviceIds asociados a un usuario.
 * @param {string} userId  UUID
 * @returns {Promise<string[]>} Array de deviceIds.
 */
async function getDevices(userId) {
  const { rows } = await getPool().query(
    'SELECT device_id FROM user_devices WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.device_id);
}

module.exports = { findByEmail, findById, createUser, addDevice, getDevices };
