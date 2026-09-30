/**
 * @fileoverview Controlador REST para gestión de motos.
 *
 * PROPÓSITO:
 *   CRUD de motos asociadas al usuario autenticado. Cada moto pertenece a un
 *   usuario y puede tener un device ESP32 instalado.
 *
 * FLUJO GENERAL:
 *   Todas las operaciones leen req.user.sub (UUID del usuario autenticado, inyectado
 *   por el middleware authenticate()). Un USER solo opera sobre sus propias motos.
 *   Un ADMIN puede ver motos de cualquier usuario (por implementar si se necesita).
 *
 * @module controllers/motoController
 */

'use strict';

const Moto               = require('../models/Moto');
const Device             = require('../models/Device');
const User               = require('../models/User');
const ManufacturedDevice = require('../models/ManufacturedDevice');
const { log }            = require('../models/AuditLog');

/**
 * @brief Crea una nueva moto para el usuario autenticado.
 * @param {import('express').Request}  req  Body: { alias, placa, marca, modelo, color, anio }
 * @param {import('express').Response} res  201: moto creada | 400: datos inválidos
 */
const createMoto = async (req, res) => {
  const { alias, placa, marca, modelo, color, anio } = req.body ?? {};

  try {
    const moto = await Moto.createMoto({
      userId: req.user.sub,
      alias, placa, marca, modelo, color, anio,
    });

    await log({
      userId: req.user.sub,
      action: 'MOTO_CREATE',
      targetType: 'moto',
      targetId: moto.id,
      metadata: { placa, alias },
    });

    return res.status(201).json(moto);
  } catch (err) {
    console.error('[MOTO] createMoto error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna todas las motos del usuario autenticado.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: array de motos
 */
const getMotos = async (req, res) => {
  try {
    const motos = await Moto.getMotosByUser(req.user.sub);
    return res.status(200).json(motos);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna una moto por ID, con el device instalado si existe.
 * @param {import('express').Request}  req  Params: { motoId }
 * @param {import('express').Response} res  200: moto + device | 404: no existe | 403: no es del usuario
 */
const getMoto = async (req, res) => {
  try {
    const moto = await Moto.getMotoById(req.params.motoId);

    if (!moto) return res.status(404).json({ message: 'Moto no encontrada' });

    // Un USER solo puede ver sus propias motos
    if (req.user.role === 'USER' && moto.user_id !== req.user.sub) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const device = await Device.getDeviceByMoto(moto.id);
    return res.status(200).json({ ...moto, device: device ?? null });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Actualiza los campos de una moto.
 * @param {import('express').Request}  req  Params: { motoId } | Body: campos a actualizar
 * @param {import('express').Response} res  200: moto actualizada | 404 | 403
 */
const updateMoto = async (req, res) => {
  try {
    const moto = await Moto.getMotoById(req.params.motoId);

    if (!moto) return res.status(404).json({ message: 'Moto no encontrada' });

    if (req.user.role === 'USER' && moto.user_id !== req.user.sub) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    const updated = await Moto.updateMoto(req.params.motoId, req.body ?? {});

    await log({
      userId: req.user.sub,
      action: 'MOTO_UPDATE',
      targetType: 'moto',
      targetId: moto.id,
      metadata: req.body,
    });

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Elimina una moto. El device instalado queda sin moto asignada (SET NULL).
 * @param {import('express').Request}  req  Params: { motoId }
 * @param {import('express').Response} res  204: eliminada | 404 | 403
 */
const deleteMoto = async (req, res) => {
  try {
    const moto = await Moto.getMotoById(req.params.motoId);

    if (!moto) return res.status(404).json({ message: 'Moto no encontrada' });

    if (req.user.role === 'USER' && moto.user_id !== req.user.sub) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    await Moto.deleteMoto(req.params.motoId);

    await log({
      userId: req.user.sub,
      action: 'MOTO_DELETE',
      targetType: 'moto',
      targetId: req.params.motoId,
    });

    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Asigna un device ESP32 a una moto.
 * @param {import('express').Request}  req  Params: { motoId } | Body: { deviceId }
 * @param {import('express').Response} res  200: device asignado | 404 | 400
 */
const assignDevice = async (req, res) => {
  const { deviceId } = req.body ?? {};

  if (!deviceId) return res.status(400).json({ message: 'deviceId requerido' });

  try {
    const moto = await Moto.getMotoById(req.params.motoId);
    if (!moto) return res.status(404).json({ message: 'Moto no encontrada' });

    if (req.user.role === 'USER' && moto.user_id !== req.user.sub) {
      return res.status(403).json({ message: 'Acceso denegado' });
    }

    // Bloquear si el device no está en el catálogo de fabricación.
    // Esto impide que usuarios registren MACs inventadas o dispositivos clonados.
    const manufactured = await ManufacturedDevice.isManufactured(deviceId);
    if (!manufactured) {
      return res.status(403).json({ message: 'El dispositivo no está autorizado por el fabricante' });
    }

    // Bloquear si el device ya pertenece a OTRO usuario
    const currentOwner = await User.getDeviceOwner(deviceId);
    if (currentOwner && currentOwner !== req.user.sub) {
      return res.status(409).json({ message: 'El dispositivo ya está registrado por otro usuario' });
    }

    // Bloquear si el device ya está instalado en UNA MOTO DISTINTA del mismo usuario
    const existingDevice = await Device.getDeviceById(deviceId);
    if (existingDevice?.moto_id && existingDevice.moto_id !== moto.id) {
      return res.status(409).json({ message: 'El dispositivo ya está instalado en otra moto. Desinstálalo primero.' });
    }

    // Crear el device si no existe aún en la tabla devices
    await Device.createDevice({ deviceId });
    const device = await Device.assignToMoto(deviceId, moto.id);

    // Leer el protocolo del catálogo para propagarlo a user_devices
    const protocol = await ManufacturedDevice.getProtocol(deviceId);

    // Vincular el device al usuario para que canAccessDevice y el JWT funcionen
    await User.addDevice(req.user.sub, deviceId, protocol);

    await log({
      userId: req.user.sub,
      action: 'DEVICE_ASSIGN',
      targetType: 'device',
      targetId: deviceId,
      metadata: { motoId: moto.id },
    });

    return res.status(200).json(device);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { createMoto, getMotos, getMoto, updateMoto, deleteMoto, assignDevice };
