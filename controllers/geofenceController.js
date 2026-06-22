/**
 * @fileoverview Controller REST para geocercas de estacionamiento.
 *
 * PROPÓSITO:
 *   Crear, consultar y eliminar la geocerca activa de un dispositivo.
 *   Al crear: arma el dispositivo (CMD|ARM) + activa modo geocerca (CMD|PARK_MODE_ON).
 *   Al eliminar: desactiva modo geocerca (CMD|PARK_MODE_OFF) + desarma (CMD|DISARM).
 *   Coordina el cache en memoria de geofenceMonitor.js para que la evaluación GPS
 *   no requiera query a PostgreSQL en cada paquete recibido.
 *
 * RESTRICCIÓN:
 *   Requiere que el device esté autenticado (canAccessDevice middleware).
 *   Si el dispositivo no está conectado por TCP, los comandos quedan encolados.
 *
 * @module controllers/geofenceController
 */

'use strict';

const { createGeofence, deactivateGeofence, getActiveGeofence } = require('../models/ParkingGeofence');
const { setGeofenceCache, clearGeofenceCache } = require('../tcp/geofenceMonitor');
const { sendCommand } = require('../tcp/tcpServer');
const Gps = require('../models/Gps');
const Alert = require('../models/Alert');

/**
 * @brief Crea geocerca + arma el device en modo silencioso.
 *
 * Body esperado: { lat, lng, radiusM? }
 * Si no se proveen coordenadas, retorna 400 — el cliente debe pasar la última
 * posición GPS conocida (ya la tiene en pantalla).
 *
 * POST /api/geofence/:deviceId
 */
const createGeofenceHandler = async (req, res) => {
  const { deviceId } = req.params;
  const { lat, lng, radiusM } = req.body ?? {};
  const radius = parseInt(radiusM, 10) || 80;

  let latN = parseFloat(lat);
  let lngN = parseFloat(lng);

  // Si el cliente no provee coordenadas, usar la última posición GPS del device.
  if (isNaN(latN) || isNaN(lngN)) {
    const lastGps = await Gps.findOne({ deviceId }).sort({ timestamp: -1 });
    if (!lastGps) {
      return res.status(400).json({ message: 'No hay GPS disponible para este dispositivo. Provee lat y lng.' });
    }
    latN = lastGps.lat;
    lngN = lastGps.lon;
  }

  try {
    const geo = await createGeofence({
      deviceId,
      userId: req.user.sub,
      lat: latN,
      lng: lngN,
      radiusM: radius,
    });

    // Actualizar cache en memoria para que checkGeofence() evalúe sin query.
    setGeofenceCache(deviceId, { id: geo.id, lat: latN, lng: lngN, radius_m: radius });

    sendCommand(deviceId, 'ARM');
    sendCommand(deviceId, 'PARK_MODE_ON');

    // Registrar en historial quién activó el modo parqueadero y con qué radio.
    Alert.create({
      deviceId,
      type:      'GEOFENCE_ARM',
      source:    'command',
      actor: req.user ? {
        userId:    req.user.sub,
        userEmail: req.user.email,
        role:      req.user.role,
        platform:  req.body?.platform ?? null,
      } : undefined,
      meta:      { geofenceRadius: radius },
      lat:       latN,
      lon:       lngN,
      timestamp: new Date(),
    }).catch(() => {});

    return res.status(201).json({
      id: geo.id,
      deviceId,
      lat: latN,
      lng: lngN,
      radiusM: radius,
      expiresAt: geo.expires_at,
    });
  } catch (err) {
    console.error('[Geofence] Error creando geocerca:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna la geocerca activa del device, o 404 si no tiene.
 *
 * GET /api/geofence/:deviceId
 */
const getGeofenceHandler = async (req, res) => {
  const { deviceId } = req.params;
  try {
    const geo = await getActiveGeofence(deviceId);
    if (!geo) return res.status(404).json({ message: 'Sin geocerca activa' });
    return res.status(200).json(geo);
  } catch (err) {
    console.error('[Geofence] Error consultando geocerca:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Cancela la geocerca activa y desarma el device.
 *
 * DELETE /api/geofence/:deviceId
 */
const deleteGeofenceHandler = async (req, res) => {
  const { deviceId } = req.params;
  try {
    await deactivateGeofence(deviceId);
    clearGeofenceCache(deviceId);

    sendCommand(deviceId, 'PARK_MODE_OFF');
    sendCommand(deviceId, 'DISARM');

    return res.status(200).json({ message: 'Geocerca cancelada' });
  } catch (err) {
    console.error('[Geofence] Error cancelando geocerca:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { createGeofenceHandler, getGeofenceHandler, deleteGeofenceHandler };
