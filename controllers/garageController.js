/**
 * @fileoverview Controlador REST para el módulo Garage de Argus Secure.
 *
 * PROPÓSITO:
 *   Implementa todos los handlers HTTP del Garage: documentos legales,
 *   mantenimientos, combustible, gastos, score de salud, agenda de eventos
 *   y odómetro. Cada función lee req.user.sub (UUID inyectado por authenticate())
 *   y delega la lógica de datos a los modelos correspondientes.
 *
 * FLUJO GENERAL:
 *   1. Leer req.user.sub como userId.
 *   2. Obtener la moto primaria del usuario con _getPrimaryMoto() cuando se
 *      necesita el odómetro actual.
 *   3. Llamar al modelo correspondiente.
 *   4. Retornar la respuesta con el código HTTP apropiado.
 *
 * DEPENDENCIAS:
 *   models/GarageDocument.js    — documentos legales
 *   models/MaintenanceRecord.js — mantenimientos
 *   models/FuelLog.js           — combustible
 *   models/ExpenseLog.js        — gastos
 *   config/postgres.js          — getPool() para queries de moto y odómetro
 *
 * VARIABLES CRÍTICAS:
 *   req.user.sub: UUID del usuario autenticado (inyectado por middleware/auth.js).
 *   Sin authenticate(), req.user es undefined y todas las funciones crashean.
 *
 * @module controllers/garageController
 */

'use strict';

const { getPool }      = require('../config/postgres');
const GarageDocument   = require('../models/GarageDocument');
const MaintenanceRecord = require('../models/MaintenanceRecord');
const FuelLog          = require('../models/FuelLog');
const ExpenseLog       = require('../models/ExpenseLog');

// ─── HELPER PRIVADO ──────────────────────────────────────────────────────────

/**
 * @brief Obtiene la moto primaria del usuario con su odómetro actual.
 *
 * PROPÓSITO: los endpoints de mantenimiento y score necesitan el odómetro
 * actual para calcular el progreso km-based. Se usa la moto más antigua
 * (ORDER BY created_at ASC) como "moto principal" del usuario.
 * En una versión futura se podría permitir seleccionar la moto activa.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @returns {Promise<{ id: string, current_odometer_km: number|null }|null>}
 *   Objeto con id y odómetro, o null si el usuario no tiene motos registradas.
 */
async function _getPrimaryMoto(userId) {
  const { rows } = await getPool().query(
    `SELECT id, current_odometer_km
     FROM motos
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

// ─── DOCUMENTOS ──────────────────────────────────────────────────────────────

/**
 * @brief Retorna todos los documentos legales del usuario con su estado de vigencia.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: array de documentos (vacío si no hay ninguno)
 */
const getDocuments = async (req, res) => {
  try {
    const docs = await GarageDocument.getDocuments(req.user.sub);
    return res.status(200).json(docs);
  } catch (err) {
    console.error('[GARAGE] getDocuments error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Crea o actualiza un documento del vehículo por tipo.
 *
 * PROPÓSITO: upsert por (user_id, type) — permite crear y editar con el mismo
 * endpoint sin necesidad de saber si el documento ya existe.
 *
 * @param {import('express').Request}  req
 *   params.type: 'SOAT'|'TECNO'|'LIC_CONDUCCION'
 *   body: { expires_at?, issued_at?, vin?, engine_num?, cylinder_cc?, reminders?, notes? }
 * @param {import('express').Response} res  200: documento upsertado | 400: tipo inválido
 */
const upsertDocument = async (req, res) => {
  const VALID_TYPES = ['SOAT', 'TECNO', 'LIC_CONDUCCION'];
  const { type } = req.params;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ message: `Tipo inválido. Valores válidos: ${VALID_TYPES.join(', ')}` });
  }

  try {
    const doc = await GarageDocument.upsertDocument(req.user.sub, type, req.body ?? {});
    return res.status(200).json(doc);
  } catch (err) {
    console.error('[GARAGE] upsertDocument error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── MANTENIMIENTO ────────────────────────────────────────────────────────────

/**
 * @brief Retorna la lista completa de mantenimientos con progreso calculado.
 *
 * PROPÓSITO: combina el catálogo DEFAULTS con los registros guardados del usuario
 * y usa el odómetro de la moto primaria para calcular el progreso km-based.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: array de 10 ítems de mantenimiento
 */
const getMaintenance = async (req, res) => {
  try {
    const moto    = await _getPrimaryMoto(req.user.sub);
    const records = await MaintenanceRecord.getRecords(req.user.sub, moto?.current_odometer_km ?? null);
    return res.status(200).json(records);
  } catch (err) {
    console.error('[GARAGE] getMaintenance error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Crea o actualiza un registro de mantenimiento por tipo.
 *
 * PROPÓSITO: registrar "acabo de hacer el mantenimiento X" con la fecha y el
 * odómetro actual. Después del upsert, retorna la lista completa actualizada
 * para que el cliente refresque toda la pantalla en un solo request.
 *
 * @param {import('express').Request}  req
 *   params.type: clave de MaintenanceRecord.DEFAULTS
 *   body: { last_done_km?, last_done_at?, interval_km?, interval_days?, notes? }
 * @param {import('express').Response} res  200: array completo de mantenimientos actualizado
 */
const upsertMaintenance = async (req, res) => {
  const { type } = req.params;

  // Validar que el tipo existe en el catálogo para dar un 400 descriptivo
  // en lugar de insertar un tipo desconocido que nunca aparecería en la UI.
  if (!MaintenanceRecord.DEFAULTS[type]) {
    const validTypes = Object.keys(MaintenanceRecord.DEFAULTS).join(', ');
    return res.status(400).json({ message: `Tipo inválido. Valores válidos: ${validTypes}` });
  }

  try {
    const moto = await _getPrimaryMoto(req.user.sub);

    await MaintenanceRecord.upsertRecord(
      req.user.sub,
      type,
      req.body ?? {},
      moto?.id ?? null,
    );

    // Re-fetch con la lista completa para que el frontend actualice todo en un request.
    const records = await MaintenanceRecord.getRecords(req.user.sub, moto?.current_odometer_km ?? null);
    return res.status(200).json(records);
  } catch (err) {
    console.error('[GARAGE] upsertMaintenance error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Activa o desactiva el seguimiento de un tipo de mantenimiento.
 *
 * PROPÓSITO: el usuario elige qué ítems quiere vigilar (p.ej. aceite sí,
 * bujía no). Los ítems desactivados dejan de contar en getScore()/getAgenda()
 * y no muestran progreso en la lista, pero sus datos (last_done_km/at) se
 * conservan por si el usuario los reactiva después.
 *
 * @param {import('express').Request}  req
 *   params.type: clave de MaintenanceRecord.DEFAULTS
 *   body: { active: boolean }
 * @param {import('express').Response} res  200: array completo de mantenimientos actualizado
 */
const setMaintenanceActive = async (req, res) => {
  const { type } = req.params;
  const { active } = req.body ?? {};

  if (!MaintenanceRecord.DEFAULTS[type]) {
    const validTypes = Object.keys(MaintenanceRecord.DEFAULTS).join(', ');
    return res.status(400).json({ message: `Tipo inválido. Valores válidos: ${validTypes}` });
  }

  if (typeof active !== 'boolean') {
    return res.status(400).json({ message: 'El campo active es requerido y debe ser booleano' });
  }

  try {
    const moto = await _getPrimaryMoto(req.user.sub);

    await MaintenanceRecord.setActive(req.user.sub, type, active, moto?.id ?? null);

    const records = await MaintenanceRecord.getRecords(req.user.sub, moto?.current_odometer_km ?? null);
    return res.status(200).json(records);
  } catch (err) {
    console.error('[GARAGE] setMaintenanceActive error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── COMBUSTIBLE ──────────────────────────────────────────────────────────────

/**
 * @brief Retorna el historial de fill-ups y el resumen de eficiencia.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: { logs, summary }
 */
const getFuel = async (req, res) => {
  try {
    const [logs, summary] = await Promise.all([
      FuelLog.getFuelLogs(req.user.sub),
      FuelLog.getFuelSummary(req.user.sub),
    ]);
    return res.status(200).json({ logs, summary });
  } catch (err) {
    console.error('[GARAGE] getFuel error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Registra una nueva carga de combustible.
 *
 * PROPÓSITO: además de insertar el fill-up, si viene con odometer_km actualiza
 * el campo current_odometer_km de la moto del usuario si el nuevo valor es mayor
 * al guardado. Esto mantiene el odómetro de la moto actualizado automáticamente
 * sin que el usuario tenga que ir a la pantalla de odómetro por separado.
 *
 * @param {import('express').Request}  req
 *   body: { liters?, price_total?, odometer_km?, logged_at?, notes? }
 * @param {import('express').Response} res  201: fill-up creado
 */
const addFuel = async (req, res) => {
  const { liters, price_total, odometer_km, logged_at, notes } = req.body ?? {};

  try {
    const moto = await _getPrimaryMoto(req.user.sub);
    const log  = await FuelLog.addFuelLog(req.user.sub, moto?.id ?? null, { liters, price_total, odometer_km, logged_at, notes });

    // Actualizar odómetro de la moto si el fill-up trae un valor mayor al actual.
    // La condición (current_odometer_km IS NULL OR current_odometer_km < $1) garantiza
    // que nunca se retrocede el odómetro si el usuario carga fill-ups fuera de orden.
    if (odometer_km != null && moto?.id) {
      await getPool().query(
        `UPDATE motos
         SET current_odometer_km = $1
         WHERE user_id = $2
           AND (current_odometer_km IS NULL OR current_odometer_km < $1)`,
        [odometer_km, req.user.sub],
      );
    }

    return res.status(201).json(log);
  } catch (err) {
    console.error('[GARAGE] addFuel error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Elimina un registro de fill-up por ID.
 *
 * @param {import('express').Request}  req  params.id: UUID del fill-up
 * @param {import('express').Response} res  200: { ok: true } | 404: no encontrado
 */
const deleteFuel = async (req, res) => {
  try {
    const deleted = await FuelLog.deleteFuelLog(req.user.sub, req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: 'Registro no encontrado' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[GARAGE] deleteFuel error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── GASTOS ───────────────────────────────────────────────────────────────────

/**
 * @brief Retorna el historial de gastos con totales anuales por categoría.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: { logs, totals, year_total, cost_per_km }
 */
const getExpenses = async (req, res) => {
  try {
    const [logs, { totals, year_total, cost_per_km }] = await Promise.all([
      ExpenseLog.getExpenses(req.user.sub),
      ExpenseLog.getExpenseTotals(req.user.sub),
    ]);
    return res.status(200).json({ logs, totals, year_total, cost_per_km });
  } catch (err) {
    console.error('[GARAGE] getExpenses error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Registra un nuevo gasto.
 *
 * @param {import('express').Request}  req
 *   body: { category, amount, description?, logged_at? }
 * @param {import('express').Response} res  201: gasto creado | 400: categoría inválida o amount faltante
 */
const addExpense = async (req, res) => {
  const { category, amount, description, logged_at } = req.body ?? {};

  if (!category || !ExpenseLog.VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      message: `Categoría inválida. Valores válidos: ${ExpenseLog.VALID_CATEGORIES.join(', ')}`,
    });
  }

  if (amount == null || isNaN(Number(amount))) {
    return res.status(400).json({ message: 'El campo amount es requerido y debe ser numérico' });
  }

  try {
    const moto    = await _getPrimaryMoto(req.user.sub);
    const expense = await ExpenseLog.addExpense(
      req.user.sub,
      moto?.id ?? null,
      { category, amount: Number(amount), description, logged_at },
    );
    return res.status(201).json(expense);
  } catch (err) {
    console.error('[GARAGE] addExpense error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Elimina un gasto por ID.
 *
 * @param {import('express').Request}  req  params.id: UUID del gasto
 * @param {import('express').Response} res  200: { ok: true } | 404: no encontrado
 */
const deleteExpense = async (req, res) => {
  try {
    const deleted = await ExpenseLog.deleteExpense(req.user.sub, req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: 'Gasto no encontrado' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[GARAGE] deleteExpense error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── SCORE Y AGENDA ───────────────────────────────────────────────────────────

/**
 * @brief Calcula el score de salud del vehículo (0–100) con sus indicadores.
 *
 * PROPÓSITO: dar al usuario un número resumen del estado general de su moto
 * basado en documentos vigentes y mantenimientos al día. El score facilita
 * gamificación ("mantén tu score en verde") y alertas de deterioro.
 *
 * ALGORITMO:
 *   Documentos (2 pts por tipo, 3 tipos = 6 pts máx):
 *     VIGENTE = 2 pts | PROXIMO_A_VENCER = 1 pt | VENCIDO/SIN_FECHA = 0 pts
 *   Mantenimientos (1 pt por tipo ACTIVO — el usuario elige cuáles vigilar,
 *   así que el máximo varía según cuántos tenga activos):
 *     progress < 75% = 1 pt | 75–99% = 0.5 pts | 100% = 0 pts
 *   score = round(((docPts + maintPts) / (docMax + maintMax)) * 100)
 *   Los ítems de mantenimiento con active=false no puntúan ni aparecen
 *   en indicators — el usuario los sacó de vigilancia a propósito.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 *   200: { score: number, indicators: [{ key, label, status, detail }] }
 */
const getScore = async (req, res) => {
  try {
    const moto = await _getPrimaryMoto(req.user.sub);

    const [docs, maintenance] = await Promise.all([
      GarageDocument.getDocuments(req.user.sub),
      MaintenanceRecord.getRecords(req.user.sub, moto?.current_odometer_km ?? null),
    ]);

    const indicators = [];
    let docPts  = 0;
    let maintPts = 0;

    // ── Puntuación de documentos ──────────────────────────────────────────────
    // Los 3 tipos se evalúan siempre. Si el usuario no tiene el documento guardado,
    // es como SIN_FECHA (0 pts).
    const DOC_TYPES = ['SOAT', 'TECNO', 'LIC_CONDUCCION'];
    const DOC_LABELS = {
      SOAT:           'SOAT',
      TECNO:          'Tecnomecánica',
      LIC_CONDUCCION: 'Licencia de conducción',
    };

    const docByType = new Map(docs.map((d) => [d.type, d]));

    for (const type of DOC_TYPES) {
      const doc    = docByType.get(type);
      const status = doc?.status ?? 'SIN_FECHA';
      let pts  = 0;
      let color = 'red';
      let detail = 'Sin información';

      if (status === 'VIGENTE') {
        pts   = 2; color = 'green';
        detail = `Vence en ${doc.days_remaining} días`;
      } else if (status === 'PROXIMO_A_VENCER') {
        pts   = 1; color = 'yellow';
        detail = `Vence en ${doc.days_remaining} días`;
      } else if (status === 'VENCIDO') {
        pts   = 0; color = 'red';
        detail = `Venció hace ${Math.abs(doc.days_remaining)} días`;
      } else {
        pts   = 0; color = 'red';
        detail = 'Sin fecha de vencimiento';
      }

      docPts += pts;
      indicators.push({ key: type, label: DOC_LABELS[type], status: color, detail });
    }

    // ── Puntuación de mantenimientos ──────────────────────────────────────────
    // Los ítems que el usuario desactivó (active=false) no puntúan ni se
    // muestran — están fuera de lo que decidió vigilar.
    let activeMaintCount = 0;
    for (const rec of maintenance) {
      if (rec.active === false) continue;
      activeMaintCount += 1;

      let pts  = 0;
      let color = 'red';
      let detail = 'Sin registro';

      if (rec.progress_pct < 75) {
        pts   = 1; color = 'green';
        const rem = rec.km_remaining != null
          ? `${rec.km_remaining} km restantes`
          : `${rec.days_remaining} días restantes`;
        detail = rem;
      } else if (rec.progress_pct < 100) {
        pts   = 0.5; color = 'yellow';
        const rem = rec.km_remaining != null
          ? `${rec.km_remaining} km restantes`
          : `${rec.days_remaining} días restantes`;
        detail = `Próximo: ${rem}`;
      } else {
        pts   = 0; color = 'red';
        detail = 'Mantenimiento vencido';
      }

      maintPts += pts;
      indicators.push({ key: rec.type, label: rec.label, status: color, detail });
    }

    // Denominador dinámico: el máximo de mantenimiento depende de cuántos
    // ítems el usuario dejó activos (puede ser 0 si desactivó todos).
    const maxPts = DOC_TYPES.length * 2 + activeMaintCount * 1;
    const score  = maxPts > 0 ? Math.round(((docPts + maintPts) / maxPts) * 100) : 0;

    return res.status(200).json({ score, indicators });
  } catch (err) {
    console.error('[GARAGE] getScore error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna los próximos eventos del vehículo ordenados por urgencia.
 *
 * PROPÓSITO: concentrar en una sola vista todos los eventos pendientes:
 * vencimientos de documentos y mantenimientos próximos. Permite que el usuario
 * revise su "agenda" sin tener que explorar cada sección por separado.
 *
 * LÓGICA DE INCLUSIÓN:
 *   Documentos: incluir si days_remaining <= 60 (dentro de 2 meses) o ya vencido.
 *   Mantenimientos: incluir si km_remaining <= 500 o days_remaining <= 30.
 *   Si el documento no tiene fecha, se incluye con days_until = null.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 *   200: [{ date, title, type, days_until, icon }] ordenado por days_until ASC
 */
const getAgenda = async (req, res) => {
  try {
    const moto = await _getPrimaryMoto(req.user.sub);

    const [docs, maintenance] = await Promise.all([
      GarageDocument.getDocuments(req.user.sub),
      MaintenanceRecord.getRecords(req.user.sub, moto?.current_odometer_km ?? null),
    ]);

    const events = [];

    // ── Eventos de documentos ─────────────────────────────────────────────────
    const DOC_ICONS = {
      SOAT:           'shield',
      TECNO:          'wrench',
      LIC_CONDUCCION: 'id-card',
    };
    const DOC_LABELS = {
      SOAT:           'SOAT',
      TECNO:          'Tecnomecánica',
      LIC_CONDUCCION: 'Licencia de conducción',
    };

    for (const doc of docs) {
      // Incluir si vence en ≤60 días, ya venció o no tiene fecha
      if (doc.days_remaining == null || doc.days_remaining <= 60) {
        events.push({
          date:      doc.expires_at ? new Date(doc.expires_at).toISOString() : null,
          title:     `Vencimiento ${DOC_LABELS[doc.type] ?? doc.type}`,
          type:      'document',
          days_until: doc.days_remaining,
          icon:      DOC_ICONS[doc.type] ?? 'file',
        });
      }
    }

    // ── Eventos de mantenimiento ──────────────────────────────────────────────
    // Ítems desactivados por el usuario no generan recordatorios de agenda.
    for (const rec of maintenance) {
      if (rec.active === false) continue;

      const nearByKm   = rec.km_remaining   != null && rec.km_remaining   <= 500;
      const nearByDays = rec.days_remaining != null && rec.days_remaining <= 30;
      const overdue    = rec.progress_pct >= 100;

      if (nearByKm || nearByDays || overdue) {
        // Construir la fecha estimada solo para ítems days-based
        let estimatedDate = null;
        if (rec.days_remaining != null && rec.last_done_at) {
          const d = new Date(rec.last_done_at);
          d.setDate(d.getDate() + (rec.interval_days ?? 0));
          estimatedDate = d.toISOString();
        }

        // days_until: para km-based no hay fecha fija, se devuelve null
        const days_until = rec.days_remaining ?? null;

        events.push({
          date:      estimatedDate,
          title:     `Mantenimiento: ${rec.label}`,
          type:      'maintenance',
          days_until,
          icon:      'tool',
        });
      }
    }

    // Ordenar: eventos con fecha primero (ASC), sin fecha al final
    events.sort((a, b) => {
      if (a.days_until == null && b.days_until == null) return 0;
      if (a.days_until == null) return 1;
      if (b.days_until == null) return -1;
      return a.days_until - b.days_until;
    });

    return res.status(200).json(events);
  } catch (err) {
    console.error('[GARAGE] getAgenda error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── ODÓMETRO ─────────────────────────────────────────────────────────────────

/**
 * @brief Actualiza manualmente el odómetro de la moto primaria del usuario.
 *
 * PROPÓSITO: permitir al usuario ingresar la lectura del cuentakilómetros
 * directamente, sin pasar por un fill-up. Útil al registrar la moto por
 * primera vez o después de una reparación sin carga de combustible.
 *
 * @param {import('express').Request}  req  body: { odometer_km }
 * @param {import('express').Response} res  200: { odometer_km } | 400: valor inválido | 404: sin moto
 */
const updateOdometer = async (req, res) => {
  const { odometer_km } = req.body ?? {};

  if (odometer_km == null || isNaN(Number(odometer_km)) || Number(odometer_km) < 0) {
    return res.status(400).json({ message: 'odometer_km debe ser un número entero positivo' });
  }

  try {
    const { rows } = await getPool().query(
      `UPDATE motos
       SET current_odometer_km = $1
       WHERE user_id = $2
       RETURNING current_odometer_km`,
      [Math.round(Number(odometer_km)), req.user.sub],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'No se encontró moto para este usuario' });
    }

    return res.status(200).json({ odometer_km: rows[0].current_odometer_km });
  } catch (err) {
    console.error('[GARAGE] updateOdometer error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = {
  getDocuments,
  upsertDocument,
  getMaintenance,
  upsertMaintenance,
  setMaintenanceActive,
  getFuel,
  addFuel,
  deleteFuel,
  getExpenses,
  addExpense,
  deleteExpense,
  getScore,
  getAgenda,
  updateOdometer,
};


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — garageController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Controlador central del módulo Garage. Coordina 4 modelos (GarageDocument,
   MaintenanceRecord, FuelLog, ExpenseLog) y calcula dos vistas derivadas:
   el score de salud del vehículo y la agenda de eventos próximos.
   Todas las funciones son async y usan req.user.sub como identificador del usuario.

   PSEUDOCÓDIGO:
     getScore(req, res):
       docs = GarageDocument.getDocuments(userId)
       maintenance = MaintenanceRecord.getRecords(userId, odómetro)
       para cada doc: calcular pts (0/1/2) y color según status
       para cada maint: calcular pts (0/0.5/1) y color según progress_pct
       score = round(((docPts + maintPts) / 20) * 100)
       return { score, indicators }

     getAgenda(req, res):
       docs + maintenance en paralelo
       filtrar docs con days_remaining ≤ 60
       filtrar maintenance con km_remaining ≤ 500 o days_remaining ≤ 30
       ordenar por days_until ASC (null al final)
       return events[]

   DIAGRAMA MENTAL:
     [routes/garage.js] → authenticate()
       ↓
     [garageController.js]
       ├─ _getPrimaryMoto() ← getPool() directo
       ├─ GarageDocument.*
       ├─ MaintenanceRecord.*
       ├─ FuelLog.*
       └─ ExpenseLog.*

   MEJORAS SUGERIDAS:
   - _getPrimaryMoto() debería soportar selección de moto activa por query param.
   - getScore() podría cachear el resultado en Redis por 5 min (costo de cálculo bajo).
   - getAgenda() podría incluir recordatorios de documentos por campo reminders[].

   DEUDA TÉCNICA:
   - El score pesa igual documentos y mantenimientos (50/50).
     En una versión posterior, el SOAT podría valer más que la garantía.

   ═══════════════════════════════════════════════════════════ */
