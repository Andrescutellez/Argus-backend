/**
 * @fileoverview Controlador REST para la vista de flota del web operador.
 *
 * PROPÓSITO:
 *   Retornar todos los usuarios con sus motos y dispositivos en una sola
 *   respuesta, enriquecida con el estado TCP en tiempo real (connected).
 *   Solo accesible para ADMIN y SUPER_ADMIN.
 *
 * @module controllers/fleetController
 */

'use strict';

const User = require('../models/User');
const { connectedDevices } = require('../tcp/tcpServer');

/**
 * @brief Retorna la flota completa: usuarios → motos → dispositivos + estado TCP.
 *
 * RESPUESTA:
 *   Array de usuarios, cada uno con su array de motos, cada moto con su
 *   dispositivo (si tiene) y su estado de conexión TCP en tiempo real.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res  200: Array<FleetUser>
 */
const getFleet = async (req, res) => {
  try {
    const users = await User.getAllUsersWithDevices();

    // Enriquecer con estado TCP en tiempo real
    for (const user of users) {
      for (const moto of user.motos) {
        if (moto.deviceId) {
          moto.connected = connectedDevices.has(moto.deviceId);
        } else {
          moto.connected = false;
        }
      }
    }

    return res.status(200).json(users);
  } catch (err) {
    console.error('[FLEET] getFleet error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { getFleet };
