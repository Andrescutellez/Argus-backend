/**
 * @fileoverview Controlador REST para gestión del catálogo de devices manufacturados.
 *
 * PROPÓSITO:
 *   Permite al SUPER_ADMIN pre-registrar los MACs de los ESP32 que se fabrican,
 *   listar el inventario y revocar dispositivos comprometidos.
 *   Solo roles ADMIN y SUPER_ADMIN pueden acceder; las escrituras (add/remove)
 *   son exclusivas de SUPER_ADMIN.
 *
 * ENDPOINTS:
 *   GET    /api/manufactured          → listDevices (ADMIN+)
 *   POST   /api/manufactured          → addDevice   (SUPER_ADMIN)
 *   DELETE /api/manufactured/:deviceId → removeDevice (SUPER_ADMIN)
 *
 * @module controllers/manufacturedDeviceController
 */

'use strict';

const ManufacturedDevice = require('../models/ManufacturedDevice');
const User = require('../models/User');
const { log } = require('../models/AuditLog');

/**
 * @brief Registra un nuevo device en el catálogo de fabricación.
 * @param {import('express').Request}  req  Body: { deviceId, notes? }
 * @param {import('express').Response} res  201: device registrado | 400: falta deviceId
 */
const VALID_PROTOCOLS = ['argus', 'gt06'];

const addDevice = async (req, res) => {
  const { deviceId, imei, notes, protocol } = req.body ?? {};

  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    return res.status(400).json({ message: 'deviceId requerido' });
  }

  const proto = VALID_PROTOCOLS.includes(protocol) ? protocol : 'argus';

  try {
    const device = await ManufacturedDevice.addDevice(deviceId.trim(), imei ?? null, notes ?? null, proto);

    await log({
      userId: req.user.sub,
      action: 'MANUFACTURED_DEVICE_ADD',
      targetType: 'manufactured_device',
      targetId: deviceId,
      metadata: { imei, notes, protocol: proto },
    });

    return res.status(201).json(device);
  } catch (err) {
    console.error('[MANUFACTURED] addDevice error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Lista todos los devices en el catálogo de fabricación.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: array de devices
 */
const listDevices = async (req, res) => {
  try {
    const devices = await ManufacturedDevice.listAll();
    return res.status(200).json(devices);
  } catch (err) {
    console.error('[MANUFACTURED] listDevices error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Revoca un device del catálogo (lo elimina del inventario autorizado).
 * @param {import('express').Request}  req  Params: { deviceId }
 * @param {import('express').Response} res  204: eliminado | 404: no existía
 */
const removeDevice = async (req, res) => {
  const { deviceId } = req.params;

  try {
    const deleted = await ManufacturedDevice.removeDevice(deviceId);

    if (!deleted) {
      return res.status(404).json({ message: 'Device no encontrado en el catálogo' });
    }

    await log({
      userId: req.user.sub,
      action: 'MANUFACTURED_DEVICE_REMOVE',
      targetType: 'manufactured_device',
      targetId: deviceId,
    });

    return res.status(204).send();
  } catch (err) {
    console.error('[MANUFACTURED] removeDevice error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Actualiza el protocolo de un device existente en el catálogo.
 * @param {import('express').Request}  req  Params: { deviceId } | Body: { protocol }
 * @param {import('express').Response} res  200: device actualizado | 400 | 404
 */
const patchDevice = async (req, res) => {
  const { deviceId } = req.params;
  const { protocol } = req.body ?? {};

  if (!VALID_PROTOCOLS.includes(protocol)) {
    return res.status(400).json({ message: `protocol debe ser: ${VALID_PROTOCOLS.join(', ')}` });
  }

  try {
    const device = await ManufacturedDevice.updateProtocol(deviceId, protocol);
    if (!device) return res.status(404).json({ message: 'Device no encontrado' });

    // Propagar el cambio a todos los user_devices vinculados
    await User.updateDeviceProtocol(deviceId, protocol);

    await log({
      userId: req.user.sub,
      action: 'MANUFACTURED_DEVICE_PATCH',
      targetType: 'manufactured_device',
      targetId: deviceId,
      metadata: { protocol },
    });

    return res.status(200).json(device);
  } catch (err) {
    console.error('[MANUFACTURED] patchDevice error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { addDevice, listDevices, removeDevice, patchDevice };
