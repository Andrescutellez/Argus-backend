/**
 * @fileoverview Monitor de geocercas de estacionamiento.
 *
 * PROPÓSITO:
 *   Evaluar en cada GPS frame si el device sigue dentro de su geocerca activa.
 *   Mantiene un cache en memoria para evitar una query a PostgreSQL por cada
 *   paquete GPS. Aplica histéresis de 2 puntos consecutivos fuera del radio
 *   antes de declarar salida — previene falsos positivos por drift de GPS en
 *   entornos urbanos (cañones de edificios, sótanos).
 *
 * INTEGRACIÓN:
 *   Llamado desde tcpServer.js Paso 9b, fire-and-forget con .catch().
 *   Recibe un callback para encolar CMD|PARK_MODE_OFF igual que riskMonitor.js,
 *   evitando dependencia circular con tcpServer.js.
 *
 * CACHE:
 *   activeGeofences: Map<deviceId, {lat, lng, radius_m, id}>
 *   Se carga desde PostgreSQL al arrancar con warmGeofenceCache().
 *   Se actualiza cuando el controller crea/borra una geocerca vía setGeofenceCache().
 *
 * HISTÉRESIS:
 *   outOfZoneCount: Map<deviceId, number>
 *   Se incrementa en cada GPS fuera del radio, se resetea al volver a entrar.
 *   Solo cuando count >= EXIT_THRESHOLD (2) se dispara la salida.
 *
 * @module tcp/geofenceMonitor
 */

'use strict';

const { log } = require('./logger');
const { getAllActiveGeofences, deactivateGeofence } = require('../models/ParkingGeofence');

const EXIT_THRESHOLD = 2;  // puntos GPS consecutivos fuera del radio → salida confirmada

/** @type {Map<string, {id: string, lat: number, lng: number, radius_m: number}>} */
const activeGeofences = new Map();

/** @type {Map<string, number>} */
const outOfZoneCount = new Map();

// ─── Haversine ────────────────────────────────────────────────────────────────

/**
 * @brief Calcula distancia en metros entre dos puntos geográficos.
 * Precisión suficiente para radios < 500m en latitudes colombianas.
 */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── API PÚBLICA ───────────────��───────────────────────────��──────────────────

/**
 * @brief Carga todas las geocercas activas desde PostgreSQL al cache en memoria.
 * Llamar desde server.js en el arranque (igual que warmCrimeCache).
 */
async function warmGeofenceCache() {
  try {
    const rows = await getAllActiveGeofences();
    for (const row of rows) {
      activeGeofences.set(row.device_id, {
        id: row.id,
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        radius_m: row.radius_m,
      });
    }
    log('info', 'geofence.cache.warm', { count: rows.length });
  } catch (err) {
    log('error', 'geofence.cache.warm.error', { err: err.message });
  }
}

/**
 * @brief Agrega o actualiza una geocerca en el cache (llamar al crear vía REST).
 *
 * @param {string} deviceId
 * @param {{ id: string, lat: number, lng: number, radius_m: number }} geo
 */
function setGeofenceCache(deviceId, geo) {
  activeGeofences.set(deviceId, geo);
  outOfZoneCount.set(deviceId, 0);
}

/**
 * @brief Elimina una geocerca del cache (llamar al desactivar vía REST o al salir).
 *
 * @param {string} deviceId
 */
function clearGeofenceCache(deviceId) {
  activeGeofences.delete(deviceId);
  outOfZoneCount.delete(deviceId);
}

/**
 * @brief Evalúa si un device con geocerca activa está dentro o fuera de su zona.
 *
 * FLUJO:
 *   1. Si no hay geocerca activa para el device → return (no-op).
 *   2. Calcular distancia al centro de la geocerca.
 *   3. Si dentro del radio → resetear contador, return.
 *   4. Si fuera del radio → incrementar contador.
 *   5. Si contador >= EXIT_THRESHOLD → confirmar salida:
 *      a. Desactivar geocerca en PostgreSQL (fire-and-forget).
 *      b. Limpiar cache.
 *      c. Encolar CMD|PARK_MODE_OFF via cmdCallback.
 *      d. Emitir socket 'geofence:exit'.
 *
 * @param {string} deviceId
 * @param {number} lat
 * @param {number} lng
 * @param {import('socket.io').Server} io
 * @param {(deviceId: string, cmd: string) => void} cmdCallback
 * @returns {Promise<void>}
 */
async function checkGeofence(deviceId, lat, lng, io, cmdCallback) {
  const geo = activeGeofences.get(deviceId);
  if (!geo) return;

  const dist = distanceM(lat, lng, geo.lat, geo.lng);

  if (dist <= geo.radius_m) {
    // Dentro de la zona — resetear histéresis.
    outOfZoneCount.set(deviceId, 0);
    return;
  }

  // Fuera de la zona — acumular histéresis.
  const count = (outOfZoneCount.get(deviceId) || 0) + 1;
  outOfZoneCount.set(deviceId, count);

  log('info', 'geofence.out_of_zone', { deviceId, dist: Math.round(dist), count, radius: geo.radius_m });

  if (count < EXIT_THRESHOLD) return;

  // ── Salida confirmada ─────────────────────────────────────────────────────
  log('warn', 'geofence.exit', { deviceId, dist: Math.round(dist) });

  // Limpiar cache antes de la query para que el próximo GPS frame no evalúe de nuevo.
  clearGeofenceCache(deviceId);

  // Desactivar en PostgreSQL: fire-and-forget.
  deactivateGeofence(deviceId).catch((err) =>
    log('error', 'geofence.deactivate.error', { deviceId, err: err.message }),
  );

  // Ordenar al ESP32 que active la alarma completa.
  cmdCallback(deviceId, 'PARK_MODE_OFF');

  // Notificar al frontend para que muestre alerta urgente.
  if (io) {
    io.emit('geofence:exit', {
      deviceId,
      dist: Math.round(dist),
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = { warmGeofenceCache, setGeofenceCache, clearGeofenceCache, checkGeofence };
