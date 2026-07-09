/**
 * @fileoverview Schema Mongoose para el estado operativo actual de un device ESP32.
 *
 * PROPÓSITO:
 *   Mantener un documento "vivo" por device que refleje su estado más reciente:
 *   si está armado o no. Es la fuente de verdad para la UI cuando el usuario
 *   abre la app y necesita saber "¿mi moto está armada ahora mismo?".
 *
 * POR QUÉ NO USAR EL HISTORIAL DE ALERTAS:
 *   Se podría inferir el estado ARM/DISARM consultando la última alerta de tipo
 *   'ARM' o 'DISARM' en la colección Alert. Pero eso requiere una query de
 *   aggregation o sort+limit por cada consulta de estado, con costo O(log n).
 *   Un documento de estado único por device es O(1): un findOne por deviceId
 *   que siempre existe y está actualizado. Para una consulta que ocurre cada
 *   30 segundos por cada dispositivo en el dashboard del operador, la diferencia
 *   es significativa con volumen.
 *
 * ACTUALIZACIONES:
 *   Este documento se actualiza (upsert) en dos momentos:
 *   1. Cuando el backend envía un comando ARM o DISARM (optimistic update):
 *      se asume que el device lo ejecutará. Si el device está offline, el
 *      estado en BD refleja la intención del operador, no la realidad del hardware.
 *   2. Cuando el device envía un frame EVENT con type ARM o DISARM (confirmed update):
 *      el device confirmó que ejecutó el cambio. Esta es la fuente de verdad real.
 *
 * VARIABLES CRÍTICAS:
 *   - armed: si este campo se pierde o corrompe, la UI mostrará estado incorrecto.
 *     No es catastrófico (la moto seguirá funcionando según su estado interno),
 *     pero el usuario verá información contradictoria.
 *   - deviceId: unique index — garantiza que hay exactamente un doc por device.
 *
 * @module models/DeviceState
 */

'use strict';

const { Schema, model } = require('mongoose');

const DeviceStateSchema = new Schema(
  {
    /**
     * Identificador único del device. Coincide con el deviceId del protocolo TCP.
     * unique:true garantiza un solo documento de estado por device (upsert seguro).
     */
    deviceId: {
      type: String,
      required: true,
      unique: true,
    },

    /**
     * Si el sistema de alarma del device está actualmente armado.
     * true → el ESP32 procesa movimiento y puede escalar a STATE_ALERT.
     * false → el ESP32 ignora el acelerómetro (solo keepalive).
     * Default false: los devices nuevos empiezan desarmados.
     */
    armed: {
      type: Boolean,
      default: false,
    },

    /**
     * Estado operativo actual del firmware ESP32.
     * Espejo en tiempo real de la máquina de estados del device.
     * Valores válidos: 'STATE_IDLE', 'STATE_MOVING', 'STATE_ALERT', 'STATE_PURSUIT'.
     * Se actualiza por tcpServer.js al recibir frames EVENT del device,
     * y de forma optimista por deviceController al enviar PURSUIT_CONFIRM.
     * STATE_PURSUIT implica GPS continuo cada 10s. Sirena y corte de motor son comandos explícitos.
     */
    state: {
      type: String,
      default: 'STATE_IDLE',
    },

    /**
     * Si el relé de corte de motor está activo actualmente.
     * Independiente de `state`: el motor puede estar cortado (preventivo) sin que
     * el firmware haya entrado en STATE_PURSUIT. Se activa con ENGINE_CUT y se limpia
     * con ENGINE_RESTORE o DISARM. STATE_PURSUIT también lo implica, pero no al revés.
     */
    motorCut: {
      type: Boolean,
      default: false,
    },

    /**
     * Señal celular reportada por el frame DIAG en la última conexión TCP.
     * Escala AT+CSQ: 0-31 (31=excelente, <10=pésimo, 99=sin lectura del modem).
     * null si el firmware no ha enviado ningún DIAG todavía (device no flasheado).
     */
    rssi: { type: Number, default: null },

    /**
     * Estado del contexto de datos (AT+CGATT) en la última conexión TCP.
     * true  → el operador tiene PDP context activo (datos ok).
     * false → sin contexto de datos (plan vencido/agotado, aunque TCP abre brevemente).
     * null  → sin DIAG recibido todavía.
     */
    cgatt: { type: Boolean, default: null },

    /**
     * Si el canal TCP del device está cifrado (TLS vía API CCH del A7670, 2026-07-09).
     * true  → sesión CCH TLS activa (puerto 9001).
     * false → TCP plano (fallback en runtime tras fallos de TLS, o TCP_USE_TLS=0).
     * null  → firmware pre-TLS que manda DIAG de 3 campos — distinto de false
     *         para que la UI no muestre "sin cifrar" como falso negativo.
     */
    tls: { type: Boolean, default: null },

    /**
     * Cuándo llegó el último frame DIAG de este device.
     * Permite detectar firmware antiguo (sin DIAG) vs firmware nuevo sin conexión reciente.
     */
    lastDiagAt: { type: Date, default: null },

    /**
     * Cuándo fue la última actualización de este documento.
     * Útil para detectar devices cuyo estado no se ha actualizado en mucho tiempo
     * (posible desconexión prolongada o fallo de sincronización).
     * Se actualiza manualmente en cada upsert — NO usar timestamps de Mongoose
     * porque no queremos createdAt/updatedAt separados para este modelo.
     */
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    // Sin timestamps automáticos: updatedAt se gestiona manualmente
    // para tener control total sobre cuándo se considera "actualizado".
    timestamps: false,
  },
);

module.exports = model('DeviceState', DeviceStateSchema);


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — models/DeviceState.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este modelo guarda el "estado actual" de cada dispositivo. Es como un
   semáforo en tiempo real: la app consulta este documento para saber si
   la moto está armada o desarmada en este momento, sin tener que leer
   todo el historial de eventos. Se actualiza cuando el operador envía un
   comando ARM/DISARM, y se confirma cuando el dispositivo físico reporta
   que ejecutó el cambio.

   PSEUDOCÓDIGO:
   Colección "devicestates":
     _id, deviceId (unique), armed (bool), updatedAt

   Update típico:
     DeviceState.findOneAndUpdate(
       { deviceId },
       { armed: true, updatedAt: new Date() },
       { upsert: true, new: true }
     )

   Query típica:
     DeviceState.findOne({ deviceId })

   DIAGRAMA MENTAL:
   Operador envía ARM  → deviceController → upsert { armed: true }
   ESP32 confirma ARM  → tcpServer EVENT   → upsert { armed: true }  (confirmado)
   GET /device/:id/status → lee este doc   → incluye { armed: true } en respuesta

   VARIABLES CRÍTICAS:
   - unique index en deviceId: necesario para que el upsert sea atómico y correcto
   - armed: fuente de verdad para la UI; desfasado si el device está offline

   ESCALABILIDAD:
   - Con PostgreSQL en producción, este dato migra a la tabla `devices`.
   - Este modelo es transitorio hasta que se implemente la BD relacional.

   ═══════════════════════════════════════════════════════════ */
