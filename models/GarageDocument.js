/**
 * @fileoverview Funciones de acceso a datos para la tabla vehicle_documents.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL del módulo Garage para documentos legales del
 *   vehículo: SOAT, Tecnomecánica, Licencia de conducción, Licencia de
 *   tránsito y Garantía. Calcula el estado de vigencia en JavaScript para
 *   evitar lógica de fechas en SQL y facilitar las pruebas unitarias.
 *
 * FLUJO:
 *   1. upsertDocument() escribe o actualiza el documento con ON CONFLICT.
 *   2. getDocuments() lee todos los documentos del usuario y calcula status.
 *   3. getDocument() lee un documento específico por (user_id, type).
 *   El cálculo de status/days_remaining se hace en computeDocStatus() para
 *   mantener la lógica de negocio fuera de SQL y centralizada en un solo lugar.
 *
 * DEPENDENCIAS:
 *   config/postgres.js — getPool() singleton de pg.Pool
 *
 * VARIABLES CRÍTICAS:
 *   expires_at: DATE — campo que determina el status del documento. Si es null,
 *   el status es 'SIN_FECHA' y no se emiten recordatorios.
 *
 * @module models/GarageDocument
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Calcula el estado de vigencia de un documento a partir de su fecha de vencimiento.
 *
 * PROPÓSITO: centralizar la lógica de estado para que getDocuments() y
 * getDocument() retornen información consistente sin duplicar código.
 *
 * FLUJO:
 *   1. Si no hay expires_at → SIN_FECHA (documento no tiene fecha conocida).
 *   2. Si days < 0 → VENCIDO (el documento ya expiró).
 *   3. Si days ≤ 30 → PROXIMO_A_VENCER (umbral de alerta configurable en futuras versiones).
 *   4. Si days > 30 → VIGENTE.
 *
 * @param {string|Date|null} expires_at  Fecha de vencimiento del documento.
 * @returns {{ status: string, days_remaining: number|null }}
 *
 * @note days_remaining es negativo cuando el documento está vencido (días desde vencimiento).
 *       Esto permite al frontend mostrar "venció hace N días" sin cálculo adicional.
 */
function computeDocStatus(expires_at) {
  if (!expires_at) return { status: 'SIN_FECHA', days_remaining: null };

  // Math.ceil: si faltan 0.3 días se muestra "1 día restante", no "0 días".
  // Dividir por 86400000 (ms/día) en lugar de usar librerías de fecha evita
  // dependencias externas y es suficiente para precisión de día entero.
  const days = Math.ceil((new Date(expires_at) - new Date()) / 86400000);

  if (days < 0)   return { status: 'VENCIDO',           days_remaining: days };
  if (days <= 30) return { status: 'PROXIMO_A_VENCER',  days_remaining: days };
  return { status: 'VIGENTE', days_remaining: days };
}

/**
 * @brief Crea o actualiza un documento del vehículo para el usuario dado.
 *
 * PROPÓSITO: un usuario tiene exactamente un documento de cada tipo (UNIQUE
 * user_id + type). ON CONFLICT actualiza todos los campos relevantes en lugar
 * de fallar, permitiendo editar desde la UI sin flujo create/update separado.
 *
 * FLUJO:
 *   1. Ejecutar INSERT con todos los campos.
 *   2. Si existe conflicto (mismo user_id + type), actualizar los campos
 *      editables y refrescar updated_at.
 *   3. RETURNING * devuelve la fila final para que el controlador la retorne
 *      al cliente sin un SELECT adicional.
 *
 * @param {string} userId  UUID del usuario autenticado (req.user.sub).
 * @param {string} type    Tipo de documento: 'SOAT'|'TECNO'|'LIC_CONDUCCION'|'LIC_TRANSITO'|'GARANTIA'.
 * @param {object} data    Campos del documento.
 * @param {string|null} [data.expires_at]   Fecha de vencimiento (ISO).
 * @param {string|null} [data.issued_at]    Fecha de expedición (ISO).
 * @param {string|null} [data.vin]          Número VIN del chasis.
 * @param {string|null} [data.engine_num]   Número de motor.
 * @param {number|null} [data.cylinder_cc]  Cilindraje en cc.
 * @param {number[]|null} [data.reminders]  Días antes para notificar.
 * @param {string|null} [data.notes]        Notas libres del usuario.
 * @returns {Promise<object>} Fila upsertada con status y days_remaining calculados.
 */
async function upsertDocument(userId, type, data) {
  const {
    expires_at   = null,
    issued_at    = null,
    vin          = null,
    engine_num   = null,
    cylinder_cc  = null,
    reminders    = null,
    notes        = null,
  } = data;

  // Construir el array de reminders como literal PostgreSQL si viene del cliente,
  // o dejarlo en null para que la columna use su DEFAULT '{30,15,7,1}'.
  // Se pasa como JSON array de enteros; pg lo convierte a INTEGER[].
  const remindersVal = reminders ?? null;

  const { rows } = await getPool().query(
    `INSERT INTO vehicle_documents
       (user_id, type, expires_at, issued_at, vin, engine_num, cylinder_cc, reminders, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, type) DO UPDATE SET
       expires_at  = EXCLUDED.expires_at,
       issued_at   = EXCLUDED.issued_at,
       vin         = EXCLUDED.vin,
       engine_num  = EXCLUDED.engine_num,
       cylinder_cc = EXCLUDED.cylinder_cc,
       reminders   = COALESCE(EXCLUDED.reminders, vehicle_documents.reminders),
       notes       = EXCLUDED.notes,
       updated_at  = NOW()
     RETURNING *`,
    [userId, type, expires_at, issued_at, vin, engine_num, cylinder_cc, remindersVal, notes],
  );

  const row = rows[0];
  // Adjuntar status calculado en JS para que el cliente no tenga que calcularlo.
  const { status, days_remaining } = computeDocStatus(row.expires_at);
  return { ...row, status, days_remaining };
}

/**
 * @brief Retorna todos los documentos del usuario con su estado de vigencia.
 *
 * PROPÓSITO: alimentar la pantalla principal del Garage con el estado de
 * cada documento para que el usuario vea de un vistazo qué está vencido.
 *
 * FLUJO:
 *   1. SELECT todos los documentos del usuario ordenados por tipo.
 *   2. Para cada fila, calcular status y days_remaining con computeDocStatus().
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @returns {Promise<object[]>} Array de documentos con status y days_remaining.
 */
async function getDocuments(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM vehicle_documents
     WHERE user_id = $1
     ORDER BY type ASC`,
    [userId],
  );

  // Map en lugar de forEach para retornar un nuevo array sin mutar las filas
  // originales del pool (pg reutiliza los objetos de fila internamente).
  return rows.map((row) => {
    const { status, days_remaining } = computeDocStatus(row.expires_at);
    return { ...row, status, days_remaining };
  });
}

/**
 * @brief Retorna un documento específico del usuario por tipo.
 *
 * PROPÓSITO: leer un documento individual para la pantalla de detalle/edición
 * sin cargar todos los documentos del usuario.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {string} type    Tipo de documento.
 * @returns {Promise<object|null>} Fila con status calculado, o null si no existe.
 */
async function getDocument(userId, type) {
  const { rows } = await getPool().query(
    `SELECT * FROM vehicle_documents
     WHERE user_id = $1 AND type = $2`,
    [userId, type],
  );

  if (!rows[0]) return null;

  const row = rows[0];
  const { status, days_remaining } = computeDocStatus(row.expires_at);
  return { ...row, status, days_remaining };
}

module.exports = { upsertDocument, getDocuments, getDocument, computeDocStatus };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — GarageDocument.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo maneja los documentos legales del vehículo (SOAT, Tecnomecánica,
   licencias, garantía). El cálculo de vigencia se hace en JavaScript, no en SQL,
   para que los tests unitarios puedan validar la lógica sin base de datos.
   Cada usuario tiene exactamente un documento de cada tipo (UNIQUE en DB).

   PSEUDOCÓDIGO:
     upsertDocument(userId, type, data):
       INSERT INTO vehicle_documents ... ON CONFLICT DO UPDATE
       adjuntar status y days_remaining calculados en JS
       return fila

     getDocuments(userId):
       SELECT * WHERE user_id ORDER BY type
       para cada fila: adjuntar computeDocStatus(expires_at)
       return array

     computeDocStatus(expires_at):
       si no hay fecha → SIN_FECHA
       calcular días hasta vencimiento
       < 0 → VENCIDO | ≤ 30 → PROXIMO_A_VENCER | > 30 → VIGENTE

   DIAGRAMA MENTAL:
     [vehicle_documents PG]
       ↑ upsert / read
     [GarageDocument.js]
       + computeDocStatus() ← lógica de negocio en JS
       ↓ retorna filas enriquecidas
     [garageController.js]

   MEJORAS SUGERIDAS:
   - Emitir push notification cuando days_remaining esté en la lista reminders[].
   - Soportar múltiples documentos del mismo tipo (p.ej. dos licencias).
   - Adjuntar URL de imagen del documento escaneado (S3/R2).

   DEUDA TÉCNICA:
   - reminders actualmente se guarda pero no dispara notificaciones push.

   ═══════════════════════════════════════════════════════════ */
