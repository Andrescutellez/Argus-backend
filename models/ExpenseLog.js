/**
 * @fileoverview Funciones de acceso a datos para la tabla expense_logs.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL del módulo Garage para el registro de gastos
 *   relacionados con la moto: combustible, mantenimiento, multas, accesorios,
 *   SOAT, Tecnomecánica, etc. Calcula totales anuales y costo por km para el
 *   resumen financiero del usuario.
 *
 * FLUJO:
 *   1. addExpense() inserta un gasto nuevo con RETURNING *.
 *   2. getExpenses() retorna los N más recientes para la lista en la UI.
 *   3. deleteExpense() elimina por (id, user_id) con guardia de autorización.
 *   4. getExpenseTotals() agrega en SQL y calcula costo/km en JS con datos de fuel_logs.
 *
 * DEPENDENCIAS:
 *   config/postgres.js — getPool() singleton de pg.Pool
 *
 * VARIABLES CRÍTICAS:
 *   category: VARCHAR(15) — enum cerrado en la BD. Si se agrega una categoría
 *   nueva, se debe actualizar el CHECK constraint en la migración de postgres.js.
 *   amount: INTEGER — valor entero (pesos colombianos sin decimales).
 *
 * @module models/ExpenseLog
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Lista de todas las categorías de gasto válidas.
 *
 * PROPÓSITO: centralizar el enum para que el controlador pueda validar la
 * categoría antes de intentar el INSERT y retornar un 400 descriptivo en
 * lugar de un 500 por violación de CHECK constraint en PostgreSQL.
 *
 * RIESGO: debe mantenerse sincronizado con el CHECK constraint en postgres.js.
 * Si se agrega una categoría aquí sin agregarla en la migración SQL, el INSERT fallará.
 */
const VALID_CATEGORIES = [
  'GASOLINA', 'ACEITE', 'LAVADA', 'SOAT', 'TECNO',
  'MULTA', 'REPUESTO', 'MANTENIMIENTO', 'ACCESORIO', 'OTRO',
];

/**
 * @brief Inserta un nuevo registro de gasto.
 *
 * PROPÓSITO: registrar cualquier gasto relacionado con la moto para el
 * historial financiero del usuario.
 *
 * FLUJO:
 *   1. INSERT con los campos provistos.
 *   2. RETURNING * para devolver la fila sin SELECT adicional.
 *
 * @param {string}      userId   UUID del usuario autenticado.
 * @param {string|null} motoId   UUID de la moto (nullable).
 * @param {object}      data     Datos del gasto.
 * @param {string}      data.category     Categoría del gasto (ver VALID_CATEGORIES).
 * @param {number}      data.amount       Importe en moneda local (entero).
 * @param {string|null} [data.description]  Descripción libre.
 * @param {string|null} [data.logged_at]    Fecha del gasto (ISO, default = hoy).
 * @returns {Promise<object>} Fila insertada.
 */
async function addExpense(userId, motoId, data) {
  const {
    category,
    amount,
    description = null,
    logged_at   = null,
  } = data;

  const { rows } = await getPool().query(
    `INSERT INTO expense_logs (user_id, moto_id, category, amount, description, logged_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE))
     RETURNING *`,
    [userId, motoId, category, amount, description, logged_at],
  );

  return rows[0];
}

/**
 * @brief Retorna los N gastos más recientes del usuario.
 *
 * PROPÓSITO: alimentar la lista de gastos en la UI con paginación simple por límite.
 *
 * @param {string} userId   UUID del usuario autenticado.
 * @param {number} [limit=50]  Número máximo de registros a retornar.
 * @returns {Promise<object[]>} Array de gastos del más reciente al más antiguo.
 */
async function getExpenses(userId, limit = 50) {
  const { rows } = await getPool().query(
    `SELECT * FROM expense_logs
     WHERE user_id = $1
     ORDER BY logged_at DESC, created_at DESC
     LIMIT $2`,
    [userId, limit],
  );

  return rows;
}

/**
 * @brief Elimina un gasto por ID, verificando que pertenezca al usuario.
 *
 * PROPÓSITO: la condición AND user_id=$2 garantiza que cada usuario solo
 * pueda borrar sus propios gastos, aunque conozca el UUID del gasto ajeno.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {string} id      UUID del gasto a eliminar.
 * @returns {Promise<string|null>} UUID eliminado, o null si no existe / no pertenece al usuario.
 */
async function deleteExpense(userId, id) {
  const { rows } = await getPool().query(
    `DELETE FROM expense_logs
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId],
  );

  return rows[0]?.id ?? null;
}

/**
 * @brief Calcula totales de gasto del año en curso, agrupados por categoría.
 *
 * PROPÓSITO: proporcionar el resumen financiero anual para la UI: total gastado,
 * desglose por categoría y costo por km calculado cruzando con fuel_logs.
 *
 * FLUJO:
 *   1. Ejecutar dos queries en paralelo con Promise.all() para no bloquear:
 *      a. SUM(amount) GROUP BY category, filtrado por año actual.
 *      b. MIN y MAX de odometer_km en fuel_logs del usuario (para costo/km).
 *   2. Construir el objeto totals iterando VALID_CATEGORIES.
 *   3. Calcular year_total como suma de todos los amounts.
 *   4. cost_per_km = year_total / (max_odo - min_odo) o null si no hay odómetros.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @returns {Promise<{
 *   year_total:    number,
 *   totals:        Record<string, number>,
 *   cost_per_km:   number|null
 * }>}
 */
async function getExpenseTotals(userId) {
  const currentYear = new Date().getFullYear();

  // Ejecutar en paralelo: agregación de gastos + rango de odómetro en fuel_logs.
  // Sin Promise.all(), estas dos queries se ejecutarían secuencialmente duplicando
  // el tiempo de respuesta innecesariamente.
  const [expenseResult, odoResult] = await Promise.all([
    getPool().query(
      `SELECT category, SUM(amount)::INTEGER AS total
       FROM expense_logs
       WHERE user_id = $1
         AND EXTRACT(YEAR FROM logged_at) = $2
       GROUP BY category`,
      [userId, currentYear],
    ),
    getPool().query(
      `SELECT MIN(odometer_km) AS min_odo, MAX(odometer_km) AS max_odo
       FROM fuel_logs
       WHERE user_id = $1
         AND odometer_km IS NOT NULL`,
      [userId],
    ),
  ]);

  // Construir totals inicializados en 0 para todas las categorías.
  // Las categorías sin gastos en el año tienen total 0 (no null) para simplificar
  // la lógica en el frontend (no necesita verificar null antes de sumar).
  const totals = Object.fromEntries(VALID_CATEGORIES.map((c) => [c, 0]));
  let year_total = 0;

  for (const row of expenseResult.rows) {
    totals[row.category] = row.total ?? 0;
    year_total += row.total ?? 0;
  }

  // Costo por km: gasto anual total dividido entre los km recorridos registrados.
  // Se usan los extremos del odómetro en fuel_logs (mín y máx de todos los fill-ups),
  // no del año actual, para tener el rango más amplio y confiable.
  const { min_odo, max_odo } = odoResult.rows[0] ?? {};
  let cost_per_km = null;

  if (min_odo != null && max_odo != null && max_odo > min_odo && year_total > 0) {
    const kmRange = max_odo - min_odo;
    cost_per_km = Math.round((year_total / kmRange) * 100) / 100;
  }

  return { year_total, totals, cost_per_km };
}

module.exports = { addExpense, getExpenses, deleteExpense, getExpenseTotals, VALID_CATEGORIES };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — ExpenseLog.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Maneja todos los gastos de la moto. Permite registrar cualquier tipo de
   costo con una categoría del enum VALID_CATEGORIES. El resumen financiero
   anual se calcula con SQL (SUM/GROUP BY) y el costo por km se deriva cruzando
   con fuel_logs para obtener el rango de odómetro registrado.

   PSEUDOCÓDIGO:
     getExpenseTotals(userId):
       Promise.all([
         SELECT category, SUM(amount) GROUP BY category WHERE año = actual,
         SELECT MIN(odometer_km), MAX(odometer_km) FROM fuel_logs
       ])
       construir totals = { GASOLINA: 0, ACEITE: 0, ... }
       para cada fila de expenseResult: totals[cat] = total
       year_total = suma de totals
       si hay rango de odómetro:
         cost_per_km = year_total / (max_odo - min_odo)
       return { year_total, totals, cost_per_km }

   DIAGRAMA MENTAL:
     [expense_logs PG]        [fuel_logs PG]
       ↑ add / delete           (solo lectura de odo)
     [ExpenseLog.js]
       + getExpenseTotals() ← SQL SUM + JS costo/km
       ↓
     [garageController.js]

   MEJORAS SUGERIDAS:
   - Filtrar getExpenseTotals() por año específico (query param).
   - Gráfico de gastos por mes (GROUP BY mes en SQL).
   - Categorías personalizadas por usuario (tabla separada).

   DEUDA TÉCNICA:
   - cost_per_km usa el rango total de odómetro (no del año actual),
     lo que puede subestimar el costo si el usuario tiene fill-ups muy antiguos.

   ═══════════════════════════════════════════════════════════ */
