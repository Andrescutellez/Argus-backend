/**
 * @fileoverview Rutas REST para la capa meteorológica de Argus.
 *
 * PROPÓSITO:
 *   Expone los endpoints de datos climáticos en tiempo real.
 *   Actúa como proxy al SAB (Sistema de Alerta de Bogotá) para evitar
 *   el bloqueo CORS que impide al frontend consultar el SAB directamente.
 *
 * AUTENTICACIÓN:
 *   Requiere JWT válido. Los datos de lluvia en tiempo real son una feature
 *   del producto — no se exponen sin sesión activa.
 *
 * ENDPOINTS:
 *   GET /api/weather/lluvia → 71 estaciones pluviométricas SAB con intensidad
 *
 * @module routes/weather
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { lluvia, radarImage, radarBounds } = require('../controllers/weatherController');

const router = Router();

router.get('/lluvia',        authenticate, lluvia);
router.get('/radar/image',   authenticate, radarImage);
router.get('/radar/bounds',  authenticate, radarBounds);

module.exports = router;
