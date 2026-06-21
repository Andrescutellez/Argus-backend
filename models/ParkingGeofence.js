/**
 * @fileoverview Modelo PostgreSQL para geocercas de estacionamiento.
 *
 * PROPÓSITO:
 *   Persistir geocercas creadas por el usuario al armar en modo "parqueadero".
 *   Solo puede haber una geocerca activa por device a la vez.
 *   El backend evalúa cada GPS frame contra la geocerca activa; si la moto
 *   sale del radio (2 puntos consecutivos), dispara la alarma completa.
 *
 * @module models/ParkingGeofence
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Crea una geocerca y desactiva la anterior para el mismo device.
 *
 * @param {object} p
 * @param {string} p.deviceId
 * @param {string} p.userId
 * @param {number} p.lat
 * @param {number} p.lng
 * @param {number} [p.radiusM=80]
 * @returns {Promise<object>} — fila insertada
 */
async function createGeofence({ deviceId, userId, lat, lng, radiusM = 80 }) {
  const pool = getPool();
  // Desactivar cualquier geocerca previa del mismo device antes de crear una nueva.
  await pool.query(
    `UPDATE parking_geofences SET active = false WHERE device_id = $1 AND active = true`,
    [deviceId],
  );
  const res = await pool.query(
    `INSERT INTO parking_geofences (device_id, user_id, lat, lng, radius_m)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [deviceId, userId, lat, lng, radiusM],
  );
  return res.rows[0];
}

/**
 * @brief Desactiva la geocerca activa de un device (al DISARM o DELETE explícito).
 *
 * @param {string} deviceId
 * @returns {Promise<void>}
 */
async function deactivateGeofence(deviceId) {
  const pool = getPool();
  await pool.query(
    `UPDATE parking_geofences SET active = false WHERE device_id = $1 AND active = true`,
    [deviceId],
  );
}

/**
 * @brief Retorna la geocerca activa y no expirada de un device, o null.
 *
 * @param {string} deviceId
 * @returns {Promise<object|null>}
 */
async function getActiveGeofence(deviceId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM parking_geofences
     WHERE device_id = $1 AND active = true AND expires_at > NOW()
     LIMIT 1`,
    [deviceId],
  );
  return res.rows[0] || null;
}

/**
 * @brief Retorna todas las geocercas activas y no expiradas (para warm-up del cache).
 *
 * @returns {Promise<object[]>}
 */
async function getAllActiveGeofences() {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM parking_geofences WHERE active = true AND expires_at > NOW()`,
  );
  return res.rows;
}

module.exports = { createGeofence, deactivateGeofence, getActiveGeofence, getAllActiveGeofences };
