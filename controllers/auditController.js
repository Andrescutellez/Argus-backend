/**
 * @fileoverview Controlador REST para consulta del audit log.
 *
 * PROPÓSITO:
 *   Expone el registro de acciones críticas del sistema para revisión de
 *   administradores. Solo accesible por ADMIN y SUPER_ADMIN.
 *
 * @module controllers/auditController
 */

'use strict';

const AuditLog = require('../models/AuditLog');

/**
 * @brief Retorna entradas del audit log con filtros opcionales via query params.
 *
 * QUERY PARAMS:
 *   userId   — filtrar por usuario
 *   action   — filtrar por tipo de acción (ARM, MOTO_CREATE, etc.)
 *   targetId — filtrar por ID de entidad afectada
 *   limit    — máximo de resultados (default 100, max 500)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: array de entradas
 */
const getLogs = async (req, res) => {
  const { userId, action, targetId, limit } = req.query;

  const parsedLimit = Math.min(parseInt(limit) || 100, 500);

  try {
    const logs = await AuditLog.getLogs({ userId, action, targetId, limit: parsedLimit });
    return res.status(200).json(logs);
  } catch (err) {
    console.error('[AUDIT] getLogs error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { getLogs };
