/**
 * @fileoverview Rutas REST para el módulo Garage de Argus Secure.
 *
 * PROPÓSITO:
 *   Define todos los endpoints HTTP del Garage bajo el prefijo /api/garage
 *   (configurado en server.js). Todos los endpoints requieren autenticación JWT.
 *
 * MONTAJE: app.use('/api/garage', garageRoutes)
 *
 * ENDPOINTS:
 *   GET    /api/garage/documents          — listar documentos con estado de vigencia
 *   PUT    /api/garage/documents/:type    — crear/actualizar documento por tipo
 *   GET    /api/garage/maintenance               — listar mantenimientos con progreso
 *   PUT    /api/garage/maintenance/:type         — crear/actualizar mantenimiento por tipo
 *   PATCH  /api/garage/maintenance/:type/active  — activar/desactivar seguimiento de un tipo
 *   GET    /api/garage/fuel               — historial de combustible + resumen
 *   POST   /api/garage/fuel               — registrar nuevo fill-up
 *   DELETE /api/garage/fuel/:id           — eliminar fill-up
 *   GET    /api/garage/expenses           — historial de gastos + totales anuales
 *   POST   /api/garage/expenses           — registrar nuevo gasto
 *   DELETE /api/garage/expenses/:id       — eliminar gasto
 *   GET    /api/garage/score              — score de salud del vehículo (0–100)
 *   GET    /api/garage/agenda             — próximos eventos de documentos y mantenimiento
 *   PATCH  /api/garage/odometer           — actualizar odómetro manualmente
 *
 * PATRÓN DE AUTENTICACIÓN:
 *   router.use(authenticate) aplica el middleware a todos los endpoints de este router.
 *   CRÍTICO: importar con destructuring { authenticate } — ver middleware/auth.js.
 *
 * @module routes/garage
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getDocuments,
  upsertDocument,
  getMaintenance,
  upsertMaintenance,
  setMaintenanceActive,
  getFuel,
  addFuel,
  deleteFuel,
  getExpenses,
  addExpense,
  deleteExpense,
  getScore,
  getAgenda,
  updateOdometer,
} = require('../controllers/garageController');

const router = Router();

// Todos los endpoints del Garage requieren autenticación JWT.
// Aplica authenticate() a todos los handlers de este router sin repetirlo en cada ruta.
router.use(authenticate);

// ─── DOCUMENTOS ──────────────────────────────────────────────────────────────
router.get('/documents',        getDocuments);
router.put('/documents/:type',  upsertDocument);

// ─── MANTENIMIENTO ────────────────────────────────────────────────────────────
router.get('/maintenance',               getMaintenance);
router.put('/maintenance/:type',         upsertMaintenance);
router.patch('/maintenance/:type/active', setMaintenanceActive);

// ─── COMBUSTIBLE ──────────────────────────────────────────────────────────────
router.get('/fuel',        getFuel);
router.post('/fuel',       addFuel);
router.delete('/fuel/:id', deleteFuel);

// ─── GASTOS ───────────────────────────────────────────────────────────────────
router.get('/expenses',           getExpenses);
router.post('/expenses',          addExpense);
router.delete('/expenses/:id',    deleteExpense);

// ─── SCORE Y AGENDA ───────────────────────────────────────────────────────────
router.get('/score',  getScore);
router.get('/agenda', getAgenda);

// ─── ODÓMETRO ─────────────────────────────────────────────────────────────────
router.patch('/odometer', updateOdometer);

module.exports = router;
