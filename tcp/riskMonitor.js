/**
 * @fileoverview Argus Risk Monitor — Capa 4 del ARI: automatización de vigilancia reforzada.
 *
 * PROPÓSITO:
 *   Monitorea en tiempo real si el dispositivo ESP32 entra o sale de una zona
 *   de alto riesgo usando el Argus Risk Index (ARI). Cuando ARI cruza el umbral
 *   ENTER (≥ 65), ejecuta automáticamente:
 *     1. Aumenta la sensibilidad del MPU6050 → SENSITIVITY_HIGH (mayor detección).
 *     2. Emite evento socket.io 'risk:zone_enter' → notificación push en app y web.
 *   Cuando el ARI baja del umbral EXIT (< 35), restaura sensibilidad normal.
 *
 * HISTÉRESIS:
 *   El gap entre ENTER (65) y EXIT (35) evita "flapping": si la moto está
 *   circulando en el borde entre dos localidades, el sistema no va a cambiar
 *   de sensibilidad en cada GPS tick. Debe caer claramente por debajo de 35
 *   para considerar que salió de la zona de riesgo.
 *
 * INTEGRACIÓN:
 *   tcpServer.js llama checkRiskZone() en el Paso 9b (después del gps:update)
 *   con fire-and-forget. No bloquea el ACK al ESP32.
 *
 * DEPENDENCIAS:
 *   - ../controllers/crimeController: calculateARI, getBogotaCacheSync, pointInGeoJsonGeom
 *   - ./logger: log estructurado JSON
 *   - Socket.io (io) y cmdCallback: inyectados como parámetros para evitar dependencia circular.
 *
 * VARIABLES CRÍTICAS:
 *   - deviceRiskState: estado de riesgo actual por dispositivo. Volátil (RAM).
 *     Si el servidor se reinicia, todos los dispositivos arrancan sin historial
 *     y recibirán un zone_enter en el primer GPS tick si están en zona alta.
 *
 * @module tcp/riskMonitor
 */

'use strict';

const { log }                                                  = require('./logger');
const { calculateARI, getBogotaCacheSync, pointInGeoJsonGeom } = require('../controllers/crimeController');

// ─── UMBRALES ARI ─────────────────────────────────────────────────────────────

/**
 * ARI mínimo para activar vigilancia reforzada.
 * 65 equivale a localidades "alto" con factor nocturno o "muy_alto" de día.
 */
const ARI_ENTER_THRESHOLD = 65;

/**
 * ARI máximo para desactivar vigilancia reforzada.
 * El gap 65→35 implementa histéresis — evita cambios de sensibilidad oscilantes.
 */
const ARI_EXIT_THRESHOLD = 35;

/**
 * Tiempo mínimo entre notificaciones push consecutivas por dispositivo.
 * El ajuste de sensibilidad al ESP32 ocurre igualmente — solo se suprime el push.
 * Sin este cooldown, cruzar Bogotá de extremo a extremo (~20 localidades) generaría
 * hasta 20 notificaciones en un mismo trayecto.
 */
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

/**
 * Estado de riesgo actual por dispositivo.
 *
 * @type {Map<string, { localidad: string, ari: number, risk_level: string, inHighRisk: boolean, lastAlertTs: number }>}
 *
 * RIESGO: volátil — se pierde en reinicios del servidor. Aceptable porque:
 *   - Al reconectar, el primer paquete GPS recalcula el ARI y restaura el estado.
 *   - El dispositivo recibe SENSITIVITY_HIGH de nuevo si sigue en zona de riesgo.
 */
const deviceRiskState = new Map();

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────

/**
 * Evalúa el riesgo de la posición GPS actual y actúa si cruzó un umbral.
 *
 * PROPÓSITO:
 *   Esta es la función central del motor de riesgo ARI. Se llama desde tcpServer.js
 *   después de cada paquete GPS válido. Su ejecución es asíncrona y fire-and-forget:
 *   no debe retrasar el ACK al ESP32 ni interferir con el pipeline TCP.
 *
 * FLUJO LÓGICO:
 *   1. Obtener FeatureCollection de criminalidad desde el cache en memoria (síncrono).
 *      Si el cache está vacío (servidor recién arrancado), retornar sin hacer nada.
 *   2. Ray casting: encontrar cuál de las 20 localidades contiene el punto (lon, lat).
 *      Si fuera de Bogotá → retornar (ARI solo cubre Bogotá por ahora).
 *   3. calculateARI() con hora actual → score 0-100 dinámico.
 *   4. Comparar con estado anterior (deviceRiskState):
 *      a) Si ARI cruzó hacia arriba (≥ ENTER): encolar SENSITIVITY_HIGH + emitir risk:zone_enter.
 *      b) Si ARI cruzó hacia abajo (< EXIT): encolar SENSITIVITY_MEDIUM + emitir risk:zone_exit.
 *      c) Si no hay cruce: solo actualizar estado en el Map.
 *
 * DEPENDENCIAS:
 *   - getBogotaCacheSync(): acceso síncrono al cache de crimen (sin HTTP).
 *   - calculateARI(): fórmula ARI con hora actual (dinámica).
 *   - pointInGeoJsonGeom(): ray casting punto-en-polígono.
 *   - cmdCallback: callback para encolar comando en tcpServer.commandQueues.
 *   - io: Socket.io Server para emitir al frontend.
 *
 * @param {string}   deviceId    ID del dispositivo (ej: "ARGUS-1237E630").
 * @param {number}   lat         Latitud WGS-84.
 * @param {number}   lon         Longitud WGS-84.
 * @param {object|null} io       Instancia Socket.io. null en tests.
 * @param {function(string, string): void} cmdCallback
 *   Callback para encolar un comando: cmdCallback(deviceId, 'SENSITIVITY_HIGH').
 *   Inyectado desde tcpServer para evitar dependencia circular.
 *
 * @returns {Promise<void>}
 *
 * @note checkRiskZone se llama con .catch() en tcpServer → los errores aquí
 *   NO crashean el servidor TCP. Fallar silenciosamente es correcto aquí.
 */
async function checkRiskZone(deviceId, lat, lon, io, cmdCallback) {
  const crimeData = getBogotaCacheSync();
  // Cache no poblado aún (servidor arrancó hace < 10s). Omitir sin error.
  if (!crimeData || !crimeData.features) return;

  // Ray casting: O(20) — solo 20 localidades en Bogotá
  const feature = crimeData.features.find(
    f => f.geometry && pointInGeoJsonGeom(f.geometry, lon, lat),
  );
  // El dispositivo está fuera de Bogotá — ARI solo cubre la ciudad por ahora
  if (!feature) return;

  const props = feature.properties;
  const ari   = calculateARI(props);
  const prev  = deviceRiskState.get(deviceId);

  const wasHigh = prev?.inHighRisk ?? false;
  const nowHigh = ari >= ARI_ENTER_THRESHOLD;
  const nowSafe = ari < ARI_EXIT_THRESHOLD;

  // Actualizar estado con histéresis:
  //   Si estaba en alto riesgo, solo salir cuando cae bajo EXIT (35).
  //   Si no estaba en alto riesgo, entrar cuando supera ENTER (65).
  const stillHigh    = wasHigh ? !nowSafe : nowHigh;
  const lastAlertTs  = prev?.lastAlertTs ?? 0;
  const cooldownOk   = (Date.now() - lastAlertTs) > ALERT_COOLDOWN_MS;

  deviceRiskState.set(deviceId, {
    localidad:  props.nombre,
    ari,
    risk_level: props.risk_level,
    inHighRisk: stillHigh,
    lastAlertTs,
  });

  // ── Entrada a zona de alto riesgo ───────────────────────────────────────────
  if (!wasHigh && nowHigh) {
    log('info', 'risk.zone_enter', { deviceId, localidad: props.nombre, ari, risk_level: props.risk_level, notified: cooldownOk });

    // El ajuste de sensibilidad ocurre siempre — independiente del cooldown.
    if (cmdCallback) cmdCallback(deviceId, 'SENSITIVITY_HIGH');

    // La notificación push respeta el cooldown: máximo 1 alerta cada 5 minutos.
    // Esto evita spamear al usuario si atraviesa varias localidades de alto riesgo seguidas.
    if (cooldownOk) {
      deviceRiskState.set(deviceId, { ...deviceRiskState.get(deviceId), lastAlertTs: Date.now() });
      if (io) io.emit('risk:zone_enter', {
        deviceId,
        localidad:     props.nombre,
        ari,
        risk_level:    props.risk_level,
        motos_2026:    props.motos_2026,
        camaras_total: props.camaras_total,
        lat,
        lon,
        ts: new Date().toISOString(),
      });
    }
  }

  // ── Salida de zona de alto riesgo (con histéresis) ──────────────────────────
  else if (wasHigh && nowSafe) {
    log('info', 'risk.zone_exit', { deviceId, localidad: props.nombre, ari, notified: cooldownOk });

    if (cmdCallback) cmdCallback(deviceId, 'SENSITIVITY_MEDIUM');

    if (cooldownOk) {
      deviceRiskState.set(deviceId, { ...deviceRiskState.get(deviceId), lastAlertTs: Date.now() });
      if (io) io.emit('risk:zone_exit', {
        deviceId,
        localidad: props.nombre,
        ari,
        lat,
        lon,
        ts: new Date().toISOString(),
      });
    }
  }
  // Si no hay cruce de umbral, el estado ya fue actualizado arriba (solo estado interno).
}

/**
 * Retorna el estado de riesgo actual de un dispositivo.
 *
 * PROPÓSITO:
 *   Permite que endpoints REST (ej: GET /api/device/:id/status) incluyan
 *   el ARI actual en su respuesta sin volver a hacer el ray casting.
 *
 * @param {string} deviceId
 * @returns {{ localidad: string, ari: number, risk_level: string, inHighRisk: boolean } | null}
 */
function getDeviceRisk(deviceId) {
  return deviceRiskState.get(deviceId) ?? null;
}

module.exports = { checkRiskZone, getDeviceRisk };


/* ═══════════════════════════════════════════════════════════
   RESUMEN — tcp/riskMonitor.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo es el "guardián de zona" de Argus. Cada vez que la moto envía
   su posición GPS, este módulo consulta en memoria si esa ubicación está en
   una zona peligrosa (según los datos de hurtos OAIEE). Si la moto acaba de
   entrar a una zona peligrosa, automáticamente le dice al ESP32 que sea más
   sensible al movimiento (como si activaras el modo alerta máxima sin que el
   usuario tenga que hacer nada). Y le avisa al teléfono del usuario.

   PSEUDOCÓDIGO:
   checkRiskZone(deviceId, lat, lon, io, cmdCallback):
     cache = getBogotaCacheSync()        → 20 polígonos en RAM
     localidad = ray_casting(lat, lon)   → O(20)
     ari = calculateARI(localidad.props) → 0-100 dinámico con hora actual
     prev = deviceRiskState[deviceId]
     if !prev.inHighRisk AND ari >= 65:
       cmdCallback(deviceId, 'SENSITIVITY_HIGH')
       io.emit('risk:zone_enter', {...})
     elif prev.inHighRisk AND ari < 35:
       cmdCallback(deviceId, 'SENSITIVITY_MEDIUM')
       io.emit('risk:zone_exit', {...})
     deviceRiskState[deviceId] = { ..., ari, inHighRisk }

   DIAGRAMA MENTAL:
   GPS packet → tcpServer.js → checkRiskZone() → cache lookup → calculateARI()
                                                              ↓
                                               ARI cruzó umbral?
                                             NO ↙             ↘ SÍ
                                      actualizar        cmdCallback → SENSITIVITY_HIGH
                                      estado solo       io.emit → risk:zone_enter

   ═══════════════════════════════════════════════════════════ */
