/**
 * @file services/pushService.js
 * @brief Envía push notifications al dueño de un dispositivo — FCM (móvil) y Web Push (browser).
 *
 * PROPÓSITO:
 *   Dos canales paralelos de notificación:
 *   1. FCM (Firebase Cloud Messaging): llega a la app Flutter incluso con pantalla bloqueada.
 *   2. Web Push VAPID: llega al browser del usuario cuando la web está en segundo plano.
 *
 *   sendAlarmPush()     — alarma ESP32 (STATE_ALERT): envía por ambos canales.
 *   sendGt06AlarmPush() — alarma GT06 (0x16/0x18): con tipo de alarma específico.
 *
 * DEPENDENCIAS:
 *   - config/firebase.js: Firebase Admin SDK para FCM.
 *   - web-push: librería VAPID, inicializada con las claves del .env.
 *   - models/User.getOwnerPushDataByDeviceId(): devuelve fcm_token + web_push_subscription.
 *
 * @note Las notificaciones FCM con priority:'high' en Android despiertan el dispositivo
 *       en Doze mode. Web Push en background requiere Service Worker activo en el browser.
 */

'use strict';

const webpush                       = require('web-push');
const { getAdmin }                  = require('../config/firebase');
const { getOwnerPushDataByDeviceId } = require('../models/User');
const { getMotoByDeviceId }         = require('../models/Moto');

// ─── Inicialización VAPID ────────────────────────────────────────────────────
// Se configura una sola vez al cargar el módulo. Si las variables no están
// definidas, las funciones de web push retornan silenciosamente sin error.
let _vapidReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_EMAIL) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  _vapidReady = true;
}

// ─── Helpers internos ────────────────────────────────────────────────────────

/**
 * @brief Envía un payload por Web Push a una suscripción específica.
 * Maneja el caso de suscripción expirada (410) limpiamente sin crashear.
 * @param {object} sub    PushSubscription serializado
 * @param {object} payload  { title, body, data? }
 */
async function _sendWebPush(sub, payload) {
  if (!_vapidReady || !sub?.endpoint) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    // 410 = suscripción expirada o cancelada por el browser — ignorar silenciosamente
    if (err.statusCode !== 410) {
      console.error('[WebPush] Error:', err.message);
    }
  }
}

/**
 * @brief Envía una notificación FCM (móvil) a un token específico.
 * @param {string} fcmToken  Token FCM del dispositivo móvil
 * @param {string} motoLabel  Nombre amigable de la moto
 * @param {string} title
 * @param {string} body
 * @param {object} data  Payload de datos extra para la app
 */
async function _sendFcm(fcmToken, motoLabel, title, body, data) {
  const admin = getAdmin();
  if (!admin || !fcmToken) return;
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: { ...data, motoLabel },
      android: {
        priority: 'high',
        notification: {
          channelId: 'argus_alarm',
          sound: 'alarm',
          priority: 'max',
          visibility: 'public',
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, contentAvailable: true } },
        headers: { 'apns-priority': '10' },
      },
    });
  } catch (err) {
    console.error('[FCM] Error:', err.message);
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * @brief Envía push de alarma ESP32 (STATE_ALERT) al dueño del dispositivo.
 * Canal móvil (FCM) + canal web (VAPID) en paralelo.
 * @param {string}      deviceId  ID del ESP32 que disparó la alarma
 * @param {number|null} lat
 * @param {number|null} lon
 */
async function sendAlarmPush(deviceId, lat, lon) {
  try {
    const [owner, moto] = await Promise.all([
      getOwnerPushDataByDeviceId(deviceId),
      getMotoByDeviceId(deviceId).catch(() => null),
    ]);
    if (!owner) return;

    const motoLabel = moto?.alias || moto?.placa || deviceId;
    const title     = '🚨 Alarma Argus';
    const body      = `Sistema armado · ${motoLabel} se está moviendo`;
    const data      = {
      type: 'STATE_ALERT', deviceId,
      lat:  lat != null ? String(lat) : '',
      lon:  lon != null ? String(lon) : '',
    };

    await Promise.all([
      _sendFcm(owner.fcm_token, motoLabel, title, body, data),
      _sendWebPush(owner.web_push_subscription, { title, body, data }),
    ]);

    console.log(`[Push] Alarma ESP32 → ${owner.email} | ${motoLabel}`);
  } catch (err) {
    console.error(`[Push] Error alarma ESP32 para ${deviceId}:`, err.message);
  }
}

/**
 * @brief Envía push de alarma GT06 (0x16/0x18) al dueño del dispositivo.
 * Diferencia el mensaje según el tipo de alarma del byte 31.
 * @param {string}      deviceId   IMEI del J16
 * @param {number}      alarmType  0x00=movimiento suave, 0x02=fuente cortada, 0x03=vibración
 * @param {number|null} lat
 * @param {number|null} lon
 */
async function sendGt06AlarmPush(deviceId, alarmType, lat, lon) {
  if (alarmType === 0x00) return; // movimiento suave — no alertar

  try {
    const [owner, moto] = await Promise.all([
      getOwnerPushDataByDeviceId(deviceId),
      getMotoByDeviceId(deviceId).catch(() => null),
    ]);
    if (!owner) return;

    const motoLabel = moto?.alias || moto?.placa || deviceId;

    const MESSAGE = {
      0x02: { title: '⚡ Fuente cortada', body: `GPS de ${motoLabel} desconectado de la alimentación` },
      0x03: { title: '🚨 Alarma activada', body: `Vibración detectada en ${motoLabel}` },
    };

    const msg = MESSAGE[alarmType];
    if (!msg) return;

    const data = {
      type:     alarmType === 0x02 ? 'GT06_POWER_CUT' : 'GT06_VIBRATION',
      deviceId,
      lat:      lat != null ? String(lat) : '',
      lon:      lon != null ? String(lon) : '',
    };

    await Promise.all([
      _sendFcm(owner.fcm_token, motoLabel, msg.title, msg.body, data),
      _sendWebPush(owner.web_push_subscription, { title: msg.title, body: msg.body, data }),
    ]);

    console.log(`[Push] Alarma GT06 type=0x${alarmType.toString(16)} → ${owner.email} | ${motoLabel}`);
  } catch (err) {
    console.error(`[Push] Error alarma GT06 para ${deviceId}:`, err.message);
  }
}

module.exports = { sendAlarmPush, sendGt06AlarmPush };
