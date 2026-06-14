/**
 * @fileoverview Rutas REST para la capa GIS de Argus.
 *
 * PROPÓSITO:
 *   Expone los endpoints geoespaciales que permiten a los frontends
 *   enriquecer coordenadas GPS con contexto policial y territorial.
 *
 * AUTENTICACIÓN:
 *   Los tres endpoints requieren JWT válido via middleware authenticate.
 *   La información de cuadrantes y teléfonos de patrulleros es sensible.
 *
 * ENDPOINTS:
 *   GET /api/gis/lookup?lon=&lat=   → jerarquía territorial + cuadrante + teléfono
 *   GET /api/gis/near?lon=&lat=&type=cai|estacion&limit=3 → POIs más cercanos
 *   GET /api/gis/heatmap            → GeoJSON localidades + datos hurto motos
 *
 * @module routes/gis
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { lookup, near, heatmap, cuadrantes } = require('../controllers/gisController');

const router = Router();

router.get('/lookup',     authenticate, lookup);
router.get('/near',       authenticate, near);
router.get('/heatmap',    authenticate, heatmap);
router.get('/cuadrantes', authenticate, cuadrantes);

module.exports = router;
