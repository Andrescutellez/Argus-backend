/**
 * @fileoverview Funciones de acceso a datos para la tabla maintenance_records.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL del módulo Garage para registros de mantenimiento.
 *   Combina un catálogo predefinido (DEFAULTS) con los registros guardados por
 *   el usuario para generar una lista completa con progreso calculado en JS.
 *   Esto permite mostrar todos los tipos de mantenimiento incluso si el usuario
 *   aún no ha registrado ninguno.
 *
 * FLUJO:
 *   1. DEFAULTS define los 10 tipos de mantenimiento con intervalos recomendados.
 *   2. getRecords() hace SELECT de los registros del usuario y los fusiona con
 *      DEFAULTS, calculando progreso (progress_pct), km_remaining y days_remaining.
 *   3. upsertRecord() crea o actualiza un registro con ON CONFLICT.
 *   4. Los cálculos de progreso se hacen en JS (no en SQL) para facilitar tests.
 *
 * DEPENDENCIAS:
 *   config/postgres.js — getPool() singleton de pg.Pool
 *
 * VARIABLES CRÍTICAS:
 *   currentOdometerKm: entero — odómetro actual de la moto. Es la referencia
 *   para calcular cuántos km han pasado desde el último mantenimiento.
 *   Si es null/undefined, el progreso km-based no puede calcularse (queda en 0).
 *
 * @module models/MaintenanceRecord
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Catálogo de tipos de mantenimiento con intervalos recomendados.
 *
 * PROPÓSITO: proveer valores por defecto para los ítems que el usuario no ha
 * registrado aún. Cada entry tiene label para mostrar en la UI, interval_km
 * o interval_days (mutuamente excluyentes en la mayoría de tipos).
 *
 * RIESGO: si se modifica una clave (p.ej. 'OIL' → 'ENGINE_OIL'), los registros
 * existentes en la DB quedan huérfanos y aparecerán como tipo desconocido.
 * Cambios de clave requieren migración SQL simultánea.
 */
const DEFAULTS = {
  OIL:           { label: 'Aceite',            interval_km: 3000,  interval_days: null },
  AIR_FILTER:    { label: 'Filtro de aire',     interval_km: 6000,  interval_days: null },
  SPARK_PLUG:    { label: 'Bujía',              interval_km: 12000, interval_days: null },
  BRAKE_FLUID:   { label: 'Líquido de frenos',  interval_km: null,  interval_days: 365  },
  COOLANT:       { label: 'Refrigerante',        interval_km: null,  interval_days: 730  },
  CHAIN_LUBE:    { label: 'Lubricar cadena',     interval_km: 500,   interval_days: null },
  CHAIN_TENSION: { label: 'Tensar cadena',       interval_km: 1500,  interval_days: null },
  BRAKE_PADS:    { label: 'Pastillas de freno',  interval_km: 15000, interval_days: null },
  TIRES:         { label: 'Llantas',             interval_km: 20000, interval_days: null },
  BATTERY:       { label: 'Batería',             interval_km: null,  interval_days: 730  },
};

/**
 * @brief Calcula el progreso de un mantenimiento hacia el próximo intervalo.
 *
 * PROPÓSITO: centralizar el cálculo de progreso para que getRecords() sea
 * legible y para poder testar la lógica sin base de datos.
 *
 * FLUJO (km-based):
 *   1. used = currentOdometerKm - last_done_km (o 0 si no hay registro previo)
 *   2. progress_pct = min(100, round(used / interval_km * 100))
 *   3. km_remaining = max(0, interval_km - used)
 *
 * FLUJO (days-based):
 *   1. daysSince = días desde last_done_at (o 0 si no hay registro previo)
 *   2. progress_pct = min(100, round(daysSince / interval_days * 100))
 *   3. days_remaining = max(0, interval_days - daysSince)
 *
 * @param {object} record         Fila de maintenance_records (puede ser placeholder vacío).
 * @param {object} defaults       Entry correspondiente en DEFAULTS.
 * @param {number|null} currentOdometerKm  Odómetro actual de la moto.
 * @returns {{ progress_pct: number, km_remaining: number|null, days_remaining: number|null }}
 */
function computeProgress(record, defaults, currentOdometerKm) {
  const interval_km   = record.interval_km   ?? defaults.interval_km;
  const interval_days = record.interval_days ?? defaults.interval_days;
  const last_done_km  = record.last_done_km  ?? null;
  const last_done_at  = record.last_done_at  ?? null;

  if (interval_km != null) {
    // Progreso basado en kilómetros.
    // Si no hay odómetro actual, no podemos calcular → progreso 0 (optimista).
    const odo = currentOdometerKm ?? 0;
    const used = odo - (last_done_km ?? odo);
    // Evitar used negativo si el odómetro fue corregido a un valor menor.
    const usedSafe = Math.max(0, used);
    const progress_pct  = Math.min(100, Math.round((usedSafe / interval_km) * 100));
    const km_remaining  = Math.max(0, interval_km - usedSafe);
    return { progress_pct, km_remaining, days_remaining: null };
  }

  if (interval_days != null) {
    // Progreso basado en días.
    const daysSince = last_done_at
      ? Math.ceil((new Date() - new Date(last_done_at)) / 86400000)
      : 0;
    const daysSinceSafe = Math.max(0, daysSince);
    const progress_pct   = Math.min(100, Math.round((daysSinceSafe / interval_days) * 100));
    const days_remaining = Math.max(0, interval_days - daysSinceSafe);
    return { progress_pct, days_remaining, km_remaining: null };
  }

  // Si un tipo no tiene intervalo definido (no debería ocurrir con DEFAULTS completo).
  return { progress_pct: 0, km_remaining: null, days_remaining: null };
}

/**
 * @brief Crea o actualiza un registro de mantenimiento para el usuario dado.
 *
 * PROPÓSITO: un usuario tiene exactamente un registro por tipo de mantenimiento.
 * ON CONFLICT (user_id, type) actualiza todos los campos sin crear duplicados,
 * permitiendo registrar "acabo de cambiar el aceite" directamente desde la UI.
 *
 * FLUJO:
 *   1. INSERT con todos los campos proporcionados.
 *   2. ON CONFLICT: actualizar campos editables y refrescar updated_at.
 *   3. RETURNING * para devolver la fila sin SELECT adicional.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {string} type    Clave del mantenimiento (debe coincidir con DEFAULTS).
 * @param {object} data    Campos del registro.
 * @param {number|null} [data.last_done_km]   Odómetro al realizar el mantenimiento.
 * @param {string|null} [data.last_done_at]   Fecha en que se realizó (ISO).
 * @param {number|null} [data.interval_km]    Intervalo personalizado en km.
 * @param {number|null} [data.interval_days]  Intervalo personalizado en días.
 * @param {string|null} [data.notes]          Notas libres.
 * @param {string|null} [motoId]              UUID de la moto (opcional).
 * @returns {Promise<object>} Fila upsertada (sin progreso — usar getRecords para eso).
 */
async function upsertRecord(userId, type, data, motoId = null) {
  const {
    last_done_km   = null,
    last_done_at   = null,
    interval_km    = null,
    interval_days  = null,
    notes          = null,
  } = data;

  const { rows } = await getPool().query(
    `INSERT INTO maintenance_records
       (user_id, moto_id, type, last_done_km, last_done_at, interval_km, interval_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, type) DO UPDATE SET
       moto_id       = COALESCE(EXCLUDED.moto_id, maintenance_records.moto_id),
       last_done_km  = EXCLUDED.last_done_km,
       last_done_at  = EXCLUDED.last_done_at,
       interval_km   = COALESCE(EXCLUDED.interval_km,   maintenance_records.interval_km),
       interval_days = COALESCE(EXCLUDED.interval_days, maintenance_records.interval_days),
       notes         = EXCLUDED.notes,
       updated_at    = NOW()
     RETURNING *`,
    [userId, motoId, type, last_done_km, last_done_at, interval_km, interval_days, notes],
  );

  return rows[0];
}

/**
 * @brief Retorna todos los tipos de mantenimiento con progreso calculado.
 *
 * PROPÓSITO: generar la lista completa del Garage fusionando DEFAULTS con los
 * registros guardados del usuario. Los tipos no guardados aparecen con sus
 * valores por defecto y progress_pct = 0 (ningún km/día consumido).
 *
 * FLUJO:
 *   1. SELECT todos los registros del usuario.
 *   2. Indexar los registros por type en un Map para O(1) lookup.
 *   3. Iterar sobre Object.entries(DEFAULTS) para garantizar que todos
 *      los tipos aparezcan, con o sin registro guardado.
 *   4. Para cada tipo: fusionar el DEFAULT con el registro del usuario
 *      y calcular progreso con computeProgress().
 *
 * @param {string} userId              UUID del usuario autenticado.
 * @param {number|null} currentOdometerKm  Odómetro actual de la moto (de motos.current_odometer_km).
 * @returns {Promise<object[]>} Array de 10 ítems con label, progress_pct, km/days remaining.
 */
async function getRecords(userId, currentOdometerKm) {
  const { rows } = await getPool().query(
    `SELECT * FROM maintenance_records
     WHERE user_id = $1`,
    [userId],
  );

  // Indexar por type para evitar un find() O(n) en el loop siguiente.
  const savedByType = new Map(rows.map((r) => [r.type, r]));

  return Object.entries(DEFAULTS).map(([type, defaults]) => {
    // Si el usuario tiene un registro para este tipo, usar sus datos;
    // si no, usar un objeto vacío para que computeProgress use los DEFAULTS.
    const saved = savedByType.get(type) ?? {};

    const interval_km   = saved.interval_km   ?? defaults.interval_km;
    const interval_days = saved.interval_days ?? defaults.interval_days;

    const { progress_pct, km_remaining, days_remaining } = computeProgress(
      saved,
      defaults,
      currentOdometerKm,
    );

    return {
      // Campos de identidad
      id:            saved.id           ?? null,
      user_id:       userId,
      moto_id:       saved.moto_id      ?? null,
      type,
      label:         defaults.label,
      // Campos de registro
      last_done_km:  saved.last_done_km  ?? null,
      last_done_at:  saved.last_done_at  ?? null,
      interval_km,
      interval_days,
      notes:         saved.notes         ?? null,
      created_at:    saved.created_at    ?? null,
      updated_at:    saved.updated_at    ?? null,
      // Campos calculados
      progress_pct,
      km_remaining,
      days_remaining,
    };
  });
}

/**
 * @brief Retorna un registro de mantenimiento específico del usuario.
 *
 * PROPÓSITO: leer un ítem individual sin cargar toda la lista (útil para
 * el controlador que necesita refrescar solo el ítem modificado).
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {string} type    Clave del tipo de mantenimiento.
 * @returns {Promise<object|null>} Fila cruda (sin progreso), o null si no existe.
 */
async function getRecord(userId, type) {
  const { rows } = await getPool().query(
    `SELECT * FROM maintenance_records
     WHERE user_id = $1 AND type = $2`,
    [userId, type],
  );
  return rows[0] ?? null;
}

module.exports = { upsertRecord, getRecords, getRecord, DEFAULTS, computeProgress };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — MaintenanceRecord.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Maneja el historial de mantenimientos de la moto. Define un catálogo fijo
   (DEFAULTS) con 10 tipos de servicio y sus intervalos recomendados. Cuando
   el usuario registra un mantenimiento, el progreso se calcula en JS usando
   el odómetro actual de la moto para ítems km-based, o los días transcurridos
   para ítems days-based (frenos, batería, refrigerante).

   PSEUDOCÓDIGO:
     getRecords(userId, currentOdometerKm):
       SELECT registros del usuario
       indexar por type en Map
       para cada tipo en DEFAULTS:
         fusionar DEFAULT + registro guardado
         computeProgress(saved, defaults, odo)
         → { type, label, progress_pct, km/days_remaining, ... }
       return array[10]

     computeProgress(record, defaults, odo):
       si interval_km:
         used = odo - last_done_km
         progress_pct = min(100, used/interval_km * 100)
         km_remaining = max(0, interval_km - used)
       si interval_days:
         daysSince = días desde last_done_at
         progress_pct = min(100, daysSince/interval_days * 100)
         days_remaining = max(0, interval_days - daysSince)

   DIAGRAMA MENTAL:
     DEFAULTS (10 tipos)
       ↓ merge
     [maintenance_records PG] ← upsertRecord()
       ↓ getRecords()
     [computeProgress()] ← lógica JS pura
       ↓
     [garageController.js]

   MEJORAS SUGERIDAS:
   - Permitir que el usuario defina tipos de mantenimiento personalizados
     (tabla custom_maintenance_types).
   - Historial de múltiples servicios del mismo tipo (actualmente solo guarda el último).
   - Notificación push cuando progress_pct >= 90%.

   DEUDA TÉCNICA:
   - Un usuario con varias motos comparte los mismos registros (user_id único).
     En una versión posterior convendría que el UNIQUE sea (user_id, moto_id, type).

   ═══════════════════════════════════════════════════════════ */
