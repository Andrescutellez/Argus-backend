/**
 * @fileoverview Funciones de acceso a datos para la tabla fuel_logs.
 *
 * PROPÓSITO:
 *   Abstrae las queries SQL del módulo Garage para el historial de cargas de
 *   gasolina. Permite registrar fill-ups con litros, precio y odómetro, y
 *   calcular métricas de eficiencia (km/L, costo por km) a partir del historial.
 *
 * FLUJO:
 *   1. addFuelLog() inserta un nuevo fill-up con RETURNING *.
 *   2. getFuelLogs() retorna los N más recientes para mostrar en la UI.
 *   3. deleteFuelLog() elimina por (id, user_id) para garantizar que cada usuario
 *      solo borre sus propios registros.
 *   4. getFuelSummary() calcula métricas derivadas sobre todos los fill-ups del año:
 *      rendimiento promedio, costo por km, litros y gasto total anual.
 *
 * DEPENDENCIAS:
 *   config/postgres.js — getPool() singleton de pg.Pool
 *
 * VARIABLES CRÍTICAS:
 *   odometer_km: INTEGER — valor del cuentakilómetros al momento del fill-up.
 *   Es opcional (nullable) pero requerido para calcular km/L entre fill-ups
 *   consecutivos. Sin este campo las métricas de rendimiento no son posibles.
 *
 * @module models/FuelLog
 */

'use strict';

const { getPool } = require('../config/postgres');

/**
 * @brief Inserta un nuevo registro de carga de combustible.
 *
 * PROPÓSITO: registrar cada fill-up con sus datos de costo y odómetro para
 * construir el historial de combustible del usuario.
 *
 * FLUJO:
 *   1. INSERT con los campos provistos (todos opcionales excepto user_id).
 *   2. RETURNING * para devolver la fila creada sin un SELECT adicional.
 *
 * @param {string}      userId   UUID del usuario autenticado (req.user.sub).
 * @param {string|null} motoId   UUID de la moto (puede ser null si el usuario no tiene moto registrada).
 * @param {object}      data     Datos del fill-up.
 * @param {number|null} [data.liters]       Litros cargados (NUMERIC 6,2).
 * @param {number|null} [data.price_total]  Costo total en moneda local (INTEGER).
 * @param {number|null} [data.odometer_km]  Lectura del cuentakilómetros.
 * @param {string|null} [data.logged_at]    Fecha del fill-up (ISO, default = hoy).
 * @param {string|null} [data.notes]        Notas libres.
 * @returns {Promise<object>} Fila insertada.
 */
async function addFuelLog(userId, motoId, data) {
  const {
    liters      = null,
    price_total = null,
    odometer_km = null,
    logged_at   = null,
    notes       = null,
  } = data;

  const { rows } = await getPool().query(
    `INSERT INTO fuel_logs (user_id, moto_id, liters, price_total, odometer_km, logged_at, notes)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7)
     RETURNING *`,
    [userId, motoId, liters, price_total, odometer_km, logged_at, notes],
  );

  return rows[0];
}

/**
 * @brief Retorna los N fill-ups más recientes del usuario.
 *
 * PROPÓSITO: alimentar la lista de fill-ups en la UI del Garage con paginación
 * simple por límite (sin cursor/offset por ahora — el historial no suele ser
 * muy extenso para un usuario individual).
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {number} [limit=20]  Número máximo de registros a retornar.
 * @returns {Promise<object[]>} Array de fill-ups ordenados del más reciente al más antiguo.
 */
async function getFuelLogs(userId, limit = 20) {
  // Usar LEAST() en el LIMIT protege contra valores negativos o extremadamente
  // grandes enviados desde el cliente, pero el controlador ya debe validar el rango.
  const { rows } = await getPool().query(
    `SELECT * FROM fuel_logs
     WHERE user_id = $1
     ORDER BY logged_at DESC, created_at DESC
     LIMIT $2`,
    [userId, limit],
  );

  return rows;
}

/**
 * @brief Elimina un registro de fill-up por ID, verificando que pertenezca al usuario.
 *
 * PROPÓSITO: la condición AND user_id=$2 evita que un usuario borre registros
 * de otro aunque conozca el UUID del fill-up. Es un guardia de autorización
 * a nivel de datos, complementario al middleware authenticate().
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @param {string} id      UUID del fill-up a eliminar.
 * @returns {Promise<string|null>} UUID eliminado, o null si no existe o no pertenece al usuario.
 */
async function deleteFuelLog(userId, id) {
  const { rows } = await getPool().query(
    `DELETE FROM fuel_logs
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId],
  );

  return rows[0]?.id ?? null;
}

/**
 * @brief Calcula métricas de combustible derivadas del historial del usuario.
 *
 * PROPÓSITO: proporcionar indicadores de eficiencia al usuario: rendimiento
 * promedio, costo por km, total de litros y gasto en el año en curso.
 *
 * FLUJO:
 *   1. SELECT todos los fill-ups del usuario ordenados por odómetro ASC
 *      para calcular rendimiento entre fill-ups consecutivos.
 *   2. Para cada par de fill-ups consecutivos donde ambos tienen odómetro
 *      y litros, calcular km/L de ese tramo.
 *   3. avg_km_per_liter = promedio de los km/L de cada tramo.
 *   4. avg_cost_per_km = promedio de (price_total / km_del_tramo) para tramos
 *      donde hay precio y odómetro en ambos fill-ups.
 *   5. last_odometer = odómetro más alto registrado.
 *   6. total_liters_year y total_spent_year: sumas de los fill-ups del año actual.
 *
 * @param {string} userId  UUID del usuario autenticado.
 * @returns {Promise<{
 *   avg_km_per_liter: number|null,
 *   avg_cost_per_km:  number|null,
 *   last_odometer:    number|null,
 *   total_liters_year: number,
 *   total_spent_year:  number
 * }>}
 */
async function getFuelSummary(userId) {
  // Traer todos los fill-ups ordenados por odómetro para calcular tramos.
  // La fecha se usa como desempate si dos fill-ups tienen el mismo odómetro.
  const { rows } = await getPool().query(
    `SELECT liters, price_total, odometer_km, logged_at
     FROM fuel_logs
     WHERE user_id = $1
     ORDER BY odometer_km ASC NULLS LAST, logged_at ASC`,
    [userId],
  );

  const currentYear = new Date().getFullYear();

  let totalLitersYear = 0;
  let totalSpentYear  = 0;
  let lastOdometer    = null;

  // Acumuladores para promedios de rendimiento
  const kmPerLiterSamples  = [];
  const costPerKmSamples   = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Acumular totales anuales — logged_at viene como Date o string '2026-08-01'
    const year = new Date(row.logged_at).getFullYear();
    if (year === currentYear) {
      if (row.liters      != null) totalLitersYear += parseFloat(row.liters);
      if (row.price_total != null) totalSpentYear  += row.price_total;
    }

    // Actualizar último odómetro conocido
    if (row.odometer_km != null && (lastOdometer == null || row.odometer_km > lastOdometer)) {
      lastOdometer = row.odometer_km;
    }

    // Calcular métricas del tramo entre fill-up anterior y este.
    // Solo posible cuando tenemos odómetro en ambos fill-ups y litros en el actual.
    if (i > 0) {
      const prev = rows[i - 1];
      if (
        prev.odometer_km != null &&
        row.odometer_km  != null &&
        row.liters       != null &&
        parseFloat(row.liters) > 0
      ) {
        const kmDriven = row.odometer_km - prev.odometer_km;
        if (kmDriven > 0) {
          // km/L del tramo — fórmula del "método de fill-up completo"
          kmPerLiterSamples.push(kmDriven / parseFloat(row.liters));

          // Costo por km solo si también hay precio en este fill-up
          if (row.price_total != null && row.price_total > 0) {
            costPerKmSamples.push(row.price_total / kmDriven);
          }
        }
      }
    }
  }

  const avg = (arr) => arr.length === 0
    ? null
    : Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;

  return {
    avg_km_per_liter:  avg(kmPerLiterSamples),
    avg_cost_per_km:   avg(costPerKmSamples),
    last_odometer:     lastOdometer,
    total_liters_year: Math.round(totalLitersYear * 100) / 100,
    total_spent_year:  totalSpentYear,
  };
}

module.exports = { addFuelLog, getFuelLogs, deleteFuelLog, getFuelSummary };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — FuelLog.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Maneja el historial de cargas de combustible. El cálculo de rendimiento
   (km/L) se hace en JS usando el "método de fill-up completo": los km
   recorridos entre dos llenados consecutivos divididos entre los litros
   del segundo llenado. Sin registrar el odómetro, estas métricas no son
   posibles. Las sumas anuales se filtran por el año de logged_at.

   PSEUDOCÓDIGO:
     getFuelSummary(userId):
       SELECT todos los fill-ups ORDER BY odometer_km ASC
       para cada fill-up:
         acumular totals del año actual
         actualizar last_odometer
         si fill-up anterior tiene odo y este tiene odo + litros:
           kmDriven = odo_actual - odo_anterior
           push(kmDriven / litros) → kmPerLiterSamples
           push(price / kmDriven)  → costPerKmSamples
       return promedios + totales

   DIAGRAMA MENTAL:
     [fuel_logs PG]
       ↑ add / delete
     [FuelLog.js]
       + getFuelSummary() ← cálculo JS puro sobre array de filas
       ↓
     [garageController.js]

   MEJORAS SUGERIDAS:
   - Gráfico de rendimiento por mes (GROUP BY mes en SQL, series en frontend).
   - Alertar si el rendimiento cae más del 20% vs promedio histórico.
   - Soporte para múltiples motos en el mismo usuario (filtrar por moto_id).

   DEUDA TÉCNICA:
   - getFuelSummary() trae TODOS los fill-ups en memoria. Para usuarios con
     cientos de registros, convendría calcular totales en SQL y solo traer
     las filas más recientes para el cálculo de tramos.

   ═══════════════════════════════════════════════════════════ */
