/**
 * @fileoverview Funciones de acceso a datos para la tabla audit_log.
 *
 * PROPÓSITO:
 *   Registro inmutable (append-only) de acciones críticas del sistema.
 *   Ejemplos: ARM, DISARM, ENGINE_CUT, login, cambio de plan, asignación de device.
 *
 * INVARIANTE: nunca se actualiza ni borra ninguna fila. Solo INSERT y SELECT.
 *
 * @module models/AuditLog
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Registra una acción crítica en el audit log.
 *
 * @param {{ userId?: string, action: string, targetType?: string, targetId?: string, metadata?: object }} data
 *   - userId:     quién ejecutó la acción (null si es sistema/anónimo)
 *   - action:     nombre de la acción, p.ej. 'ARM', 'ENGINE_CUT', 'LOGIN', 'PLAN_UPGRADE'
 *   - targetType: qué entidad fue afectada, p.ej. 'device', 'user', 'moto'
 *   - targetId:   ID de la entidad afectada
 *   - metadata:   contexto extra en JSON, p.ej. { ip, deviceId, previousPlan }
 * @returns {Promise<void>}
 */
async function log({ userId, action, targetType, targetId, metadata }) {
  await getPool().query(
    `INSERT INTO audit_log (user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId ?? null, action, targetType ?? null, targetId ?? null, metadata ? JSON.stringify(metadata) : null],
  );
}

/**
 * @brief Retorna entradas del audit log con filtros opcionales.
 *        Solo para uso de ADMIN/SUPER_ADMIN.
 * @param {{ userId?: string, action?: string, targetId?: string, limit?: number }} filters
 * @returns {Promise<object[]>}
 */
async function getLogs({ userId, action, targetId, limit = 100 } = {}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (userId)   { conditions.push(`user_id = $${idx++}`);    values.push(userId); }
  if (action)   { conditions.push(`action = $${idx++}`);     values.push(action); }
  if (targetId) { conditions.push(`target_id = $${idx++}`);  values.push(targetId); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);

  const { rows } = await getPool().query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    values,
  );
  return rows;
}

module.exports = { log, getLogs };
