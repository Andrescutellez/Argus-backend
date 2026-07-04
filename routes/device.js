/**
 * @fileoverview Rutas REST para gestión y control de dispositivos ESP32.
 *
 * PROPÓSITO:
 *   Definir los endpoints que permiten al frontend consultar el estado de un
 *   device (¿está conectado? ¿cuál fue su última posición?) y enviarle comandos
 *   de control (ARM, DISARM, ENGINE_CUT, etc.).
 *
 * MONTAJE:
 *   Este router se monta en server.js bajo el prefijo '/api/device':
 *     app.use('/api/device', deviceRoutes)
 *   Las rutas son relativas a ese prefijo:
 *     '/:deviceId/status'  → GET /api/device/:deviceId/status
 *     '/:deviceId/command' → POST /api/device/:deviceId/command
 *
 * ENDPOINTS DEFINIDOS:
 *   GET /api/device/:deviceId/status
 *     → getDeviceStatus() — retorna conexión TCP activa + última posición GPS
 *     → usado por el dashboard del operador para saber si el device está online
 *
 *   POST /api/device/:deviceId/command
 *     → postCommand() — envía o encola un comando al device (ARM, DISARM, etc.)
 *     → 200 si el device estaba online y recibió el comando inmediatamente
 *     → 202 si el device estaba offline y el comando quedó encolado para la reconexión
 *
 * RELACIÓN CON TCP:
 *   postCommand() llama a sendCommand() de tcp/tcpServer.js. El comando viaja
 *   por la conexión TCP persistente del device, no por HTTP. La ruta REST es
 *   solo la entrada del operador; el transporte real es TCP.
 *
 * NOTA SOBRE AUTENTICACIÓN:
 *   Sin middleware de autenticación. Cualquier cliente puede enviar ARM o ENGINE_CUT
 *   a cualquier device que conozca. Deuda técnica crítica.
 *
 * @module routes/device
 */

'use strict';

const { Router }   = require('express');
const rateLimit     = require('express-rate-limit');
const { getDeviceStatus, postCommand } = require('../controllers/deviceController');
const { authenticate, canAccessDevice } = require('../middleware/auth');

const router = Router();

// Máximo 10 comandos por minuto por IP. Protege contra scripts que manden
// ARM/DISARM/ENGINE_CUT en loop — 10/min es holgado para uso normal.
const commandLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados comandos. Espera un momento.' },
});

// GET /api/device/:deviceId/status — USER ve solo sus devices, ADMIN ve todos
router.get('/:deviceId/status', authenticate, canAccessDevice, getDeviceStatus);

// POST /api/device/:deviceId/command — rate limit antes de auth para frenar brute-force
router.post('/:deviceId/command', commandLimiter, authenticate, canAccessDevice, postCommand);

module.exports = router;


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — routes/device.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este archivo define las "puertas" para hablar con los dispositivos GPS
   instalados en las motos. Una puerta pregunta "¿está conectado y dónde
   está?" (status), y la otra puerta "¡manda este comando al dispositivo!"
   (command). La lógica real de cómo hablar con el dispositivo está en
   deviceController.js y tcp/tcpServer.js.

   TABLA DE ENDPOINTS:
   Método  | URL                            | Handler             | Propósito
   --------|--------------------------------|---------------------|------------------
   GET     | /api/device/:deviceId/status   | getDeviceStatus()   | Estado y posición
   POST    | /api/device/:deviceId/command  | postCommand()       | Enviar comando

   DEPENDENCIAS:
   - express.Router: para modularizar las rutas
   - controllers/deviceController.js: lógica real de cada endpoint

   DEUDA TÉCNICA:
   - Sin autenticación: cualquiera puede enviar ENGINE_CUT a cualquier device
   - Sin rate limiting: un atacante podría flood-ear el endpoint de command
   - Sin logging estructurado a nivel de routing

   ═══════════════════════════════════════════════════════════ */
