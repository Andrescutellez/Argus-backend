/**
 * @fileoverview Modelo MongoDB para incidentes de seguridad comunitaria.
 *
 * PROPÓSITO:
 *   Representa un evento de robo activo o resuelto. Es el hub central del
 *   sistema de seguridad comunitaria: conecta la moto robada, el dueño que
 *   reportó, los agentes de reacción que responden, y los avistamientos
 *   de la comunidad.
 *
 * CICLO DE VIDA:
 *   'active'      → Incidente creado (robo reportado, tracking activo)
 *   'resolved'    → Moto recuperada o incidente cerrado voluntariamente
 *   'false_alarm' → El dueño o un admin marcó como falsa alarma
 *
 * FUENTES DE POSICIÓN (lastKnown.source):
 *   'gps'      → Paquete GPS directo del ESP32 (más preciso)
 *   'sighting' → Avistamiento reportado por usuario o agente
 *   'mesh'     → Relay LoRa (cuando GPS está inhibido — FUTURO)
 *
 * DISEÑO:
 *   MongoDB porque los incidentes tienen estructura dinámica (número variable
 *   de avistamientos y perseguidores) y requieren escrituras frecuentes de
 *   lastKnown (cada GPS tick mientras está activo).
 *
 * @module models/Incident
 */

'use strict';

const mongoose = require('mongoose');

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const actorSchema = new mongoose.Schema({
  userId:    { type: String, default: null },
  userEmail: { type: String, default: null },
  role:      { type: String, default: null },
  platform:  { type: String, default: null }, // 'app' | 'web' | 'system'
}, { _id: false });

const positionSchema = new mongoose.Schema({
  lat:       { type: Number, required: true },
  lng:       { type: Number, required: true },
  timestamp: { type: Date,   default: Date.now },
  source:    { type: String, enum: ['gps', 'sighting', 'mesh'], default: 'gps' },
}, { _id: false });

const sightingSchema = new mongoose.Schema({
  lat:        { type: Number, required: true },
  lng:        { type: Number, required: true },
  timestamp:  { type: Date,   default: Date.now },
  reportedBy: { type: actorSchema, default: null },
  note:       { type: String, default: null, maxlength: 300 },
});

const pursuerSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  userEmail: { type: String, default: null },
  joinedAt:  { type: Date,   default: Date.now },
  active:    { type: Boolean, default: true },
}, { _id: false });

// ── Schema principal ───────────────────────────────────────────────────────────

const incidentSchema = new mongoose.Schema({
  /** ID del dispositivo ESP32 de la moto robada. */
  deviceId: { type: String, required: true, index: true },

  /** Estado del incidente. */
  status: {
    type:    String,
    enum:    ['active', 'resolved', 'false_alarm'],
    default: 'active',
    index:   true,
  },

  /** Quién reportó el robo. */
  reportedBy: { type: actorSchema, required: true },

  /** Posición donde se reportó el robo (primer GPS conocido). */
  origin: { type: positionSchema, required: true },

  /**
   * Última posición conocida de la moto.
   * Se actualiza en cada GPS tick mientras el incidente está activo.
   * También se actualiza con avistamientos de la comunidad.
   */
  lastKnown: { type: positionSchema, required: true },

  /**
   * Información básica de la moto (desnormalizada para que los agentes
   * puedan identificarla sin query adicional a la tabla motos).
   */
  motoInfo: {
    alias:  { type: String, default: null },
    placa:  { type: String, default: null },
    marca:  { type: String, default: null },
    color:  { type: String, default: null },
    modelo: { type: String, default: null },
  },

  /** Lista de avistamientos comunitarios. */
  sightings: { type: [sightingSchema], default: [] },

  /** Agentes o usuarios que están activamente persiguiendo la moto. */
  pursuers: { type: [pursuerSchema], default: [] },

  /** Cuándo se resolvió o marcó como falsa alarma. */
  resolvedAt: { type: Date, default: null },

  /** Quién cerró el incidente. */
  resolvedBy: { type: actorSchema, default: null },

  /** Razón de cierre (opcional). */
  resolutionNote: { type: String, default: null, maxlength: 500 },

}, { timestamps: true });

// Índice compuesto para la query más frecuente: incidentes activos de un device
incidentSchema.index({ deviceId: 1, status: 1 });

module.exports = mongoose.model('Incident', incidentSchema);
