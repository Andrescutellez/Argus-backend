/**
 * @fileoverview Rutas REST — criminalidad por localidad y departamento.
 *
 * ENDPOINTS:
 *   GET /api/crime/bogota              → GeoJSON 20 localidades (cache 24h)
 *   GET /api/crime/bogota/lookup?lat=&lon= → Localidad contenedora del punto GPS
 *   GET /api/crime/nacional            → Hurtos motos por departamento (12 meses)
 *
 * AUTENTICACIÓN: todas requieren JWT válido (middleware authenticate).
 *
 * @module routes/crime
 */

'use strict';

const router     = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getBogota, getBogotaLookup, getNacional } = require('../controllers/crimeController');

router.get('/bogota/lookup', authenticate, getBogotaLookup);
router.get('/bogota',        authenticate, getBogota);
router.get('/nacional',      authenticate, getNacional);

module.exports = router;
