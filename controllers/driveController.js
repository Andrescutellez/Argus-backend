/**
 * @fileoverview Controlador REST para métricas de conducción del sistema Argus.
 *
 * PROPÓSITO:
 *   Servir a la pantalla de Conducción de la app Flutter y la web-usuario con
 *   estadísticas de estilo de manejo derivadas de los frames DRIVE enviados
 *   por el MPU6050 del ESP32. Cada "sesión" en el sistema es un documento
 *   DriveMetrics (una ventana de ~30s del GPS del PREMIUM).
 *
 * ENDPOINTS EXPUESTOS:
 *   GET /api/drive/metrics/:deviceId?days=7
 *     → Agrega las muestras del período y retorna:
 *       - score 0-100 (cuantificación de la agresividad de conducción)
 *       - stats globales (hard, soft, peakAccel, peakGyro, sessionCount)
 *       - breakdown diario para gráficos de tendencia
 *       - array de sesiones raw para tabla de historial
 *
 * ALGORITMO DE SCORE:
 *   Base 100. Se descuenta según agresividad:
 *     - Cada hard event: -5 puntos (cap: -50)
 *     - Cada soft event: -0.5 puntos (cap: -10)
 *     - peakAccelDev > 1.0g (impacto severo): -15
 *     - peakAccelDev > 0.5g (frenada fuerte): -8
 *   Score = max(0, 100 - descuentos)
 *   Un score de 100 = conducción suave todo el período.
 *   Un score < 50 = conducción agresiva o incidentes frecuentes.
 *
 * @module controllers/driveController
 */

'use strict';

const DriveMetrics = require('../models/DriveMetrics');

// ─── CONSTANTES DE SCORING ────────────────────────────────────────────────────

// Penalización por cada evento HARD (frenada brusca o impacto).
// 5 eventos hard → -25 puntos. Es el factor más impactante del score.
const PENALTY_PER_HARD = 5;

// Penalización máxima acumulable por eventos hard.
// Evita que un día muy malo (20+ hard events) lleve el score a 0 por accel solo.
const MAX_HARD_PENALTY = 50;

// Penalización por cada evento SOFT (movimiento suave pero detectable).
// Su impacto es menor porque el soft es la conducción urbana normal.
const PENALTY_PER_SOFT = 0.5;

// Penalización máxima por soft events.
const MAX_SOFT_PENALTY = 10;

// Umbral de aceleración pico que se considera impacto severo (caída, choque, tope de velocidad).
const ACCEL_SEVERE_THRESHOLD = 1.0; // g

// Umbral de aceleración pico que se considera maniobra agresiva (frenada de emergencia).
const ACCEL_HARD_THRESHOLD = 0.5; // g

// ─── FUNCIÓN DE SCORE ─────────────────────────────────────────────────────────

/**
 * @brief Calcula el score de conducción (0-100) dado un conjunto de métricas agregadas.
 *
 * PROPÓSITO:
 *   Traducir métricas técnicas del MPU6050 en un número comprensible por el
 *   usuario final. 100 = conducción impecable. <50 = estilo de manejo agresivo.
 *   Se diseñó para ser interpretable sin contexto técnico.
 *
 * FLUJO LÓGICO:
 *   1. Iniciar en 100 puntos.
 *   2. Descontar por hard events (capped en MAX_HARD_PENALTY).
 *   3. Descontar por soft events (capped en MAX_SOFT_PENALTY).
 *   4. Descontar por pico de aceleración si supera umbrales.
 *   5. Clamp final a [0, 100].
 *
 * @param {number} totalHard - Total de eventos HARD en el período.
 * @param {number} totalSoft - Total de eventos SOFT en el período.
 * @param {number} maxAccel  - Pico máximo de desviación de 1g en el período (g).
 * @returns {number} — Score redondeado [0, 100].
 */
function computeScore(totalHard, totalSoft, maxAccel) {
  let penalty = 0;

  // Hard events son el mayor indicador de conducción agresiva.
  penalty += Math.min(totalHard * PENALTY_PER_HARD, MAX_HARD_PENALTY);

  // Soft events tienen impacto menor: conducción urbana genera muchos soft events.
  penalty += Math.min(totalSoft * PENALTY_PER_SOFT, MAX_SOFT_PENALTY);

  // El pico de aceleración global es independiente de los contadores:
  // un único impacto severo debería bajar el score aunque los contadores sean bajos.
  if (maxAccel >= ACCEL_SEVERE_THRESHOLD) {
    penalty += 15; // Impacto severo (caída, choque, tope)
  } else if (maxAccel >= ACCEL_HARD_THRESHOLD) {
    penalty += 8;  // Frenada de emergencia o aceleración brusca
  }

  return Math.max(0, Math.round(100 - penalty));
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

/**
 * @brief Retorna métricas de conducción agregadas para el período solicitado.
 *
 * PROPÓSITO:
 *   Endpoint principal de la pantalla "Conducción". Recibe el deviceId y un
 *   parámetro opcional `days` (default 7) y devuelve todo lo necesario para
 *   renderizar el score, las estadísticas globales y el gráfico de tendencia diaria.
 *
 * FLUJO LÓGICO:
 *   1. Parsear y validar deviceId y days.
 *   2. Construir fecha de inicio del período.
 *   3. Fetch de todos los documentos DriveMetrics del período (sin limit por ahora:
 *      30s × 3600s/h × ~8h de conducción = ~960 docs/día × 7 días = ~6720 docs max).
 *   4. Si no hay datos, retornar 200 con score 100 y arrays vacíos.
 *   5. Computar estadísticas globales (totales, máximos).
 *   6. Agrupar por fecha para el breakdown diario del gráfico.
 *   7. Calcular score global del período.
 *   8. Retornar objeto de respuesta completo.
 *
 * DEPENDENCIAS:
 *   - DriveMetrics (models/DriveMetrics.js)
 *   - computeScore(): función local de scoring
 *
 * POSIBLES MEJORAS (senior):
 *   - Reemplazar el fetch + agregación en JS por un pipeline $aggregate de MongoDB
 *     para reducir el payload de red entre BD y servidor (solo importa para fleets grandes).
 *   - Agregar autenticación JWT para verificar que el usuario tiene acceso al deviceId.
 *   - Cachear la respuesta por 5 minutos (el ESP32 actualiza cada 30s, no tiene sentido
 *     recalcular en cada request del frontend mientras el usuario mira la pantalla).
 *   - Exponer `days` máximo de 90 para vista mensual; actualmente no hay cap.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 *
 * @note El score se calcula sobre el período COMPLETO, no como promedio de scores diarios.
 *   Esto evita que un único día muy malo se diluya con días sin actividad (hardCount=0).
 */
async function getMetrics(req, res) {
  const { deviceId } = req.params;
  const days = Math.min(parseInt(req.query.days, 10) || 7, 365);

  if (!deviceId || !deviceId.trim()) {
    return res.status(400).json({ message: 'deviceId es requerido' });
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  // Inicio del día para que el breakdown diario incluya el día completo de inicio.
  startDate.setHours(0, 0, 0, 0);

  let sessions;
  try {
    sessions = await DriveMetrics
      .find({ deviceId: deviceId.trim(), timestamp: { $gte: startDate } })
      .sort({ timestamp: 1 }) // Ascendente para que el breakdown diario quede ordenado
      .lean();                // lean() evita la hidratación de documentos Mongoose: más rápido para lectura
  } catch (err) {
    return res.status(500).json({ message: 'Error al consultar métricas', error: err.message });
  }

  // Sin datos: score perfecto, arrays vacíos. El frontend debe mostrar "Sin actividad"
  // en lugar de gráficos vacíos con score 0 (que confundiría al usuario).
  if (sessions.length === 0) {
    return res.status(200).json({
      deviceId,
      period: { days, from: startDate.toISOString(), to: new Date().toISOString() },
      score: 100,
      stats: {
        sessionCount: 0,
        totalHardEvents: 0,
        totalSoftEvents: 0,
        maxPeakAccelDev: 0,
        maxPeakGyroMag: 0,
      },
      dailyBreakdown: [],
      sessions: [],
    });
  }

  // ── Estadísticas globales del período ────────────────────────────────────────
  let totalHard = 0;
  let totalSoft = 0;
  let maxAccel = 0;
  let maxGyro = 0;

  // Acumulación en un solo pass por el array: O(n) en lugar de múltiples reduce().
  for (const s of sessions) {
    totalHard += s.hardCount;
    totalSoft += s.softCount;
    if (s.peakAccelDev > maxAccel) maxAccel = s.peakAccelDev;
    if (s.peakGyroMag  > maxGyro)  maxGyro  = s.peakGyroMag;
  }

  const score = computeScore(totalHard, totalSoft, maxAccel);

  // ── Breakdown diario (para gráfico de tendencia) ──────────────────────────
  // Agrupa los documentos por fecha "YYYY-MM-DD" y calcula score por día.
  // La app puede renderizar esto como un gráfico de barras de 7 días.
  const dayMap = new Map();

  for (const s of sessions) {
    // toISOString() → "2026-06-16T12:34:56.789Z" → slice(0,10) → "2026-06-16"
    const dateKey = new Date(s.timestamp).toISOString().slice(0, 10);

    if (!dayMap.has(dateKey)) {
      dayMap.set(dateKey, { date: dateKey, hard: 0, soft: 0, maxAccel: 0, sessions: 0 });
    }

    const day = dayMap.get(dateKey);
    day.hard    += s.hardCount;
    day.soft    += s.softCount;
    day.sessions += 1;
    if (s.peakAccelDev > day.maxAccel) day.maxAccel = s.peakAccelDev;
  }

  const dailyBreakdown = Array.from(dayMap.values()).map((d) => ({
    date: d.date,
    score: computeScore(d.hard, d.soft, d.maxAccel),
    hardCount: d.hard,
    softCount: d.soft,
    sessionCount: d.sessions,
    maxPeakAccelDev: parseFloat(d.maxAccel.toFixed(4)),
  }));

  // Formato de las sesiones raw: omitir campos internos de Mongoose (__v, createdAt)
  // y redondear los floats para no enviar 8 decimales innecesarios.
  const formattedSessions = sessions.map((s) => ({
    id: s._id,
    lat: s.lat,
    lon: s.lon,
    peakAccelDev: parseFloat(s.peakAccelDev.toFixed(4)),
    peakGyroMag:  parseFloat(s.peakGyroMag.toFixed(2)),
    hardCount: s.hardCount,
    softCount: s.softCount,
    timestamp: s.timestamp,
  }));

  return res.status(200).json({
    deviceId,
    period: {
      days,
      from: startDate.toISOString(),
      to:   new Date().toISOString(),
    },
    score,
    stats: {
      sessionCount:     sessions.length,
      totalHardEvents:  totalHard,
      totalSoftEvents:  totalSoft,
      maxPeakAccelDev:  parseFloat(maxAccel.toFixed(4)),
      maxPeakGyroMag:   parseFloat(maxGyro.toFixed(2)),
    },
    dailyBreakdown,
    sessions: formattedSessions,
  });
}

module.exports = { getMetrics };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — controllers/driveController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador lee de MongoDB todos los datos de conducción de una moto
   en un período de tiempo (default: última semana), los resume en estadísticas,
   calcula un score de conducción del 0 al 100, y los agrupa por día para que
   la app o web pueda mostrar un gráfico de tendencia. Es como el "resumen de
   actividad" de un smartwatch, pero para la moto.

   PSEUDOCÓDIGO:
   getMetrics(deviceId, days):
     startDate = hoy - days días
     sessions = DriveMetrics.find({ deviceId, timestamp >= startDate })
     si sessions vacío → score=100, arrays vacíos
     totalHard = sum(s.hardCount para s en sessions)
     totalSoft = sum(s.softCount para s en sessions)
     maxAccel  = max(s.peakAccelDev para s en sessions)
     score = max(0, 100 - hard*5 - soft*0.5 - accelBonus)
     dailyBreakdown = agrupar sessions por día, score por día
     retornar { score, stats, dailyBreakdown, sessions }

   DIAGRAMA MENTAL:
   GET /api/drive/metrics/:deviceId?days=7
     ↓
   DriveMetrics.find() → array de ~6720 docs max
     ↓
   computeScore() → entero 0-100
   group by day   → array de 7 días
     ↓
   JSON { score, stats, dailyBreakdown, sessions }
     ↓
   App Flutter / Web Usuario (pantalla Conducción)

   VARIABLES CRÍTICAS:
   - PENALTY_PER_HARD: si se cambia sin avisar al equipo de UX, los scores
     históricos se vuelven inconsistentes con los nuevos (no hay versionado).
   - days: si el usuario puede pasar days=365 y tiene mucha actividad, la query
     podría retornar >100k docs. Agregar paginación o un agregado en MongoDB
     si la flota crece significativamente.

   DEUDA TÉCNICA:
   - Sin autenticación: cualquier cliente puede pedir métricas de cualquier deviceId.
   - Sin caché: si el usuario refresca la pantalla 10 veces, se hacen 10 queries idénticas.
   - El scoring es heurístico; debería calibrarse con datos reales de conducción.

   ═══════════════════════════════════════════════════════════ */
