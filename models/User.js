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

/**
 * @brief Retorna el userId dueño de un deviceId, o null si no está registrado.
 * @param {string} deviceId
 * @returns {Promise<string|null>} UUID del usuario o null.
 */
async function getDeviceOwner(deviceId) {
  const { rows } = await getPool().query(
    'SELECT user_id FROM user_devices WHERE device_id = $1 LIMIT 1',
    [deviceId],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * @brief Guarda o actualiza el token FCM de un usuario para push notifications.
 * @param {string} userId  UUID del usuario
 * @param {string} token   Token FCM del dispositivo
 */
async function saveFcmToken(userId, token) {
  await getPool().query(
    'UPDATE users SET fcm_token = $1 WHERE id = $2',
    [token, userId],
  );
}

/**
 * @brief Retorna el fcm_token del dueño de un deviceId, o null si no tiene.
 * @param {string} deviceId  p.ej. 'ARGUS-1237E630'
 * @returns {Promise<{email: string, fcm_token: string|null}|null>}
 */
async function getOwnerByDeviceId(deviceId) {
  const { rows } = await getPool().query(
    `SELECT u.email, u.fcm_token
     FROM users u
     JOIN user_devices ud ON ud.user_id = u.id
     WHERE ud.device_id = $1
     LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Retorna todos los usuarios con sus motos y dispositivos asignados.
 *        Usado por el endpoint /api/fleet del web operador.
 * @returns {Promise<Array<{ userId, email, plan, motos }>>}
 */
async function getAllUsersWithDevices() {
  const { rows } = await getPool().query(`
    SELECT
      u.id          AS user_id,
      u.email,
      COALESCE(s.plan, 'FREEMIUM') AS plan,
      m.id          AS moto_id,
      m.alias,
      m.placa,
      m.marca,
      m.modelo,
      m.color,
      m.anio,
      d.device_id
    FROM users u
    LEFT JOIN subscriptions s
           ON s.user_id = u.id AND s.status = 'ACTIVE'
    LEFT JOIN motos m ON m.user_id = u.id
    LEFT JOIN devices d ON d.moto_id = m.id
    ORDER BY u.email, m.created_at NULLS LAST
  `);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) {
      map.set(row.user_id, { userId: row.user_id, email: row.email, plan: row.plan, motos: [] });
    }
    if (row.moto_id) {
      map.get(row.user_id).motos.push({
        id: row.moto_id,
        alias: row.alias,
        placa: row.placa,
        marca: row.marca,
        modelo: row.modelo,
        color: row.color,
        anio: row.anio,
        deviceId: row.device_id ?? null,
      });
    }
  }
  return Array.from(map.values());
}

/**
 * @brief Retorna todos los usuarios con un rol específico.
 *        Usado para listar agentes de reacción en el panel de super admin.
 * @param {string} role  p.ej. 'REACTION'
 * @returns {Promise<Array<{ id, email, role, created_at }>>}
 */
async function findAllByRole(role) {
  const { rows } = await getPool().query(
    'SELECT id, email, role, created_at FROM users WHERE role = $1 ORDER BY created_at DESC',
    [role],
  );
  return rows;
}

/**
 * @brief Guarda o actualiza la suscripción Web Push (VAPID) del browser del usuario.
 * @param {string} userId  UUID
 * @param {object} sub     PushSubscription serializado (endpoint + keys)
 */
async function saveWebPushSub(userId, sub) {
  await getPool().query(
    'UPDATE users SET web_push_subscription = $1 WHERE id = $2',
    [JSON.stringify(sub), userId],
  );
}

/**
 * @brief Retorna fcm_token y web_push_subscription del dueño de un deviceId.
 * Necesario para enviar push a móvil (FCM) y a browser (VAPID) al mismo tiempo.
 * @param {string} deviceId
 * @returns {Promise<{email:string, fcm_token:string|null, web_push_subscription:object|null}|null>}
 */
async function getOwnerPushDataByDeviceId(deviceId) {
  const { rows } = await getPool().query(
    `SELECT u.email, u.fcm_token, u.web_push_subscription
     FROM users u
     JOIN user_devices ud ON ud.user_id = u.id
     WHERE ud.device_id = $1
     LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

module.exports = { findByEmail, findById, createUser, addDevice, getDevices, getDeviceOwner, getAllUsersWithDevices, findAllByRole, saveFcmToken, getOwnerByDeviceId, saveWebPushSub, getOwnerPushDataByDeviceId };
