/**
 * @fileoverview Modelo MongoDB para salas de recuperación de Argus Secure.
 *
 * PROPÓSITO:
 *   Persiste el estado de cada sala de recuperación efímera.
 *   Permite al backend reconstruir el estado tras un reinicio y llevar
 *   auditoría de todos los eventos de recuperación.
 *
 * CICLO DE VIDA:
 *   'ACTIVE'    → Sala abierta, tracking en curso
 *   'CLOSED'    → Cerrada manualmente (moto recuperada, falsa alarma, etc.)
 *   'EXPIRED'   → Cerrada automáticamente por TTL (2 horas sin resolución)
 *
 * RELACIÓN CON LiveKit:
 *   El campo `livekitRoomName` es el nombre de la sala en el SFU de LiveKit.
 *   Es un hash corto (SHA-256[:12]) para no exponer el vehicleId en la red.
 *
 * @module models/RecoveryRoom
 */

'use strict';

const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  userEmail: { type: String, default: null },
  role:      { type: String, enum: ['OWNER', 'REACTION_CENTER', 'ALLY', 'TRACKER'], required: true },
  joinedAt:  { type: Date, default: Date.now },
}, { _id: false });

const recoveryRoomSchema = new mongoose.Schema({
  /** Nombre de la sala en LiveKit (hash de vehicleId+timestamp). */
  livekitRoomName: { type: String, required: true, unique: true, index: true },

  /** ID del dispositivo Argus de la moto robada. */
  vehicleId: { type: String, required: true, index: true },

  /** ID del propietario que creó la sala. */
  ownerId: { type: String, required: true },

  /** Estado actual de la sala. */
  status: {
    type:    String,
    enum:    ['ACTIVE', 'CLOSED', 'EXPIRED'],
    default: 'ACTIVE',
    index:   true,
  },

  /** Última posición GPS conocida de la moto al momento de crear la sala. */
  lastKnownPosition: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },

  /** Participantes que se unieron a la sala. */
  participants: { type: [participantSchema], default: [] },

  /** Cuándo expira la sala (2 horas desde creación por defecto). */
  expiresAt: { type: Date, required: true },

  /** Cuándo se cerró la sala. */
  closedAt: { type: Date, default: null },

  /** Quién cerró la sala. */
  closedBy: { type: String, default: null },

  /** Motivo de cierre. */
  resolution: {
    type:    String,
    enum:    ['RECOVERED', 'NOT_FOUND', 'FALSE_ALARM', 'TIMEOUT', null],
    default: null,
  },

}, { timestamps: true });

// Índice para buscar la sala activa de un vehículo
recoveryRoomSchema.index({ vehicleId: 1, status: 1 });

module.exports = mongoose.model('RecoveryRoom', recoveryRoomSchema);
