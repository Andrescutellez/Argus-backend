/**
 * @fileoverview Schema Mongoose para eventos de seguridad del sistema Argus.
 *
 * PROPÓSITO:
 *   Persistir todos los eventos relevantes del ciclo de vida de seguridad:
 *   transiciones de estado del firmware (STATE_ALERT, STATE_PURSUIT, etc.)
 *   y comandos enviados desde el backend (ARM, DISARM, ENGINE_CUT).
 *
 * FUENTES DE ALERTAS:
 *   - 'device': el ESP32 envió un frame EVENT|... por TCP reportando un cambio
 *     de estado (ej: detectó movimiento mientras estaba armado → STATE_ALERT).
 *   - 'command': el operador/usuario envió un comando desde la app o web
 *     (ej: POST /api/device/:id/command con { command: 'ARM' }).
 *   Separar la fuente permite a la UI distinguir "la moto disparó una alerta"
 *   de "el operador envió un comando" en el historial.
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
  'STATE_ALERT',
  'STATE_PURSUIT',
  'STATE_MOVING',
  'STATE_IDLE',
  'ARM',
  'DISARM',
  'ENGINE_CUT',
  'ALERT_CMD',
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
     * Origen del evento: 'device' = generado por el ESP32 via TCP,
     * 'command' = generado por el backend al enviar un CMD al device.
     */
    source: {
      type: String,
      required: true,
      enum: ['device', 'command'],
    },

    /**
     * Coordenadas GPS al momento del evento.
     * null si el device no tenía fix GPS cuando ocurrió el evento
     * (ej: STATE_ALERT en estacionamiento cerrado sin señal).
     */
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },

    /**
     * Timestamp del evento.
     * Para source='device': timestamp del paquete TCP (hora del ESP32).
     * Para source='command': Date.now() en el servidor al enviar el CMD.
     */
    timestamp: { type: Date, required: true },

    /**
     * true cuando un operador revisó y marcó esta alerta como atendida.
     * Las UIs deben resaltar las alertas con acknowledged=false.
     */
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date, default: null },
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
     _id, deviceId, type (enum), source (device|command),
     lat, lon, timestamp, acknowledged, acknowledgedAt,
     createdAt, updatedAt

   Query típica:
     Alert.find({ deviceId }).sort({ timestamp: -1 }).limit(50)

   DIAGRAMA MENTAL:
   ESP32 → tcpServer → EVENT frame → Alert { source: 'device' }
   Operador → POST /api/device/:id/command → Alert { source: 'command' }
                                                     ↓
                                           GET /api/alerts/:deviceId
                                                     ↓
                                     App Flutter / Web Usuario / Web Operador

   VARIABLES CRÍTICAS:
   - ALERT_TYPES: enum cerrado — debe sincronizarse con el firmware y deviceController.js
   - acknowledged: si se pierde, operadores no saben qué alertas atender
   - índice compuesto { deviceId, timestamp }: si se borra, queries serán lentas

   RIESGOS:
   - Si el enum no incluye un tipo que envía el firmware, los documentos se pierden
     silenciosamente (Mongoose rechaza la validación sin error visible en el log TCP).
   - lat/lon null es válido (sin GPS fix); la UI debe manejar este caso.

   ═══════════════════════════════════════════════════════════ */
