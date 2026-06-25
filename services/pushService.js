/**
 * @file services/pushService.js
 * @brief Envía push notifications FCM al dueño de un dispositivo.
 *
 * PROPÓSITO:
 *   Cuando el ESP32 reporta STATE_ALERT (alarma disparada por movimiento),
 *   el TCP server llama sendAlarmPush(deviceId, lat, lon) para despertar
 *   el teléfono del dueño con sonido, incluso con la pantalla bloqueada.
 *
 * FLUJO:
 *   1. getOwnerByDeviceId(deviceId) → { email, fcm_token }
 *   2. Si no hay fcm_token → log y retornar.
 *   3. admin.messaging().send(message) → notificación de alta prioridad.
 *
 * @note Las notificaciones FCM con priority:'high' en Android despiertan
 *       el dispositivo incluso en Doze mode y con pantalla bloqueada.
 */

'use strict';

const { getAdmin }           = require('../config/firebase');
const { getOwnerByDeviceId } = require('../models/User');

/**
 * @brief Envía push notification de alarma al dueño del dispositivo.
 * @param {string}      deviceId  ID del ESP32 que disparó la alarma
 * @param {number|null} lat       Latitud en el momento de la alarma (puede ser null)
 * @param {number|null} lon       Longitud en el momento de la alarma (puede ser null)
 */
async function sendAlarmPush(deviceId, lat, lon) {
  const admin = getAdmin();
  if (!admin) return; // Firebase no configurado

  try {
    const owner = await getOwnerByDeviceId(deviceId);
    if (!owner?.fcm_token) {
      console.log(`[Push] Sin fcm_token para deviceId=${deviceId} — omitiendo push.`);
      return;
    }

    const hasCoords = lat != null && lon != null;
    const coordStr  = hasCoords
      ? `Últ. posición: ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      : 'Sin coordenadas GPS al momento';

    const message = {
      token: owner.fcm_token,

      // Notificación visible (título + cuerpo)
      notification: {
        title: '🚨 ¡ALARMA ARGUS!',
        body:  `Tu moto se está moviendo. ${coordStr}`,
      },

      // Data payload para que la app pueda navegar directamente
      data: {
        type:     'STATE_ALERT',
        deviceId: deviceId,
        lat:      lat  != null ? String(lat)  : '',
        lon:      lon  != null ? String(lon)  : '',
      },

      android: {
        priority: 'high',                // Despierta el dispositivo en Doze mode
        notification: {
          channelId:  'argus_alarm',     // Canal creado en Flutter con IMPORTANCE_HIGH
          sound:      'alarm',           // Sonido personalizado (default si no existe)
          priority:   'max',
          visibility: 'public',          // Visible en pantalla bloqueada
          defaultVibrateTimings: true,
        },
      },

      apns: {                            // iOS
        payload: {
          aps: {
            sound:            'default',
            badge:            1,
            contentAvailable: true,
          },
        },
        headers: {
          'apns-priority': '10',
        },
      },
    };

    await admin.messaging().send(message);
    console.log(`[Push] Alarma enviada → ${owner.email} (${deviceId})`);
  } catch (err) {
    console.error(`[Push] Error enviando alarma para ${deviceId}:`, err.message);
  }
}

module.exports = { sendAlarmPush };
