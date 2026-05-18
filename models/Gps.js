/**
 * @fileoverview Schema y modelo Mongoose para documentos GPS en MongoDB.
 *
 * PROPÓSITO:
 *   Define la estructura de cada registro GPS almacenado en la colección 'gps'
 *   de MongoDB. Mongoose usa este schema para validar documentos antes de escribirlos
 *   y para tipar las queries de los controladores.
 *
 * COLECCIÓN MONGODB:
 *   Mongoose deriva el nombre de la colección del nombre del modelo ('Gps'):
 *   lo convierte a minúsculas y pluraliza → colección 'gps'.
 *   Todos los datos de posición GPS de todos los devices se almacenan en esta
 *   única colección (colección por tipo, no por device).
 *
 * FUENTES DE DATOS:
 *   Dos canales distintos escriben en esta colección:
 *   1. Canal TCP (tcp/queue.js → Gps.insertMany) — path principal, alta frecuencia.
 *   2. Canal HTTP (controllers/gpsController.js → nuevoDato.save()) — path de compatibilidad.
 *   No hay distinción en el schema entre las dos fuentes.
 *
 * VARIABLES CRÍTICAS:
 *   - deviceId: sin este campo, los datos GPS no pueden asociarse a ningún dispositivo.
 *   - lat/lon: el núcleo del sistema — sin ellos el registro no tiene sentido.
 *   - timestamp: determina el orden cronológico en las queries de historial.
 *     default: Date.now (función, no valor) — Mongoose la llama en cada new Gps().
 *
 * DEUDA TÉCNICA:
 *   - Sin índices definidos en el schema: el sort por timestamp y las queries por
 *     deviceId son collection scans O(n) sin índice. Con muchos registros, las
 *     queries de getLatestByDevice() pueden tardar varios segundos.
 *   - Sin validación de rango en lat/lon a nivel de schema: la validación de rangos
 *     geográficos está duplicada en gpsController.js y tcpServer.js pero no en
 *     el schema de Mongoose, que es el lugar canónico para esas reglas.
 *   - Sin campo 'source' (tcp | http) para distinguir el origen del dato.
 *   - Sin campo 'gpsFix' aunque se recibe en el canal HTTP (se descarta en el controller).
 *
 * @module models/Gps
 */

'use strict';

const mongoose = require('mongoose');

/**
 * Schema Mongoose para documentos GPS.
 *
 * CAMPOS:
 *   - deviceId {String, required}: identificador del ESP32 (ej: "ARGUS-1237E630").
 *     trim:true elimina espacios accidentales del device al escribir.
 *   - lat {Number, required}: latitud WGS-84 en grados decimales (-90 a 90).
 *   - lon {Number, required}: longitud WGS-84 en grados decimales (-180 a 180).
 *     Nota: el campo se llama 'lon' (no 'lng'). tcpServer.js hace la conversión
 *     explícita: enqueue({ ..., lon: lng }).
 *   - speed {Number, default: 0}: velocidad en km/h. El canal TCP actual no envía
 *     velocidad, por lo que siempre es 0 para datos del ESP32. El canal HTTP puede
 *     enviarla si el hardware la soporta.
 *   - timestamp {Date, default: Date.now}: momento de recepción del dato en el servidor.
 *     Se usa para ordenar el historial cronológicamente.
 *
 * MEJORAS RECOMENDADAS AL SCHEMA:
 *   GpsSchema.index({ deviceId: 1, timestamp: -1 }) — índice compuesto para getLatestByDevice()
 *   GpsSchema.index({ timestamp: -1 }) — índice simple para obtenerDatos() (sort global)
 *   lat: { min: -90, max: 90 } — validación de rango a nivel de Mongoose
 *   lon: { min: -180, max: 180 } — validación de rango a nivel de Mongoose
 */
const GpsSchema = new mongoose.Schema({
  // Identificador único del dispositivo ESP32 que envió el dato.
  // trim:true previene queries fallidas por "ESP32-001 " != "ESP32-001" (espacio extra).
  deviceId: {
    type: String,
    required: true,
    trim: true,
  },

  // Latitud WGS-84 en grados decimales. Rango válido: -90 a 90.
  // La validación de rango la hacen los controladores, no el schema.
  lat: {
    type: Number,
    required: true,
  },

  // Longitud WGS-84 en grados decimales. Rango válido: -180 a 180.
  // NOTA: se llama 'lon' (no 'lng'). tcpServer.js mapea lng → lon explícitamente.
  lon: {
    type: Number,
    required: true,
  },

  // Velocidad en km/h. Default 0 porque el protocolo TCP actual no la transmite.
  // Si el ESP32 envía velocidad en versiones futuras del firmware, este campo la recibirá.
  speed: {
    type: Number,
    default: 0,
  },

  // Timestamp del momento de recepción del paquete en el servidor.
  // Date.now es una REFERENCIA A FUNCIÓN, no el valor. Mongoose la invoca por cada
  // nuevo documento. Si se usara Date.now() (con paréntesis), todos los documentos
  // compartirían el mismo timestamp del momento en que se cargó el módulo.
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Mongoose.model() registra el modelo en el registro global de Mongoose.
// El nombre 'Gps' se pluraliza y lowercasea → colección 'gps' en MongoDB.
// Si el modelo ya existe en el registro (ej: en tests que cargan el módulo varias veces),
// Mongoose retorna el modelo existente en lugar de crear uno nuevo.
const Gps = mongoose.model('Gps', GpsSchema);

// Se exporta el modelo para que los controladores puedan usar Gps.find(), Gps.insertMany(), etc.
module.exports = Gps;


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — models/Gps.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo define la "ficha técnica" de cada registro GPS que se guarda
   en la base de datos. Es como el formulario que hay que rellenar: deviceId
   (¿quién?), lat y lon (¿dónde?), speed (¿a qué velocidad?) y timestamp
   (¿cuándo?). Mongoose usa esta ficha para verificar que los datos que llegan
   tienen el formato correcto antes de guardarlos en MongoDB.

   PSEUDOCÓDIGO:
   Schema:
     deviceId: String (obligatorio, sin espacios)
     lat: Number (obligatorio)
     lon: Number (obligatorio)
     speed: Number (default: 0)
     timestamp: Date (default: ahora)

   Gps.save() → valida contra schema → guarda en colección 'gps'
   Gps.insertMany([...]) → valida cada doc → inserción masiva eficiente
   Gps.find({}) → devuelve todos los documentos de la colección
   Gps.findOne({ deviceId }) → devuelve un documento que coincida

   DIAGRAMA MENTAL:
   gpsController.js → new Gps({ deviceId, lat, lon }) → .save() → MongoDB 'gps'
   queue.js         → Gps.insertMany([{...}, {...}]) → MongoDB 'gps'
   gpsController.js → Gps.find({}).sort().limit(100) → array de documentos
   deviceController.js → Gps.findOne({ deviceId }).sort(-timestamp) → 1 documento

   DEUDA TÉCNICA:
   1. Sin índices: las queries son lentas con muchos documentos.
      Solución: GpsSchema.index({ deviceId: 1, timestamp: -1 })
   2. Sin validación de rango en lat/lon: el schema acepta latitud 999.
      Solución: min/max en la definición de cada campo.
   3. Sin campo 'source': no es posible saber si un dato vino por TCP o HTTP.
   4. Sin campo 'gpsFix': se recibe en HTTP pero no se persiste.

   ═══════════════════════════════════════════════════════════ */
