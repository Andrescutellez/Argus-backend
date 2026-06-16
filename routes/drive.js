/**
 * @fileoverview Rutas REST para métricas de conducción del sistema Argus.
 *
 * PROPÓSITO:
 *   Definir los endpoints HTTP de la sección "Conducción" de la plataforma.
 *   Los datos que sirven estos endpoints provienen de los frames DRIVE que
 *   el ESP32 envía por TCP tras acumular métricas del MPU6050 en cada ventana GPS.
 *
 * ENDPOINTS:
 *   GET /api/drive/metrics/:deviceId?days=7
 *     → Historial de conducción del dispositivo con score, stats y breakdown diario.
 *       Ver driveController.js para el detalle del algoritmo de scoring.
 *
 * @module routes/drive
 */

'use strict';

const { Router } = require('express');
const { getMetrics } = require('../controllers/driveController');

const router = Router();

/**
 * GET /api/drive/metrics/:deviceId
 *
 * Query params:
 *   - days (opcional, default 7, max 365): período en días hacia atrás desde hoy.
 *
 * Response 200:
 *   {
 *     deviceId: string,
 *     period: { days: number, from: string, to: string },
 *     score: number,       // 0-100, mayor = mejor conductor
 *     stats: {
 *       sessionCount: number,
 *       totalHardEvents: number,
 *       totalSoftEvents: number,
 *       maxPeakAccelDev: number,   // g
 *       maxPeakGyroMag:  number,   // °/s
 *     },
 *     dailyBreakdown: [{ date, score, hardCount, softCount, sessionCount, maxPeakAccelDev }],
 *     sessions: [{ id, lat, lon, peakAccelDev, peakGyroMag, hardCount, softCount, timestamp }]
 *   }
 *
 * Response 400: si deviceId está vacío.
 * Response 500: si hay error de base de datos.
 */
router.get('/metrics/:deviceId', getMetrics);

module.exports = router;


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — routes/drive.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este archivo define qué URLs existen bajo /api/drive y qué función las maneja.
   Es deliberadamente delgado: la lógica vive en driveController.js. El router
   actúa solo como tabla de ruteo entre URL y controlador.

   DIAGRAMA MENTAL:
   server.js → app.use('/api/drive', driveRoutes)
   GET /api/drive/metrics/:deviceId → driveController.getMetrics()

   ═══════════════════════════════════════════════════════════ */
