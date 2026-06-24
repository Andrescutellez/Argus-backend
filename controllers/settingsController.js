/**
 * @fileoverview Controladores REST para configuración global del sistema.
 *
 * ENDPOINTS:
 *   GET  /api/settings/nearby-alert → getNearbySetting
 *   PUT  /api/settings/nearby-alert → setNearbySetting
 *
 * PERMISOS:
 *   GET: ADMIN | SUPER_ADMIN | REACTION
 *   PUT: ADMIN | SUPER_ADMIN
 *
 * @module controllers/settingsController
 */

'use strict';

const SystemSettings = require('../models/SystemSettings');

/**
 * GET /api/settings/nearby-alert
 * Retorna la configuración actual de alertas a moteros cercanos.
 *
 * @returns {{ radiusKm: number, mode: 'nearby'|'operators_only' }}
 *   mode='operators_only' cuando radiusKm=0
 */
const getNearbySetting = async (req, res) => {
  try {
    const raw      = await SystemSettings.get(SystemSettings.KEYS.NEARBY_ALERT_RADIUS_KM);
    const radiusKm = parseFloat(raw ?? '0');
    return res.json({
      radiusKm,
      mode: radiusKm > 0 ? 'nearby' : 'operators_only',
    });
  } catch (err) {
    console.error('[Settings] getNearbySetting:', err.message);
    return res.status(500).json({ message: 'Error leyendo configuración' });
  }
};

/**
 * PUT /api/settings/nearby-alert
 * Body: { radiusKm: number }   (0 = solo operadores, 1–20 = km de radio)
 *
 * VALIDACIÓN:
 *   radiusKm debe ser un número entre 0 y 20.
 *   0 desactiva la notificación a usuarios (solo operadores).
 */
const setNearbySetting = async (req, res) => {
  const { radiusKm } = req.body ?? {};

  if (radiusKm === undefined || radiusKm === null) {
    return res.status(400).json({ message: 'radiusKm es requerido' });
  }

  const km = parseFloat(radiusKm);
  if (isNaN(km) || km < 0 || km > 20) {
    return res.status(400).json({ message: 'radiusKm debe ser un número entre 0 y 20' });
  }

  try {
    await SystemSettings.set(SystemSettings.KEYS.NEARBY_ALERT_RADIUS_KM, km);
    console.log(`[Settings] nearby_alert_radius_km actualizado a ${km} km`);
    return res.json({
      radiusKm: km,
      mode: km > 0 ? 'nearby' : 'operators_only',
      message: km > 0
        ? `Alertas activadas a moteros dentro de ${km} km`
        : 'Alertas desactivadas — solo operadores recibirán notificaciones',
    });
  } catch (err) {
    console.error('[Settings] setNearbySetting:', err.message);
    return res.status(500).json({ message: 'Error guardando configuración' });
  }
};

module.exports = { getNearbySetting, setNearbySetting };
