/**
 * @fileoverview Controller REST para incidentes de seguridad comunitaria.
 *
 * PROPÓSITO:
 *   Gestionar el ciclo de vida de un incidente de robo: creación, consulta,
 *   avistamientos comunitarios, modo persecución y cierre.
 *   Al crear un incidente, emite 'incident:new' a todos los agentes de reacción
 *   conectados (socket.io room 'reaction').
 *
 * ENDPOINTS (ver routes/incident.js):
 *   POST   /api/incidents                     — reportar robo (USER, ADMIN)
 *   GET    /api/incidents/active              — incidentes activos (REACTION, ADMIN)
 *   POST   /api/incidents/:id/sighting        — reportar avistamiento (autenticado)
 *   POST   /api/incidents/:id/pursue          — unirse a persecución (autenticado)
 *   PATCH  /api/incidents/:id/resolve         — cerrar incidente (dueño o ADMIN)
 *   DELETE /api/incidents/:id/pursue          — salir de persecución (autenticado)
 *
 * BROADCAST:
 *   Los agentes de reacción se unen al room 'reaction' al conectar por socket.io.
 *   Cuando se crea un incidente → io.to('reaction').emit('incident:new', data).
 *   Las actualizaciones GPS en tiempo real se emiten desde tcpServer.js al room
 *   'incident:{id}' para que solo los que siguen ese incidente las reciban.
 *
 * @module controllers/incidentController
 */

'use strict';

const Incident = require('../models/Incident');
const { getMotoByDeviceId } = require('../models/Moto');
const { getIo } = require('../services/socketService');
const { log }   = require('../tcp/logger');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * @brief Construye el objeto actor desde req.user.
 * @param {object} user  req.user (payload JWT)
 * @param {string} [platform]  'app' | 'web'
 * @returns {{ userId, userEmail, role, platform }}
 */
function buildActor(user, platform = null) {
  return {
    userId:    user?.sub   ?? null,
    userEmail: user?.email ?? null,
    role:      user?.role  ?? null,
    platform:  platform ?? user?.platform ?? null,
  };
}

/**
 * @brief Obtiene información básica de la moto asociada al dispositivo.
 *        Retorna null si no hay moto asociada — el incidente puede crearse igualmente.
 * @param {string} deviceId
 * @returns {Promise<object|null>}
 */
async function getMotoInfo(deviceId) {
  try {
    const moto = await getMotoByDeviceId(deviceId);
    if (!moto) return null;
    return {
      alias:  moto.alias  ?? null,
      placa:  moto.placa  ?? null,
      marca:  moto.marca  ?? null,
      color:  moto.color  ?? null,
      modelo: moto.modelo ?? null,
    };
  } catch {
    return null;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * @brief Crea un nuevo incidente de robo y alerta a los agentes de reacción.
 *
 * FLUJO:
 *   1. Validar lat/lng y deviceId presentes.
 *   2. Verificar que no haya ya un incidente activo para ese device.
 *   3. Obtener info de la moto (opcional — no bloquea si falla).
 *   4. Crear el documento Incident en MongoDB.
 *   5. Emitir 'incident:new' al room 'reaction' via socket.io.
 *   6. Retornar 201 con el incidente creado.
 *
 * POST /api/incidents
 * Body: { deviceId, lat, lng, platform? }
 */
const createIncident = async (req, res) => {
  const { deviceId, lat, lng, platform } = req.body ?? {};

  if (!deviceId || lat == null || lng == null) {
    return res.status(400).json({ message: 'deviceId, lat y lng son requeridos' });
  }

  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (isNaN(latN) || isNaN(lngN)) {
    return res.status(400).json({ message: 'lat y lng deben ser números válidos' });
  }

  try {
    // Prevenir duplicados: un device solo puede tener un incidente activo a la vez
    const existing = await Incident.findOne({ deviceId, status: 'active' });
    if (existing) {
      return res.status(409).json({
        message: 'Ya existe un incidente activo para este dispositivo',
        incidentId: existing._id,
      });
    }

    const actor    = buildActor(req.user, platform);
    const motoInfo = await getMotoInfo(deviceId);
    const now      = new Date();
    const position = { lat: latN, lng: lngN, timestamp: now, source: 'gps' };

    const incident = await Incident.create({
      deviceId,
      reportedBy: actor,
      origin:     position,
      lastKnown:  position,
      motoInfo:   motoInfo ?? {},
    });

    log('warn', 'incident.created', { deviceId, incidentId: incident._id, actor: actor.userEmail });

    // Alertar a todos los agentes de reacción conectados
    const io = getIo();
    if (io) {
      io.to('reaction').emit('incident:new', {
        incidentId:  incident._id,
        deviceId,
        lat:         latN,
        lng:         lngN,
        motoInfo:    motoInfo ?? {},
        reportedAt:  now.toISOString(),
      });
    }

    return res.status(201).json(incident);
  } catch (err) {
    log('error', 'incident.create.error', { err: err.message });
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna todos los incidentes activos.
 *        Los agentes de reacción lo usan al abrir la app para cargar el estado.
 *
 * GET /api/incidents/active
 */
const getActiveIncidents = async (req, res) => {
  try {
    const incidents = await Incident
      .find({ status: 'active' })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json(incidents);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Agrega un avistamiento a un incidente activo.
 *
 * POST /api/incidents/:id/sighting
 * Body: { lat, lng, note?, platform? }
 */
const addSighting = async (req, res) => {
  const { id } = req.params;
  const { lat, lng, note, platform } = req.body ?? {};

  if (lat == null || lng == null) {
    return res.status(400).json({ message: 'lat y lng son requeridos' });
  }

  try {
    const incident = await Incident.findById(id);
    if (!incident) return res.status(404).json({ message: 'Incidente no encontrado' });
    if (incident.status !== 'active') {
      return res.status(409).json({ message: 'El incidente ya no está activo' });
    }

    const sighting = {
      lat:        parseFloat(lat),
      lng:        parseFloat(lng),
      timestamp:  new Date(),
      reportedBy: buildActor(req.user, platform),
      note:       note ?? null,
    };

    incident.sightings.push(sighting);
    // El avistamiento también actualiza la última posición conocida
    incident.lastKnown = { ...sighting, source: 'sighting' };
    await incident.save();

    const io = getIo();
    if (io) {
      io.to(`incident:${id}`).emit('incident:sighting', {
        incidentId: id, ...sighting,
      });
    }

    log('info', 'incident.sighting', { incidentId: id, lat, lng });
    return res.status(201).json(sighting);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Agrega al usuario como perseguidor activo del incidente.
 *
 * POST /api/incidents/:id/pursue
 * Body: { platform? }
 */
const joinPursuit = async (req, res) => {
  const { id } = req.params;

  try {
    const incident = await Incident.findById(id);
    if (!incident) return res.status(404).json({ message: 'Incidente no encontrado' });
    if (incident.status !== 'active') {
      return res.status(409).json({ message: 'El incidente ya no está activo' });
    }

    const userId = req.user?.sub;
    // Evitar duplicados — si ya estaba como perseguidor, reactivar
    const existing = incident.pursuers.find(p => p.userId === userId);
    if (existing) {
      existing.active = true;
    } else {
      incident.pursuers.push({
        userId,
        userEmail: req.user?.email ?? null,
        joinedAt:  new Date(),
        active:    true,
      });
    }
    await incident.save();

    // Unir el socket del usuario al room del incidente para recibir GPS updates
    const io = getIo();
    if (io) {
      io.to('reaction').emit('incident:pursuer_joined', {
        incidentId: id,
        userId,
        pursuerCount: incident.pursuers.filter(p => p.active).length,
      });
    }

    log('info', 'incident.pursue', { incidentId: id, userId });
    return res.status(200).json({ message: 'Unido a persecución', incidentId: id });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Marca al usuario como inactivo en la persecución.
 *
 * DELETE /api/incidents/:id/pursue
 */
const leavePursuit = async (req, res) => {
  const { id } = req.params;
  const userId  = req.user?.sub;

  try {
    const incident = await Incident.findById(id);
    if (!incident) return res.status(404).json({ message: 'Incidente no encontrado' });

    const pursuer = incident.pursuers.find(p => p.userId === userId);
    if (pursuer) { pursuer.active = false; await incident.save(); }

    return res.status(200).json({ message: 'Saliste de la persecución' });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Cierra un incidente (resuelto o falsa alarma).
 *
 * PATCH /api/incidents/:id/resolve
 * Body: { status: 'resolved'|'false_alarm', note?, platform? }
 */
const resolveIncident = async (req, res) => {
  const { id } = req.params;
  const { status, note, platform } = req.body ?? {};

  if (!['resolved', 'false_alarm'].includes(status)) {
    return res.status(400).json({ message: "status debe ser 'resolved' o 'false_alarm'" });
  }

  try {
    const incident = await Incident.findById(id);
    if (!incident) return res.status(404).json({ message: 'Incidente no encontrado' });
    if (incident.status !== 'active') {
      return res.status(409).json({ message: 'El incidente ya está cerrado' });
    }

    // Solo el dueño que reportó o un ADMIN/SUPER_ADMIN pueden cerrar
    const role   = req.user?.role;
    const userId = req.user?.sub;
    const isOwner    = incident.reportedBy?.userId === userId;
    const isAdmin    = role === 'ADMIN' || role === 'SUPER_ADMIN';
    const isReaction = role === 'REACTION';
    if (!isOwner && !isAdmin && !isReaction) {
      return res.status(403).json({ message: 'Solo el dueño, un agente o un admin pueden cerrar el incidente' });
    }

    incident.status         = status;
    incident.resolvedAt     = new Date();
    incident.resolvedBy     = buildActor(req.user, platform);
    incident.resolutionNote = note ?? null;
    await incident.save();

    const io = getIo();
    if (io) {
      io.to('reaction').emit('incident:resolved', {
        incidentId: id,
        status,
        resolvedAt: incident.resolvedAt.toISOString(),
      });
    }

    log('info', 'incident.resolved', { incidentId: id, status, userId });
    return res.status(200).json(incident);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Cierra el incidente activo de un dispositivo específico.
 *        Usado cuando el dueño restaura el motor (ENGINE_RESTORE) desde la app:
 *        la moto fue recuperada, el incidente comunitario debe cerrarse automáticamente.
 *
 * PATCH /api/incidents/device/:deviceId/resolve
 * Body: { resolutionNote? }
 */
const resolveIncidentByDevice = async (req, res) => {
  const { deviceId } = req.params;
  const { resolutionNote } = req.body ?? {};

  try {
    const incident = await Incident.findOne({ deviceId, status: 'active' });
    if (!incident) {
      // Ningún incidente activo → OK silencioso (el cliente no necesita saber)
      return res.status(200).json({ message: 'Sin incidente activo para este dispositivo' });
    }

    incident.status         = 'resolved';
    incident.resolvedAt     = new Date();
    incident.resolvedBy     = buildActor(req.user);
    incident.resolutionNote = resolutionNote ?? 'Motor restaurado — moto recuperada';
    await incident.save();

    const io = getIo();
    if (io) {
      io.to('reaction').emit('incident:resolved', {
        incidentId: incident._id.toString(),
        status:     'resolved',
        resolvedAt: incident.resolvedAt.toISOString(),
      });
    }

    log('info', 'incident.resolved_by_device', { deviceId, incidentId: incident._id });
    return res.status(200).json(incident);
  } catch (err) {
    log('error', 'incident.resolveByDevice.error', { err: err.message });
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = {
  createIncident,
  getActiveIncidents,
  addSighting,
  joinPursuit,
  leavePursuit,
  resolveIncident,
  resolveIncidentByDevice,
};
