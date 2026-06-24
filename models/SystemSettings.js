/**
 * @fileoverview Modelo de configuración global del sistema (tabla system_settings).
 *
 * PROPÓSITO:
 *   Provee acceso clave-valor a parámetros editables desde la Central de Monitoreo.
 *   Cada setting tiene un nombre de clave predefinido y su valor se guarda como TEXT.
 *
 * CLAVES ACTUALES:
 *   nearby_alert_radius_km — radio en km para alertas a moteros cercanos.
 *                            '0' significa desactivado (solo operadores).
 *
 * FLUJO:
 *   Controller llama get(key) → SELECT en PostgreSQL → retorna string.
 *   Controller llama set(key, value) → UPSERT con NOW() en updated_at.
 *
 * @module models/SystemSettings
 */

'use strict';

const { getPool } = require('../config/postgres');

const KEYS = {
  NEARBY_ALERT_RADIUS_KM: 'nearby_alert_radius_km',
};

/**
 * @brief Lee el valor de un setting.
 *
 * @param {string} key — clave del setting (usar constante KEYS.*)
 * @returns {Promise<string|null>} valor como string, o null si no existe
 */
async function get(key) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT value FROM system_settings WHERE key = $1',
    [key]
  );
  return rows[0]?.value ?? null;
}

/**
 * @brief Escribe (upsert) el valor de un setting.
 *
 * @param {string} key   — clave del setting
 * @param {string} value — nuevo valor (siempre TEXT)
 * @returns {Promise<void>}
 */
async function set(key, value) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = NOW()`,
    [key, String(value)]
  );
}

/**
 * @brief Retorna todos los settings como array [{key, value, updated_at}].
 *
 * @returns {Promise<Array<{key: string, value: string, updated_at: Date}>>}
 */
async function getAll() {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT key, value, updated_at FROM system_settings ORDER BY key'
  );
  return rows;
}

module.exports = { KEYS, get, set, getAll };

/*
 * RESUMEN DEL MÓDULO — SystemSettings.js
 * Interfaz mínima de 3 funciones (get/set/getAll) sobre la tabla system_settings.
 * Sin caché — cada llamada hace una query real. El controlador puede agregar caché
 * en memoria si la frecuencia de lectura justifica evitar round-trips a Postgres.
 */
