/**
 * @fileoverview Controlador REST para métricas de conducción — Índice de Riesgo de Conducción (IRC).
 *
 * PROPÓSITO:
 *   Servir estadísticas de conducción a la app Flutter y la web-usuario. Calcula el IRC
 *   (0–100, donde 100 = conducción impecable) basado en 4 pilares:
 *     Pilar 1 — Comportamiento (45 pts): frenadas, aceleraciones, curvas, velocidad excesiva.
 *     Pilar 2 — Contexto temporal (20 pts): conducción nocturna, hora pico, trayecto largo.
 *     Pilar 3 — Contexto geográfico (20 pts): zona ARI alta, lluvia activa.
 *     Pilar 4 — Consistencia (15 pts): frecuencia eventos/km, variabilidad entre trayectos.
 *
 * ENDPOINTS:
 *   GET /api/drive/metrics/:deviceId?days=7
 *     → IRC global, desglose por pilar, estadísticas agregadas, breakdown diario, sesiones raw,
 *       métricas de uso (hora pico, día más activo), recomendaciones personalizadas.
 *
 * UMBRALES DE CONDUCCIÓN (independientes de los umbrales de seguridad del MPU6050):
 *   Los thresholds de hardCount del firmware usan MEDIUM (0.30g) calibrado para detección de robo.
 *   Para conducción usamos peakAccelDev > DRIVE_HARD_ACCEL_G y peakGyroMag > DRIVE_HARD_GYRO_DPS
 *   como proxy de frenadas/aceleraciones/curvas agresivas — valores mucho más altos que los del firmware.
 *
 * @module controllers/driveController
 */

'use strict';

const DriveMetrics = require('../models/DriveMetrics');

// ─── UMBRALES DE CONDUCCIÓN ───────────────────────────────────────────────────

// peakAccelDev (g): desviación de 1g. Frenada/aceleración brusca real en moto.
const DRIVE_HARD_ACCEL_G   = 0.60;  // > 0.6g → evento duro de conducción
const DRIVE_MEDIUM_ACCEL_G = 0.35;  // 0.35–0.6g → evento medio (penaliza menos)

// peakGyroMag (°/s): curva agresiva o cambio brusco de dirección.
const DRIVE_HARD_GYRO_DPS  = 50.0;  // > 50°/s → curva agresiva

// Velocidad mínima para considerar un evento válido. Por debajo de este umbral,
// el MPU6050 detecta ruido (moto quieta, lavado, persona sentada) y el GPS
// salta dentro de su margen de error generando falsos positivos de curva/maniobra.
const DRIVE_MIN_SPEED_KMH      = 10;

// Velocidad configurable de exceso (km/h). En el futuro vendrá del perfil del usuario.
const DEFAULT_SPEED_LIMIT_KMH = 80;
// Penalización por km/h por encima del límite.
const PENALTY_PER_KMH_OVER    = 0.25;
const MAX_SPEED_PENALTY        = 15;

// ─── PILARES IRC ──────────────────────────────────────────────────────────────

// Pilar 1 — Comportamiento (máx 45 pts de penalización)
const P1_HARD_ACCEL_PER_EVENT = 3.0;    // frenada/aceleración dura
const P1_MEDIUM_ACCEL_PER     = 1.0;    // evento medio
const P1_CURVE_PER_EVENT      = 2.5;    // curva agresiva (gyro > 50°/s)
const P1_MAX_ACCEL             = 25;
const P1_MAX_CURVE             = 15;
const P1_MAX_SPEED             = 15;    // velocidad excesiva

// Pilar 2 — Contexto temporal (máx 20 pts)
const P2_NIGHT_PER_SESSION    = 0.5;    // sesión entre 20h–6h
const P2_MAX_NIGHT             = 10;
const P2_PEAK_PER_SESSION     = 0.3;    // sesión en hora pico (7-9h / 17-19h)
const P2_MAX_PEAK              = 5;
const P2_LONG_TRIP_MIN        = 120;    // minutos — trayecto "largo" (fatiga)
const P2_LONG_TRIP_PENALTY    = 5;

// Pilar 3 — Geográfico (máx 20 pts)
const P3_ARI_HIGH_THRESHOLD   = 65;    // ARI > 65 → zona de alto riesgo
const P3_ARI_PENALTY_PER_PCT  = 0.2;   // por cada % del tiempo en zona alta
const P3_MAX_ARI               = 15;
const P3_RAIN_PENALTY          = 5;    // si hubo lluvia durante el período

// Pilar 4 — Consistencia (máx 15 pts)
const P4_EVENTS_PER_KM_LIMIT  = 2.0;  // más de 2 eventos/km → penalización
const P4_MAX_FREQ              = 10;
const P4_MAX_VARIABILITY       = 5;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * @brief Cuenta cuántos eventos duros de CONDUCCIÓN hay en una sesión.
 * Usa umbrales más altos que el firmware (calibrado para robo, no conducción).
 */
function drivingHardEvents(session) {
  // Por debajo de DRIVE_MIN_SPEED_KMH el MPU detecta ruido (moto quieta, lavado,
  // persona sentada) y el GPS salta dentro de su margen de error — no hay maniobra real.
  if ((session.avgSpeedKmh ?? 0) < DRIVE_MIN_SPEED_KMH) return 0;
  let count = 0;
  if (session.peakAccelDev >= DRIVE_HARD_ACCEL_G)   count += 1;  // frenada/aceleración brusca
  if (session.peakGyroMag  >= DRIVE_HARD_GYRO_DPS)  count += 1;  // curva agresiva
  return count;
}

function drivingMediumEvents(session) {
  if ((session.avgSpeedKmh ?? 0) < DRIVE_MIN_SPEED_KMH) return 0;
  if (session.peakAccelDev >= DRIVE_MEDIUM_ACCEL_G && session.peakAccelDev < DRIVE_HARD_ACCEL_G) return 1;
  return 0;
}

function isCurveAggressive(session) {
  if ((session.avgSpeedKmh ?? 0) < DRIVE_MIN_SPEED_KMH) return false;
  return session.peakGyroMag >= DRIVE_HARD_GYRO_DPS;
}

function isNightSession(session) {
  const h = new Date(session.timestamp).getHours();
  return h >= 20 || h < 6;
}

function isPeakHourSession(session) {
  const h = new Date(session.timestamp).getHours();
  return (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
}

/** Desviación estándar de un array de números */
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ─── CÁLCULO IRC ─────────────────────────────────────────────────────────────

/**
 * @brief Calcula el IRC (0–100) y su desglose por pilar dado un conjunto de sesiones.
 *
 * @param {Array}  sessions   Array de documentos DriveMetrics.
 * @param {number} [speedLimit=80] Límite de velocidad configurado (km/h).
 * @returns {{ irc, pillars: { behavior, temporal, geo, consistency }, penalty }}
 */
function computeIRC(sessions, speedLimit = DEFAULT_SPEED_LIMIT_KMH) {
  if (!sessions.length) {
    return {
      irc: 100,
      pillars: { behavior: 100, temporal: 100, geo: 100, consistency: 100 },
      penalty: { p1: 0, p2: 0, p3: 0, p4: 0 },
    };
  }

  // ── Pilar 1: Comportamiento ─────────────────────────────────────────────
  let hardAccelEvents = 0;
  let mediumAccelEvents = 0;
  let curveEvents = 0;
  let maxSpeed = 0;

  for (const s of sessions) {
    hardAccelEvents   += drivingHardEvents(s);
    mediumAccelEvents += drivingMediumEvents(s);
    if (isCurveAggressive(s)) curveEvents += 1;
    if (s.maxSpeedKmh != null && s.maxSpeedKmh > maxSpeed) maxSpeed = s.maxSpeedKmh;
    else if (s.avgSpeedKmh != null && s.avgSpeedKmh > maxSpeed) maxSpeed = s.avgSpeedKmh;
  }

  let p1 = 0;
  p1 += Math.min(hardAccelEvents   * P1_HARD_ACCEL_PER_EVENT, P1_MAX_ACCEL);
  p1 += Math.min(mediumAccelEvents * P1_MEDIUM_ACCEL_PER,     P1_MAX_ACCEL * 0.3);
  p1 += Math.min(curveEvents       * P1_CURVE_PER_EVENT,      P1_MAX_CURVE);
  if (maxSpeed > speedLimit) {
    p1 += Math.min((maxSpeed - speedLimit) * PENALTY_PER_KMH_OVER, P1_MAX_SPEED);
  }
  p1 = Math.min(p1, 45);

  // ── Pilar 2: Contexto temporal ──────────────────────────────────────────
  const nightSessions = sessions.filter(isNightSession).length;
  const peakSessions  = sessions.filter(isPeakHourSession).length;

  let p2 = 0;
  p2 += Math.min(nightSessions * P2_NIGHT_PER_SESSION, P2_MAX_NIGHT);
  p2 += Math.min(peakSessions  * P2_PEAK_PER_SESSION,  P2_MAX_PEAK);
  // Trayecto largo: penalizar si hay sesiones continuas > 2h
  // (detectamos gap < 5min como continuidad, mismo que la UI)
  const sorted = [...sessions].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let   longestTripMin = 0;
  let   tripStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 60000;
    if (gap > 30) { tripStart = sorted[i]; continue; }
    const dur = (new Date(sorted[i].timestamp) - new Date(tripStart.timestamp)) / 60000;
    if (dur > longestTripMin) longestTripMin = dur;
  }
  if (longestTripMin > P2_LONG_TRIP_MIN) p2 += P2_LONG_TRIP_PENALTY;
  p2 = Math.min(p2, 20);

  // ── Pilar 3: Geográfico ─────────────────────────────────────────────────
  // El ARI está disponible a nivel de trayecto en el futuro; por ahora se pasa
  // como parámetro externo (0 si no disponible).
  // Se inicializa en 0 y se puede enriquecer desde el caller.
  const p3 = 0; // se calcula externamente en getMetrics() si hay datos ARI

  // ── Pilar 4: Consistencia ───────────────────────────────────────────────
  const totalDistKm = sessions.reduce((s, x) => s + (x.distanceM || 0), 0) / 1000;
  const totalHardDriving = hardAccelEvents + curveEvents;
  let p4 = 0;
  if (totalDistKm > 0) {
    const eventsPerKm = totalHardDriving / totalDistKm;
    if (eventsPerKm > P4_EVENTS_PER_KM_LIMIT) {
      p4 += Math.min((eventsPerKm - P4_EVENTS_PER_KM_LIMIT) * 3, P4_MAX_FREQ);
    }
  }
  // Variabilidad: desv. estándar de peakAccelDev por sesión
  const accelPerSession = sessions.map(s => s.peakAccelDev || 0);
  const variability = stdDev(accelPerSession);
  p4 += Math.min(variability * 5, P4_MAX_VARIABILITY);
  p4 = Math.min(p4, 15);

  const totalPenalty = p1 + p2 + p3 + p4;
  const irc = Math.max(0, Math.round(100 - totalPenalty));

  // Puntajes individuales por pilar (0–100 dentro de su peso)
  const pillarBehavior    = Math.round(100 - (p1 / 45) * 100);
  const pillarTemporal    = Math.round(100 - (p2 / 20) * 100);
  const pillarGeo         = Math.round(100 - (p3 / 20) * 100);
  const pillarConsistency = Math.round(100 - (p4 / 15) * 100);

  return {
    irc,
    pillars: {
      behavior:    Math.max(0, pillarBehavior),
      temporal:    Math.max(0, pillarTemporal),
      geo:         Math.max(0, pillarGeo),
      consistency: Math.max(0, pillarConsistency),
    },
    penalty: { p1, p2, p3, p4 },
    _stats: { hardAccelEvents, mediumAccelEvents, curveEvents, maxSpeed, nightSessions, peakSessions, longestTripMin, totalDistKm, totalHardDriving },
  };
}

/**
 * @brief Genera recomendaciones personalizadas a partir del resultado IRC.
 * Máximo 3 recomendaciones: mix de positivas (✅) y correctivas (⚠️).
 */
function buildRecommendations(ircResult, sessions, speedLimit) {
  const { _stats: s, irc } = ircResult;
  const recs = [];

  // Correctivas primero (ordenadas por impacto)
  if (s.maxSpeed > speedLimit + 10) {
    recs.push({ type: 'warning', icon: '⚠️', title: 'Velocidad excesiva', text: `Se detectó una velocidad de ${Math.round(s.maxSpeed)} km/h, ${Math.round(s.maxSpeed - speedLimit)} km/h sobre el límite configurado.` });
  }
  if (s.nightSessions > sessions.length * 0.3) {
    recs.push({ type: 'warning', icon: '⚠️', title: 'Conducción nocturna frecuente', text: 'Más del 30% de tus trayectos son de noche. El riesgo de accidente es 2× mayor entre 20h–6h.' });
  }
  if (s.longestTripMin > 120) {
    recs.push({ type: 'warning', icon: '⚠️', title: 'Trayecto muy largo', text: `El trayecto más largo duró ${Math.round(s.longestTripMin)} minutos. Considera hacer paradas para descansar.` });
  }
  if (s.hardAccelEvents > 5) {
    recs.push({ type: 'warning', icon: '⚠️', title: 'Frenadas/aceleraciones bruscas', text: `Se detectaron ${s.hardAccelEvents} maniobras bruscas esta semana. Aumenta la distancia de seguimiento.` });
  }
  if (s.curveEvents > 3) {
    recs.push({ type: 'warning', icon: '⚠️', title: 'Curvas agresivas', text: `${s.curveEvents} curvas con giro brusco detectadas. Reduce la velocidad antes de entrar a las curvas.` });
  }

  // Positivas (si no hay muchas correctivas)
  if (s.hardAccelEvents === 0) {
    recs.push({ type: 'ok', icon: '✅', title: 'Frenadas suaves', text: 'Sin maniobras bruscas de frenada o aceleración esta semana. Sigue así.' });
  }
  if (s.curveEvents === 0) {
    recs.push({ type: 'ok', icon: '✅', title: 'Curvas controladas', text: 'Ninguna curva agresiva detectada. Excelente técnica de conducción.' });
  }
  if (s.nightSessions === 0) {
    recs.push({ type: 'ok', icon: '✅', title: 'Sin conducción nocturna', text: 'Todos tus trayectos fueron en horario diurno. Menor exposición al riesgo.' });
  }
  if (irc >= 90) {
    recs.push({ type: 'ok', icon: '✅', title: 'Conducción excelente', text: `Tu IRC es ${irc}/100. Estás en el top de conductores seguros de Argus.` });
  }

  // Máximo 3, priorizando correctivas
  const warnings = recs.filter(r => r.type === 'warning').slice(0, 3);
  const oks      = recs.filter(r => r.type === 'ok');
  const final    = [...warnings, ...oks].slice(0, 3);
  return final.length ? final : [{ type: 'ok', icon: '✅', title: 'Todo bien', text: 'Sin observaciones esta semana.' }];
}

/**
 * @brief Etiqueta textual del IRC.
 */
function ircLabel(irc) {
  if (irc >= 90) return 'Muy segura';
  if (irc >= 75) return 'Segura';
  if (irc >= 60) return 'Mejorable';
  if (irc >= 40) return 'De riesgo';
  return 'Peligrosa';
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

/**
 * @brief GET /api/drive/metrics/:deviceId?days=7&speedLimit=80
 *
 * FLUJO:
 *   1. Fetch sesiones del período (default 14 días para cache de semana anterior).
 *   2. Calcular IRC global + desglose pilares.
 *   3. Breakdown diario (7 barras para el gráfico).
 *   4. Estadísticas de uso (hora más activa, día más activo, viaje más largo/corto).
 *   5. Métricas avanzadas (eventos por categoría, tiempo detenido, CO2, consumo).
 *   6. Recomendaciones personalizadas.
 *   7. Sesiones raw para la UI de trayectos.
 *
 * @param req.query.days        — Días a consultar (default 14, max 90).
 * @param req.query.speedLimit  — Límite de velocidad configurado por el usuario (km/h).
 */
async function getMetrics(req, res) {
  const { deviceId } = req.params;
  const days       = Math.min(parseInt(req.query.days,       10) || 14, 90);
  const speedLimit = Math.min(parseInt(req.query.speedLimit, 10) || DEFAULT_SPEED_LIMIT_KMH, 200);

  if (!deviceId || !deviceId.trim()) {
    return res.status(400).json({ message: 'deviceId es requerido' });
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  let sessions;
  try {
    sessions = await DriveMetrics
      .find({ deviceId: deviceId.trim(), timestamp: { $gte: startDate } })
      .sort({ timestamp: 1 })
      .lean();
  } catch (err) {
    return res.status(500).json({ message: 'Error al consultar métricas', error: err.message });
  }

  if (!sessions.length) {
    return res.status(200).json({
      deviceId,
      period: { days, from: startDate.toISOString(), to: new Date().toISOString() },
      irc: 100,
      ircLabel: 'Muy segura',
      pillars: { behavior: 100, temporal: 100, geo: 100, consistency: 100 },
      stats: { sessionCount: 0, totalHardEvents: 0, totalSoftEvents: 0, totalBrakingEvents: 0, totalCurveEvents: 0, maxPeakAccelDev: 0, maxPeakGyroMag: 0, maxSpeedKmh: null, totalDistanceKm: 0, totalDrivingSec: 0, totalStoppedSec: 0 },
      usage: { busiestHour: null, busiestDay: null, longestTripKm: 0, shortestTripKm: 0, tripCount: 0 },
      impact: { co2Kg: 0, fuelLiters: 0 },
      dailyBreakdown: [],
      recommendations: [],
      sessions: [],
    });
  }

  // ── IRC global ─────────────────────────────────────────────────────────────
  const ircResult = computeIRC(sessions, speedLimit);

  // ── Estadísticas globales ──────────────────────────────────────────────────
  let totalHard = 0, totalSoft = 0, totalBraking = 0, totalCurves = 0;
  let maxAccel = 0, maxGyro = 0, maxSpeedKmh = 0;
  let totalDistM = 0, totalDrivingSec = 0, totalStoppedSec = 0;

  for (const s of sessions) {
    totalHard    += s.hardCount || 0;
    totalSoft    += s.softCount || 0;
    totalBraking += drivingHardEvents(s);
    totalCurves  += isCurveAggressive(s) ? 1 : 0;
    if (s.peakAccelDev > maxAccel) maxAccel = s.peakAccelDev;
    if (s.peakGyroMag  > maxGyro)  maxGyro  = s.peakGyroMag;
    const spd = s.maxSpeedKmh ?? s.avgSpeedKmh ?? 0;
    if (spd > maxSpeedKmh) maxSpeedKmh = spd;
    if (s.distanceM != null) totalDistM += s.distanceM;
    if (s.stoppedSec != null) totalStoppedSec += s.stoppedSec;
    // Tiempo conduciendo: ventana de 30s por sesión menos el tiempo detenido
    totalDrivingSec += Math.max(0, 30 - (s.stoppedSec || 0));
  }

  const totalDistKm = totalDistM / 1000;
  const co2Kg       = parseFloat((totalDistKm * 0.090).toFixed(2));   // 90g CO2/km moto promedio
  const fuelLiters  = parseFloat((totalDistKm / 40).toFixed(2));       // 40 km/L moto promedio

  // ── Hora y día más activos ─────────────────────────────────────────────────
  const hourMap = new Array(24).fill(0);
  const dayMap7 = new Array(7).fill(0);
  for (const s of sessions) {
    const d = new Date(s.timestamp);
    hourMap[d.getHours()]  += 1;
    dayMap7[d.getDay()]    += 1;
  }
  const busiestHour = hourMap.indexOf(Math.max(...hourMap));
  const busiestDay  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][dayMap7.indexOf(Math.max(...dayMap7))];

  // ── Agrupación en trayectos (gap 30 min) para viaje más largo/corto ───────
  const GAP_MS = 30 * 60 * 1000;
  const trips = [];
  let buf = [sessions[0]];
  for (let i = 1; i < sessions.length; i++) {
    if (new Date(sessions[i].timestamp) - new Date(sessions[i - 1].timestamp) > GAP_MS) {
      trips.push(buf); buf = [];
    }
    buf.push(sessions[i]);
  }
  trips.push(buf);

  function tripDistKm(trip) {
    return trip.reduce((s, x) => s + (x.distanceM || 0), 0) / 1000;
  }
  const tripDists = trips.map(tripDistKm);
  const longestTripKm  = tripDists.length ? parseFloat(Math.max(...tripDists).toFixed(2)) : 0;
  const shortestTripKm = tripDists.length ? parseFloat(Math.min(...tripDists).toFixed(2)) : 0;

  // ── Breakdown diario ───────────────────────────────────────────────────────
  const dailyMap = new Map();
  for (const s of sessions) {
    const key = new Date(s.timestamp).toISOString().slice(0, 10);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, sessions: [], distM: 0, stoppedSec: 0, drivingSec: 0 });
    }
    const d = dailyMap.get(key);
    d.sessions.push(s);
    d.distM      += s.distanceM || 0;
    d.stoppedSec += s.stoppedSec || 0;
    d.drivingSec += Math.max(0, 30 - (s.stoppedSec || 0));
  }

  const dailyBreakdown = Array.from(dailyMap.values()).map((d) => {
    const dayIrc = computeIRC(d.sessions, speedLimit);
    const dayMax = d.sessions.reduce((m, s) => Math.max(m, s.maxSpeedKmh ?? s.avgSpeedKmh ?? 0), 0);
    return {
      date:         d.date,
      irc:          dayIrc.irc,
      ircLabel:     ircLabel(dayIrc.irc),
      sessionCount: d.sessions.length,
      distanceKm:   parseFloat((d.distM / 1000).toFixed(2)),
      drivingSec:   d.drivingSec,
      stoppedSec:   d.stoppedSec,
      maxSpeedKmh:  dayMax > 0 ? parseFloat(dayMax.toFixed(1)) : null,
      hardEvents:   d.sessions.reduce((s, x) => s + drivingHardEvents(x), 0),
      curveEvents:  d.sessions.filter(isCurveAggressive).length,
    };
  });

  // ── Sesiones raw para trayectos ────────────────────────────────────────────
  const formattedSessions = sessions.map((s) => ({
    id:           s._id,
    lat:          s.lat,
    lon:          s.lon,
    peakAccelDev: parseFloat((s.peakAccelDev || 0).toFixed(4)),
    peakGyroMag:  parseFloat((s.peakGyroMag  || 0).toFixed(2)),
    hardCount:    s.hardCount  || 0,
    softCount:    s.softCount  || 0,
    avgSpeedKmh:  s.avgSpeedKmh  != null ? parseFloat(s.avgSpeedKmh.toFixed(1))  : null,
    maxSpeedKmh:  s.maxSpeedKmh  != null ? parseFloat(s.maxSpeedKmh.toFixed(1))  : null,
    distanceM:    s.distanceM    != null ? parseFloat(s.distanceM.toFixed(1))    : null,
    stoppedSec:   s.stoppedSec   ?? null,
    isDrivingHard:  drivingHardEvents(s) > 0,
    isCurveHard:    isCurveAggressive(s),
    isNight:        isNightSession(s),
    timestamp:    s.timestamp,
  }));

  // ── Recomendaciones ────────────────────────────────────────────────────────
  const recommendations = buildRecommendations(ircResult, sessions, speedLimit);

  return res.status(200).json({
    deviceId,
    period: { days, from: startDate.toISOString(), to: new Date().toISOString() },

    irc:      ircResult.irc,
    ircLabel: ircLabel(ircResult.irc),
    pillars:  ircResult.pillars,

    stats: {
      sessionCount:      sessions.length,
      totalHardEvents:   totalHard,        // contadores firmware (incluye baches — contexto de robo)
      totalSoftEvents:   totalSoft,
      totalBrakingEvents: totalBraking,    // frenadas/aceleraciones REALES de conducción (umbrales más altos)
      totalCurveEvents:  totalCurves,
      maxPeakAccelDev:   parseFloat(maxAccel.toFixed(4)),
      maxPeakGyroMag:    parseFloat(maxGyro.toFixed(2)),
      maxSpeedKmh:       maxSpeedKmh > 0 ? parseFloat(maxSpeedKmh.toFixed(1)) : null,
      totalDistanceKm:   parseFloat(totalDistKm.toFixed(2)),
      totalDrivingSec,
      totalStoppedSec,
      avgSpeedKmh:       sessions.reduce((s, x) => s + (x.avgSpeedKmh || 0), 0) / sessions.filter(s => s.avgSpeedKmh).length || null,
    },

    usage: {
      busiestHour,
      busiestDay,
      longestTripKm,
      shortestTripKm,
      tripCount: trips.length,
      hourDistribution: hourMap,
      dayDistribution:  dayMap7,
    },

    impact: { co2Kg, fuelLiters },

    dailyBreakdown,
    recommendations,
    sessions: formattedSessions,
  });
}

module.exports = { getMetrics };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — controllers/driveController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador calcula el Índice de Riesgo de Conducción (IRC) — un puntaje
   0-100 que combina 4 pilares: cómo condujo el usuario (comportamiento), cuándo
   condujo (contexto temporal), dónde condujo (contexto geográfico) y qué tan
   constante es su estilo (consistencia). 100 = perfecto, 0 = peligroso.

   DIFERENCIA CLAVE vs versión anterior:
   - La versión anterior usaba hardCount del firmware directamente. Ese contador
     usa umbral de 0.30g — calibrado para detectar robo, no conducción.
     Un bache en Bogotá fácilmente supera 0.30g → generaba miles de "eventos duros".
   - La nueva versión usa peakAccelDev > 0.60g y peakGyroMag > 50°/s — umbrales
     de CONDUCCIÓN. Un bache no los supera; una frenada de emergencia sí.

   PSEUDOCÓDIGO:
   getMetrics(deviceId, days):
     sessions = DriveMetrics.find(deviceId, últimos days días)
     para cada sesión:
       si peakAccelDev > 0.6g → evento duro de conducción
       si peakGyroMag  > 50°/s → curva agresiva
       si noche (20h–6h) → sesión nocturna
     IRC = 100 − penalidad_comportamiento − penalidad_temporal − penalidad_geo − penalidad_consistencia
     recomendaciones = analizar(IRC, stats) → máx 3 mensajes
     retornar { IRC, pilares, stats, recomendaciones, sesiones }

   DIAGRAMA MENTAL:
   GET /api/drive/metrics/:deviceId?days=14&speedLimit=80
     ↓
   DriveMetrics.find() → N sesiones
     ↓
   computeIRC() → 4 pilares → IRC final
   buildRecommendations() → 0-3 mensajes accionables
     ↓
   JSON { irc, pillars, stats, usage, impact, dailyBreakdown, recommendations, sessions }
     ↓
   DrivingPage.jsx / driving_screen.dart

   DEUDA TÉCNICA:
   - Pilar 3 (geográfico): el ARI no se consulta por sesión en este endpoint.
     Se podría agregar llamando a gisController.lookupPoint(lat, lon) por cada
     sesión, pero el costo es O(n) lookups. Mejor: materializar el ARI en MongoDB
     cuando llega el frame DRIVE desde tcpServer.js.
   - speedLimit: hoy es un query param. Debería venir del perfil del usuario en PostgreSQL.
   - consumo y CO2: constantes fijas (40 km/L, 90g/km). Deberían ser configurables
     por modelo de moto en el perfil del usuario.

   ═══════════════════════════════════════════════════════════ */
