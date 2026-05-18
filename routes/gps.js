/**
 * @fileoverview Rutas REST para el canal HTTP de datos GPS.
 *
 * PROPÓSITO:
 *   Definir y montar los tres endpoints del recurso GPS, delegando la lógica
 *   de negocio a gpsController.js. Esta separación (routing vs. lógica) sigue
 *   el patrón MVC: el router solo sabe qué URL mapea a qué handler, sin ejecutar
 *   ninguna lógica directamente.
 *
 * MONTAJE:
 *   Este router se monta en server.js bajo el prefijo '/api/gps':
 *     app.use('/api/gps', gpsRoutes)
 *   Por lo tanto, las rutas de este archivo son relativas a ese prefijo:
 *     '/'            → GET /api/gps, POST /api/gps
 *     '/:deviceId/latest' → GET /api/gps/:deviceId/latest
 *
 * ENDPOINTS DEFINIDOS:
 *   POST /api/gps
 *     → guardarDato() — recibe y persiste un punto GPS por HTTP
 *     → usado por hardware alternativo que no soporta TCP directo
 *
 *   GET /api/gps
 *     → obtenerDatos() — retorna los últimos 100 registros de todos los devices
 *     → usado por el frontend para consultar el historial global
 *
 *   GET /api/gps/:deviceId/latest
 *     → getLatestByDevice() — retorna el registro más reciente de un device
 *     → usado por la app móvil para mostrar la posición actual
 *
 * NOTA SOBRE AUTENTICACIÓN:
 *   Ninguna de estas rutas tiene middleware de autenticación. Cualquier cliente
 *   con acceso a internet puede hacer POST y GET. Deuda técnica — ver mejoras
 *   en gpsController.js.
 *
 * @module routes/gps
 */

'use strict';

const { Router } = require('express');
const { guardarDato, obtenerDatos, getLatestByDevice } = require('../controllers/gpsController');
const { authenticate, requireRole, canAccessDevice } = require('../middleware/auth');

const router = Router();

// POST /api/gps — ingestión por HTTP (hardware alternativo que no usa TCP)
// Solo ADMIN y SUPER_ADMIN pueden ingestar datos via REST.
router.post('/', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), guardarDato);

// GET /api/gps — historial global, solo para operadores
router.get('/', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), obtenerDatos);

// GET /api/gps/:deviceId/latest — última posición: USER solo ve su propio device
router.get('/:deviceId/latest', authenticate, canAccessDevice, getLatestByDevice);

module.exports = router;


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — routes/gps.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este archivo es un "mapa de calles" para las URLs del sistema GPS. No hace
   ningún trabajo real — solo dice "si alguien pide POST a /api/gps, llama
   a guardarDato(); si pide GET, llama a obtenerDatos()". Todo el trabajo
   real lo hace gpsController.js.

   TABLA DE ENDPOINTS:
   Método  | URL                        | Handler              | Propósito
   --------|----------------------------|----------------------|------------------
   POST    | /api/gps                   | guardarDato()        | Recibir dato GPS
   GET     | /api/gps                   | obtenerDatos()       | Historial (100)
   GET     | /api/gps/:deviceId/latest  | getLatestByDevice()  | Última posición

   DEPENDENCIAS:
   - express.Router: para modularizar las rutas
   - controllers/gpsController.js: lógica real de cada endpoint

   DEUDA TÉCNICA:
   - Sin middleware de autenticación en ninguna ruta
   - Sin validación de Content-Type para el POST
   - Sin versionado de API (/v1/, /v2/)

   ═══════════════════════════════════════════════════════════ */
