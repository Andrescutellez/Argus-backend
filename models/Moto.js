/**
 * @fileoverview Funciones de acceso a datos para la tabla motos.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL de motos. Una moto es la entidad física (motocicleta)
 *   asociada a un usuario. Puede tener un device ESP32 instalado.
 *
 * PATRÓN: igual que User.js — queries directas, sin ORM, sin migraciones.
 *
 * @module models/Moto
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Crea una nueva moto asociada a un usuario.
 * @param {{ userId: string, alias?: string, placa?: string, marca?: string, modelo?: string, color?: string, anio?: number }} data
 * @returns {Promise<object>} Fila creada.
 */
async function createMoto({ userId, alias, placa, marca, modelo, color, anio }) {
  // Con placa: upsert — si ya existe esa placa para este usuario, actualiza los demás
  // campos en lugar de crear un duplicado (cubre re-registros desde el onboarding).
  // Sin placa: insert directo (motos sin matrícula pueden repetirse).
  if (placa) {
    const { rows } = await getPool().query(
      `INSERT INTO motos (user_id, alias, placa, marca, modelo, color, anio)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, placa) WHERE placa IS NOT NULL
       DO UPDATE SET alias = EXCLUDED.alias, marca = EXCLUDED.marca,
                     modelo = EXCLUDED.modelo, color = EXCLUDED.color,
                     anio = EXCLUDED.anio
       RETURNING *`,
      [userId, alias ?? null, placa, marca ?? null, modelo ?? null, color ?? null, anio ?? null],
    );
    return rows[0];
  }

  const { rows } = await getPool().query(
    `INSERT INTO motos (user_id, alias, placa, marca, modelo, color, anio)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, alias ?? null, null, marca ?? null, modelo ?? null, color ?? null, anio ?? null],
  );
  return rows[0];
}

/**
 * @brief Retorna todas las motos de un usuario.
 * @param {string} userId  UUID
 * @returns {Promise<object[]>}
 */
async function getMotosByUser(userId) {
  const { rows } = await getPool().query(
    'SELECT * FROM motos WHERE user_id = $1 ORDER BY created_at ASC',
    [userId],
  );
  return rows;
}

/**
 * @brief Busca una moto por ID.
 * @param {string} motoId  UUID
 * @returns {Promise<object|null>}
 */
async function getMotoById(motoId) {
  const { rows } = await getPool().query(
    'SELECT * FROM motos WHERE id = $1',
    [motoId],
  );
  return rows[0] ?? null;
}

/**
 * @brief Actualiza campos de una moto. Solo actualiza los campos presentes en data.
 * @param {string} motoId  UUID
 * @param {{ alias?: string, placa?: string, marca?: string, modelo?: string, color?: string, anio?: number }} data
 * @returns {Promise<object|null>} Fila actualizada, o null si no existe.
 */
async function updateMoto(motoId, data) {
  const fields = ['alias', 'placa', 'marca', 'modelo', 'color', 'anio'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const field of fields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = $${idx++}`);
      values.push(data[field]);
    }
  }

  if (updates.length === 0) return getMotoById(motoId);

  values.push(motoId);
  const { rows } = await getPool().query(
    `UPDATE motos SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

/**
 * @brief Elimina una moto. ON DELETE CASCADE en devices la desvincula automáticamente.
 * @param {string} motoId  UUID
 * @returns {Promise<void>}
 */
async function deleteMoto(motoId) {
  await getPool().query('DELETE FROM motos WHERE id = $1', [motoId]);
}

/**
 * @brief Busca la moto asociada a un deviceId ESP32.
 *        Hace JOIN devices → motos para obtener los datos de la moto
 *        desde el identificador del dispositivo que envía los paquetes TCP.
 * @param {string} deviceId  p.ej. 'ARGUS-1237E630'
 * @returns {Promise<object|null>} Fila de motos, o null si no hay moto asignada.
 */
async function getMotoByDeviceId(deviceId) {
  const { rows } = await getPool().query(
    `SELECT m.*
     FROM devices d
     JOIN motos m ON m.id = d.moto_id
     WHERE d.device_id = $1
     LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

module.exports = { createMoto, getMotosByUser, getMotoById, getMotoByDeviceId, updateMoto, deleteMoto };
