/**
 * @fileoverview Servicio de alertas a moteros Argus cercanos a un incidente.
 *
 * PROPÓSITO:
 *   Cuando se abre una sala de recuperación (robo reportado), busca en MongoDB
 *   los dispositivos que enviaron GPS en los últimos 10 minutos y que estén
 *   dentro del radio configurado en system_settings.nearby_alert_radius_km.
 *   Emite 'incident:nearby' via socket.io al room 'device:<deviceId>' de cada
 *   dispositivo cercano, excluyendo el dispositivo robado.
 *
 * DEPENDENCIAS:
 *   - models/Gps — últimas posiciones GPS de todos los dispositivos activos
 *   - models/SystemSettings — lee el radio configurado por operadores
 *   - services/socketService — getIo() para emitir eventos
 *
 * FLUJO:
 *   1. Leer nearby_alert_radius_km de PostgreSQL.
 *   2. Si radius = 0, retornar sin hacer nada (modo "solo operadores").
 *   3. Consultar MongoDB: latest GPS por deviceId en últimos GPS_STALENESS_MIN.
 *   4. Calcular distancia haversine desde la posición de origen.
 *   5. Para cada deviceId dentro del radio (excepto el robado):
 *      io.to('device:<id>').emit('incident:nearby', payload)
 *
 * @module services/nearbyAlertService
 */

'use strict';

const Gps            = require('../models/Gps');
const SystemSettings = require('../models/SystemSettings');
const { getIo }      = require('./socketService');

// GPS más antiguo que este umbral se descarta — el dispositivo ya no está activo
const GPS_STALENESS_MIN = 10;

/**
 * @brief Calcula la distancia haversine en kilómetros entre dos puntos WGS-84.
 *
 * @param {number} lat1  latitud punto origen  (grados decimales)
 * @param {number} lon1  longitud punto origen
 * @param {number} lat2  latitud punto destino
 * @param {number} lon2  longitud punto destino
 * @returns {number} distancia en km
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lon2 - lon1) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @brief Notifica a moteros Argus cercanos de un incidente de robo.
 *
 * PARÁMETROS:
 *   originLat / originLng — última posición conocida de la moto robada.
 *   Si son null, se salta la búsqueda (no hay posición de referencia).
 *
 * @param {string} stolenDeviceId  — deviceId del vehículo robado (se excluye)
 * @param {number|null} originLat  — latitud del robo
 * @param {number|null} originLng  — longitud del robo
 * @param {string} roomName        — nombre de la sala de recuperación creada
 * @returns {Promise<number>} cantidad de dispositivos notificados
 */
async function notifyNearbyRiders(stolenDeviceId, originLat, originLng, roomName) {
  if (originLat == null || originLng == null) return 0;

  // Leer radio configurado — 0 significa "solo operadores, no notificar usuarios"
  const radiusRaw = await SystemSettings.get(SystemSettings.KEYS.NEARBY_ALERT_RADIUS_KM);
  const radiusKm  = parseFloat(radiusRaw ?? '0');
  if (!(radiusKm > 0)) return 0;

  const io = getIo();
  if (!io) return 0;

  // Obtener última posición por dispositivo en los últimos GPS_STALENESS_MIN minutos
  const since = new Date(Date.now() - GPS_STALENESS_MIN * 60 * 1000);
  const latestPositions = await Gps.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $sort:  { timestamp: -1 } },
    { $group: {
        _id: '$deviceId',
        lat: { $first: '$lat' },
        lon: { $first: '$lon' },
      },
    },
  ]);

  const payload = {
    stolenDeviceId,
    roomName,
    lat: originLat,
    lng: originLng,
    radiusKm,
    reportedAt: new Date().toISOString(),
  };

  let notified = 0;
  for (const pos of latestPositions) {
    if (pos._id === stolenDeviceId) continue; // no notificar al propietario robado

    const dist = haversineKm(originLat, originLng, pos.lat, pos.lon);
    if (dist <= radiusKm) {
      // Emitir solo al room del dispositivo cercano (servidor une al socket en ese room)
      io.to(`device:${pos._id}`).emit('incident:nearby', {
        ...payload,
        distanceKm: Math.round(dist * 10) / 10,
      });
      notified++;
    }
  }

  if (notified > 0) {
    console.log(`[NearbyAlert] Notificados ${notified} dispositivos dentro de ${radiusKm} km`);
  }

  return notified;
}

module.exports = { notifyNearbyRiders };

/*
 * RESUMEN DEL MÓDULO — nearbyAlertService.js
 * Lee la configuración de radio desde PostgreSQL, consulta MongoDB para el último
 * GPS de cada dispositivo activo, calcula haversine y emite 'incident:nearby' a
 * cada room 'device:<id>' dentro del radio. Si radio=0, no emite nada.
 *
 * DEUDA TÉCNICA:
 * - Sin caché en el radio leído de PostgreSQL — cada incidente hace una query.
 *   Mejorar con caché en memoria con TTL de 30s.
 * - La agregación MongoDB puede ser lenta sin índice en timestamp.
 *   Agregar GpsSchema.index({ timestamp: -1 }) en models/Gps.js.
 */
