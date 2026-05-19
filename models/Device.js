/**
 * @fileoverview Funciones de acceso a datos para la tabla devices.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL del hardware ESP32. Un device tiene un device_id único
 *   (el mismo que el ESP32 envía por TCP) y puede estar instalado en una moto.
 *
 * RELACIÓN: devices.moto_id → motos.id (nullable — device puede estar sin asignar)
 *
 * @module models/Device
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Registra un nuevo device ESP32 en el sistema.
 * @param {{ deviceId: string, motoId?: string, imei?: string, firmwareVersion?: string }} data
 * @returns {Promise<object>} Fila creada.
 */
async function createDevice({ deviceId, motoId, imei, firmwareVersion }) {
  const { rows } = await getPool().query(
    `INSERT INTO devices (device_id, moto_id, imei, firmware_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING *`,
    [deviceId, motoId ?? null, imei ?? null, firmwareVersion ?? null],
  );
  return rows[0] ?? null;
}

/**
 * @brief Busca un device por su device_id (el ID que envía el ESP32).
 * @param {string} deviceId
 * @returns {Promise<object|null>}
 */
async function getDeviceById(deviceId) {
  const { rows } = await getPool().query(
    'SELECT * FROM devices WHERE device_id = $1',
    [deviceId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Retorna el device instalado en una moto, si existe.
 * @param {string} motoId  UUID
 * @returns {Promise<object|null>}
 */
async function getDeviceByMoto(motoId) {
  const { rows } = await getPool().query(
    'SELECT * FROM devices WHERE moto_id = $1',
    [motoId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Asigna un device a una moto.
 * @param {string} deviceId
 * @param {string} motoId  UUID
 * @returns {Promise<object|null>} Fila actualizada.
 */
async function assignToMoto(deviceId, motoId) {
  const { rows } = await getPool().query(
    `UPDATE devices SET moto_id = $1 WHERE device_id = $2 RETURNING *`,
    [motoId, deviceId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Actualiza la versión de firmware de un device.
 *        Se llama cuando el ESP32 reporta una nueva versión en el handshake TCP.
 * @param {string} deviceId
 * @param {string} firmwareVersion
 * @returns {Promise<void>}
 */
async function updateFirmware(deviceId, firmwareVersion) {
  await getPool().query(
    'UPDATE devices SET firmware_version = $1 WHERE device_id = $2',
    [firmwareVersion, deviceId],
  );
}

module.exports = { createDevice, getDeviceById, getDeviceByMoto, assignToMoto, updateFirmware };
