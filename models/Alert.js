/**
 * @fileoverview Schema Mongoose para eventos de seguridad del sistema Argus.
 *
 * PROPÓSITO:
 *   Persistir todos los eventos relevantes del ciclo de vida de seguridad:
 *   transiciones de estado del firmware (STATE_ALERT, STATE_PURSUIT, etc.)
 *   y comandos enviados desde el backend (ARM, DISARM, ENGINE_CUT).
 *
 * FUENTES DE ALERTAS:
 *   - 'device'  : el ESP32 envió un frame EVENT|... por TCP (ej: STATE_ALERT).
 *   - 'command' : usuario/operador envió un comando desde la app o web.
 *   - 'system'  : acción automática del backend (auto-sensibilidad, geofence exit).
 *
 * TRAZABILIDAD (actor):
 *   Cada evento 'command' o 'system' incluye el campo actor con:
 *     userId    — UUID del usuario que ejecutó la acción (null para 'device'/'system')
 *     userEmail — email del usuario (null para 'device'/'system')
 *     role      — rol en el sistema ('USER', 'ADMIN', 'MONITORING_CENTER', etc.)
 *     source    — plataforma origen ('app', 'web', 'system', 'monitoring_center')
 *   Esto permite responder: "¿Quién desarmó la moto a las 3am?" con nombre y plataforma.
 *
 * ÍNDICES:
 *   - { deviceId, timestamp: -1 }: el 95% de las queries son "últimas N alertas
 *     de este device". El índice compuesto cubre ambas condiciones sin scan completo.
 *
 * VARIABLES CRÍTICAS:
 *   - type: si se agrega un tipo nuevo en el firmware pero no en el enum, los
 *     documentos de ese tipo fallarán la validación de Mongoose y se perderán.
 *     Mantener sincronizado con los EVENT types del firmware y VALID_COMMANDS
 *     de deviceController.js.
 *   - acknowledged: flag de revisión humana — las UIs de operador deben
 *     mostrar alertas no-acknowledged como "pendientes de acción".
 *
 * @module models/Alert
 */

'use strict';

const { Schema, model } = require('mongoose');

/**
 * Tipos de evento válidos.
 *
 * Tipos 'device' (el ESP32 los reporta via frame EVENT|):
 *   STATE_ALERT   — movimiento confirmado sospechoso mientras armado
 *   STATE_PURSUIT — robo confirmado por usuario/operador
 *   STATE_MOVING  — movimiento detectado (puede ser falso positivo)
 *   STATE_IDLE    — sistema volvió a estado quieto (tras timeout o DISARM)
 *   ARM           — device confirmó que ejecutó el comando ARM
 *   DISARM        — device confirmó que ejecutó el comando DISARM
 *
 * Tipos 'command' (el backend los genera cuando envía un CMD al device):
 *   ARM           — operador/usuario solicitó armar el dispositivo
 *   DISARM        — operador/usuario solicitó desarmar el dispositivo
 *   ENGINE_CUT    — operador solicitó cortar el motor
 *   ALERT_CMD     — operador forzó una alerta remota (override local)
 */
const ALERT_TYPES = [
  // ── Eventos del dispositivo (source: 'device') ───────────────────────────
  'STATE_ALERT',     // movimiento sospechoso confirmado mientras armado
  'STATE_PURSUIT',   // robo confirmado — GPS continuo + motor cortado
  'STATE_MOVING',    // movimiento detectado (puede ser falso positivo)
  'STATE_IDLE',      // sistema volvió a estado quieto

  // ── Comandos de control (source: 'command') ───────────────────────────────
  'ARM',             // usuario/operador armó el sistema
  'DISARM',          // usuario/operador desarmó el sistema
  'ENGINE_CUT',      // corte de motor preventivo o de emergencia
  'ENGINE_RESTORE',  // restauración del motor
  'SIREN_ON',        // sirena/bocina activada manualmente
  'SIREN_OFF',       // sirena/bocina desactivada
  'PURSUIT_CONFIRM', // usuario confirmó robo en curso → STATE_PURSUIT
  'ALERT_CMD',       // alerta remota forzada (legacy)

  // ── Cambio de sensibilidad (source: 'command' o 'system') ────────────────
  'SENSITIVITY_CHANGE', // cambio de sensibilidad del MPU6050 (meta.sensitivityLevel)

  // ── Geocerca (source: 'command'/'system') ─────────────────────────────────
  'GEOFENCE_ARM',    // usuario activó modo parqueadero con geocerca
  'GEOFENCE_EXIT',   // moto salió del radio de la geocerca (sistema detecta)

  // ── ARI — zonas de riesgo (source: 'system') ──────────────────────────────
  'RISK_ZONE_ENTER', // moto entró a zona con ARI alto
  'RISK_ZONE_EXIT',  // moto salió de zona de alto riesgo

  // ── Auditoría de revisión (source: 'command') ─────────────────────────────
  'ALERT_ACKNOWLEDGED', // operador/usuario marcó una alerta como atendida
];

const AlertSchema = new Schema(
  {
    deviceId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * Categoría del evento. Enum cerrado para evitar documentos
     * con tipos inventados que rompan la lógica de la UI.
     */
    type: {
      type: String,
      required: true,
      enum: ALERT_TYPES,
    },

    /**
     * Origen del evento:
     *   'device'  — generado por el ESP32 via TCP
     *   'command' — generado por el backend al recibir un comando del usuario
     *   'system'  — generado automáticamente por el backend (ARI, geofence, etc.)
     */
    source: {
      type: String,
      required: true,
      enum: ['device', 'command', 'system'],
    },

    /**
     * Quién ejecutó la acción. null para eventos source='device'.
     * Permite responder "¿quién desarmó la moto?" con nombre y plataforma.
     */
    actor: {
      userId:    { type: String, default: null }, // UUID del usuario (req.user.sub)
      userEmail: { type: String, default: null }, // email para mostrar en historial
      role:      { type: String, default: null }, // rol: USER, ADMIN, MONITORING_CENTER…
      platform:  { type: String, default: null }, // 'app', 'web', 'system', 'monitoring_center'
    },

    /**
     * Contexto adicional dependiente del tipo de evento.
     *   SENSITIVITY_CHANGE : sensitivityLevel (0-4), sensitivityLabel
     *   RISK_ZONE_ENTER/EXIT: ari, localidad
     *   GEOFENCE_ARM/EXIT  : geofenceRadius
     *   ALERT_ACKNOWLEDGED : refAlertId (ObjectId de la alerta que se leyó)
     */
    meta: {
      sensitivityLevel: { type: Number, default: null },
      sensitivityLabel: { type: String, default: null },
      ari:              { type: Number, default: null },
      localidad:        { type: String, default: null },
      geofenceRadius:   { type: Number, default: null },
      refAlertId:       { type: String, default: null },
    },

    /**
     * Coordenadas GPS al momento del evento.
     * null si el device no tenía fix GPS (ej: estacionamiento sin señal).
     */
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },

    /**
     * Timestamp del evento.
     * Para source='device': timestamp del paquete TCP (hora del ESP32).
     * Para source='command'/'system': Date.now() en el servidor.
     */
    timestamp: { type: Date, required: true },

    /**
     * true cuando un operador revisó y marcó esta alerta como atendida.
     */
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date, default: null },

    /**
     * Quién hizo el acknowledge. Permite auditar "¿quién silenció esta alerta?".
     */
    acknowledgedBy: {
      userId:    { type: String, default: null },
      userEmail: { type: String, default: null },
      role:      { type: String, default: null },
      platform:  { type: String, default: null },
    },
  },
  {
    // createdAt / updatedAt automáticos de Mongoose.
    // createdAt es distinto de timestamp: timestamp es cuándo ocurrió el evento
    // en el hardware; createdAt es cuándo se persistió en MongoDB (puede haber
    // latencia de red, batching, etc.).
    timestamps: true,
  },
);

// Índice compuesto para la query más frecuente: alertas recientes de un device.
// Sin este índice, .find({ deviceId }).sort({ timestamp: -1 }) haría un full scan
// y ordenaría todos los documentos de la colección en memoria.
AlertSchema.index({ deviceId: 1, timestamp: -1 });

module.exports = model('Alert', AlertSchema);


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — models/Alert.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este modelo guarda el historial de todo lo importante que le pasó a una
   moto en términos de seguridad: cuándo se armó, cuándo se disparó una
   alerta de movimiento, cuándo el operador cortó el motor, etc. Cada
   documento es un evento con su tipo, su origen (¿vino del dispositivo
   o lo generó el operador?), las coordenadas donde ocurrió y si ya fue
   revisado por alguien.

   PSEUDOCÓDIGO:
   Colección "alerts":
     _id, deviceId, type (enum), source (device|command|system),
     actor { userId, userEmail, role, platform },
     meta { sensitivityLevel, sensitivityLabel, ari, localidad, geofenceRadius, refAlertId },
     lat, lon, timestamp,
     acknowledged, acknowledgedAt,
     acknowledgedBy { userId, userEmail, role, platform },
     createdAt, updatedAt

   Query típica:
     Alert.find({ deviceId }).sort({ timestamp: -1 }).limit(50)

   DIAGRAMA MENTAL:
   ESP32 → tcpServer → EVENT frame      → Alert { source: 'device',  actor: null }
   Usuario → POST /command              → Alert { source: 'command', actor: { userId, email } }
   Sistema → geofenceMonitor/riskMonitor → Alert { source: 'system',  actor: { platform:'system' } }
   Operador → PATCH /ack                → Alert { source: 'command', type: ALERT_ACKNOWLEDGED }
                                                     ↓
                                           GET /api/alerts/:deviceId
                                                     ↓
                                     App Flutter / Web Usuario / Web Operador

   VARIABLES CRÍTICAS:
   - ALERT_TYPES: enum cerrado — mantener sincronizado con firmware y VALID_COMMANDS
   - actor: trazabilidad de quién ejecutó cada acción — nunca omitir en comandos
   - acknowledged + acknowledgedBy: ciclo de revisión de alertas críticas

   RIESGOS:
   - Si el enum no incluye un tipo que envía el firmware, los documentos se pierden
     silenciosamente (Mongoose rechaza la validación sin log visible en TCP).
   - lat/lon null es válido (sin GPS fix); la UI debe manejar este caso.
   - actor.userId null en eventos de device es intencional — no es un bug.

   ═══════════════════════════════════════════════════════════ */
