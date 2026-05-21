/**
 * @fileoverview Modelo de acceso a la tabla manufactured_devices.
 *
 * PROPÓSITO:
 *   Provee las operaciones CRUD sobre el catálogo de MACs autorizadas.
 *   Solo los deviceIds registrados aquí pueden conectarse al servidor TCP
 *   y ser asignados por usuarios durante el onboarding.
 *
 * FLUJO GENERAL:
 *   El SUPER_ADMIN registra un device_id (MAC del ESP32) antes de vender el
 *   dispositivo. Cuando el usuario intenta asignar el device, el backend
 *   verifica que esté en esta tabla. El servidor TCP también consulta esta
 *   tabla en cada frame recibido para rechazar conexiones no autorizadas.
 *
 * @module models/ManufacturedDevice
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Registra un nuevo device en el catálogo de fabricación.
 *
 * PROPÓSITO:
 *   Permite que el SUPER_ADMIN pre-autorice un dispositivo antes de entregarlo
 *   al cliente. Sin este registro, el device no puede conectarse al servidor
 *   ni ser asignado en el onboarding.
 *
 * FLUJO:
 *   INSERT con ON CONFLICT DO NOTHING para que llamar dos veces con el mismo
 *   device_id sea idempotente (no lanza error, simplemente no inserta de nuevo).
 *
 * @param {string} deviceId — MAC o identificador único del ESP32.
 * @param {string} [notes]  — Notas opcionales (lote, cliente destino, etc.).
 * @returns {Promise<object>} Fila insertada.
 */
async function addDevice(deviceId, imei = null, notes = null) {
  const { rows } = await getPool().query(
    `INSERT INTO manufactured_devices (device_id, imei, notes)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE SET imei = EXCLUDED.imei, notes = EXCLUDED.notes
     RETURNING *`,
    [deviceId, imei, notes],
  );
  return rows[0];
}

/**
 * @brief Verifica si un deviceId está en el catálogo de fabricación.
 *
 * PROPÓSITO:
 *   Primera línea de defensa en el servidor TCP: antes de procesar cualquier
 *   frame GPS o EVENT, se verifica que el deviceId esté pre-autorizado.
 *
 * FLUJO:
 *   SELECT con LIMIT 1 — basta con saber si existe una fila.
 *
 * @param {string} deviceId — Identificador del dispositivo a verificar.
 * @returns {Promise<boolean>} true si el device está autorizado.
 */
async function isManufactured(deviceId) {
  const { rows } = await getPool().query(
    `SELECT 1 FROM manufactured_devices WHERE device_id = $1 LIMIT 1`,
    [deviceId],
  );
  return rows.length > 0;
}

/**
 * @brief Retorna todos los devices registrados en el catálogo.
 *
 * PROPÓSITO:
 *   Vista de inventario para el SUPER_ADMIN. Muestra todos los dispositivos
 *   autorizados, tanto los que ya fueron asignados como los disponibles.
 *
 * @returns {Promise<object[]>} Array de filas { device_id, registered_at, notes }.
 */
async function listAll() {
  const { rows } = await getPool().query(
    `SELECT device_id, registered_at, notes FROM manufactured_devices ORDER BY registered_at DESC`,
  );
  return rows;
}

/**
 * @brief Elimina un device del catálogo (revocación).
 *
 * PROPÓSITO:
 *   Permite revocar un dispositivo comprometido o devuelto. El device ya no
 *   podrá conectarse al servidor TCP ni ser asignado en nuevos onboardings.
 *   Los datos históricos existentes en otras tablas no se eliminan.
 *
 * @param {string} deviceId — Identificador del dispositivo a revocar.
 * @returns {Promise<boolean>} true si existía y fue eliminado.
 */
async function removeDevice(deviceId) {
  const { rowCount } = await getPool().query(
    `DELETE FROM manufactured_devices WHERE device_id = $1`,
    [deviceId],
  );
  return rowCount > 0;
}

module.exports = { addDevice, isManufactured, listAll, removeDevice };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — models/ManufacturedDevice.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo es el "libro de inventario" de Argus. Antes de que un dispositivo
   ESP32 salga de la fábrica (o sea, antes de entregárselo a un cliente), un
   SUPER_ADMIN lo registra aquí con su MAC. Solo los dispositivos en este libro
   pueden conectarse al sistema. Si alguien clona el firmware a un ESP32 con MAC
   diferente, el servidor lo rechaza porque esa MAC no está en el libro.

   PSEUDOCÓDIGO:
   addDevice(deviceId, notes):
     → INSERT INTO manufactured_devices ON CONFLICT DO UPDATE
     → retornar fila

   isManufactured(deviceId):
     → SELECT 1 FROM manufactured_devices WHERE device_id = ?
     → retornar rows.length > 0

   listAll():
     → SELECT * ORDER BY registered_at DESC

   removeDevice(deviceId):
     → DELETE WHERE device_id = ?
     → retornar rowCount > 0

   ═══════════════════════════════════════════════════════════ */
