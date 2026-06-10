/**
 * @fileoverview Entry point del gis-sync-service.
 *
 * PROPÓSITO:
 *   Microservicio ETL que sincroniza datos geoespaciales de OAIEE a PostGIS.
 *   Expone endpoints REST para disparar syncs manualmente y ver estado.
 *   Programa syncs automáticos via node-cron según frecuencia de actualización OAIEE.
 *
 * ARQUITECTURA:
 *   Express (REST) + node-cron (scheduling) + pg (PostGIS) + ioredis (cache Fase 1)
 *
 * ENDPOINTS:
 *   GET  /health                   — estado del servicio
 *   GET  /sync/status              — último sync de cada job
 *   POST /sync/full                — sync completo en orden correcto (inicial)
 *   POST /sync/localidades         — S5 — 21 localidades
 *   POST /sync/upz                 — S6 — 123 UPZ
 *   POST /sync/sectores            — S7 — 1196 sectores catastrales
 *   POST /sync/cuadrantes          — S3 — 599 cuadrantes + teléfono patrullero ⭐
 *   POST /sync/cai                 — S2 — 154 CAI
 *   POST /sync/estaciones          — S1 — 21 estaciones
 *   POST /sync/jurisdicciones-cai  — S8 — 153 jurisdicciones
 *   POST /sync/entornos            — S9 — 59384 entornos (tabla maestra) ⭐
 *   POST /sync/delitos-motos       — P1 — hurto motos histórico
 *   POST /sync/nuse                — P2 — incidentes NUSE por sector
 *   POST /sync/rnmc                — P3 — RNMC por sector
 *
 * CRON SCHEDULE (hora Bogotá = UTC-5):
 *   Anual    (1 enero 2am):   cuadrantes, cai, estaciones, jurisdicciones
 *   Semestral (1 ene/jul 3am): entornos (job más pesado)
 *   Mensual  (día 2, 2am):    localidades, upz, sectores (en teoría estáticos pero verificar)
 *   Mensual  (día 2, 3am):    delitos-motos, nuse, rnmc
 *
 * PUERTO:
 *   4000 (solo interno — no exponer al exterior vía nginx)
 *
 * VARIABLES CRÍTICAS:
 *   DATABASE_URL — conexión PostgreSQL
 *   REDIS_URL    — conexión Redis (opcional en Fase 0)
 *   PORT         — puerto del servidor (default 4000)
 *
 * ESTADO INICIAL:
 *   Al arrancar por primera vez, ejecutar POST /sync/full para cargar todos los datasets.
 *   Tiempo estimado: ~5 min (dominado por S9 entornos = 30 páginas).
 *
 * @module server
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const { initDb, getPool } = require('./config/db');
const { initRedis }       = require('./config/redis');

const { syncLocalidades }   = require('./jobs/syncLocalidades');
const { syncUpz }           = require('./jobs/syncUpz');
const { syncSectores }      = require('./jobs/syncSectores');
const { syncCuadrantes }    = require('./jobs/syncCuadrantes');
const { syncCai }           = require('./jobs/syncCai');
const { syncEstaciones }    = require('./jobs/syncEstaciones');
const { syncJurisdicciones } = require('./jobs/syncJurisdicciones');
const { syncEntornos }      = require('./jobs/syncEntornos');
const { syncDelitosMotos }  = require('./jobs/syncDelitosMotos');
const { syncNuse }          = require('./jobs/syncNuse');
const { syncRnmc }          = require('./jobs/syncRnmc');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

// ============================================================
// Helpers
// ============================================================

/**
 * @brief Wrapper para ejecutar un job de sync y responder con resultado.
 *
 * @param {Function} jobFn   Función async del job
 * @param {string}   jobName Nombre legible para logging
 * @param {object}   res     Express response
 */
async function runJob(jobFn, jobName, res) {
  console.log(`[server] POST /sync/${jobName} disparado manualmente`);
  try {
    const count = await jobFn();
    res.json({ ok: true, job: jobName, records: count });
  } catch (err) {
    console.error(`[server] Job ${jobName} falló:`, err.message);
    res.status(500).json({ ok: false, job: jobName, error: err.message });
  }
}

// ============================================================
// Endpoints de estado
// ============================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gis-sync-service', ts: new Date().toISOString() });
});

/**
 * @brief Devuelve el último registro de gis_sync_log por job.
 * Útil para monitorear cuándo fue el último sync exitoso de cada dataset.
 */
app.get('/sync/status', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT ON (job_name)
        job_name, status, records_synced, duration_ms, error_msg, synced_at
      FROM gis_sync_log
      ORDER BY job_name, synced_at DESC
    `);
    res.json({ ok: true, jobs: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// Endpoints de sync individual
// ============================================================

app.post('/sync/localidades',        (req, res) => runJob(syncLocalidades,    'localidades',       res));
app.post('/sync/upz',                (req, res) => runJob(syncUpz,            'upz',               res));
app.post('/sync/sectores',           (req, res) => runJob(syncSectores,       'sectores',          res));
app.post('/sync/cuadrantes',         (req, res) => runJob(syncCuadrantes,     'cuadrantes',        res));
app.post('/sync/cai',                (req, res) => runJob(syncCai,            'cai',               res));
app.post('/sync/estaciones',         (req, res) => runJob(syncEstaciones,     'estaciones',        res));
app.post('/sync/jurisdicciones-cai', (req, res) => runJob(syncJurisdicciones, 'jurisdicciones',    res));
app.post('/sync/entornos',           (req, res) => runJob(syncEntornos,       'entornos',          res));
app.post('/sync/delitos-motos',      (req, res) => runJob(syncDelitosMotos,   'delitos_motos',     res));
app.post('/sync/nuse',               (req, res) => runJob(syncNuse,           'nuse',              res));
app.post('/sync/rnmc',               (req, res) => runJob(syncRnmc,           'rnmc',              res));

// ============================================================
// Sync completo — ejecutar en orden de dependencias FK
// ============================================================

/**
 * @brief Sync completo secuencial en orden correcto de FKs.
 *
 * ORDEN:
 *   1. localidades  (base de todo)
 *   2. upz          (FK → localidades)
 *   3. sectores     (FK → localidades, upz)
 *   4. cuadrantes   (FK → localidades, sectores, upz) ⭐
 *   5. cai          (FK → localidades)
 *   6. estaciones   (FK → localidades)
 *   7. jurisdicciones (FK → localidades)
 *   8. entornos     (FK → localidades, upz, sectores) ⭐
 *   9. delitos-motos (FK → localidades)
 *  10. nuse         (FK → sectores)
 *  11. rnmc         (FK → sectores)
 *
 * @note Este endpoint bloquea hasta completar todos los syncs (~5 min).
 *       Ideal para la carga inicial. No tiene timeout de Express — usar tmux.
 */
app.post('/sync/full', async (_req, res) => {
  console.log('[server] POST /sync/full — sync completo iniciado');
  const results = [];

  const jobs = [
    { name: 'localidades',    fn: syncLocalidades    },
    { name: 'upz',            fn: syncUpz            },
    { name: 'sectores',       fn: syncSectores       },
    { name: 'cuadrantes',     fn: syncCuadrantes     },
    { name: 'cai',            fn: syncCai            },
    { name: 'estaciones',     fn: syncEstaciones     },
    { name: 'jurisdicciones', fn: syncJurisdicciones },
    { name: 'entornos',       fn: syncEntornos       },
    { name: 'delitos_motos',  fn: syncDelitosMotos   },
    { name: 'nuse',           fn: syncNuse           },
    { name: 'rnmc',           fn: syncRnmc           },
  ];

  for (const job of jobs) {
    try {
      console.log(`[server] Ejecutando job: ${job.name}`);
      const count = await job.fn();
      results.push({ job: job.name, ok: true, records: count });
    } catch (err) {
      console.error(`[server] Job ${job.name} falló:`, err.message);
      results.push({ job: job.name, ok: false, error: err.message });
      // Continuar con el siguiente job aunque uno falle
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  res.json({ ok: failed === 0, results, failed });
});

// ============================================================
// Cron jobs — sincronización automática
// ============================================================

/**
 * Tablas estáticas: sync anual (1 enero, 2am UTC-5 = 7am UTC).
 * Cuadrantes también aquí: la policía reorganiza cuadrantes ~1 vez/año.
 */
cron.schedule('0 7 1 1 *', async () => {
  console.log('[cron] Sync anual iniciado');
  for (const fn of [syncCuadrantes, syncCai, syncEstaciones, syncJurisdicciones]) {
    try { await fn(); } catch (err) { console.error('[cron] Error:', err.message); }
  }
});

/**
 * Entornos: sync semestral (1 enero y 1 julio, 3am UTC-5 = 8am UTC).
 * Job más pesado (~2.5 min). Después de cuadrantes del mismo día.
 */
cron.schedule('0 8 1 1,7 *', async () => {
  console.log('[cron] Sync semestral entornos iniciado');
  try { await syncEntornos(); } catch (err) { console.error('[cron] Error entornos:', err.message); }
});

/**
 * Datos delictivos: sync mensual (día 2, 3am UTC-5 = 8am UTC).
 * OAIEE actualiza CifrasSCJ mensualmente.
 */
cron.schedule('0 8 2 * *', async () => {
  console.log('[cron] Sync mensual datos delictivos iniciado');
  for (const fn of [syncDelitosMotos, syncNuse, syncRnmc]) {
    try { await fn(); } catch (err) { console.error('[cron] Error:', err.message); }
  }
});

// ============================================================
// Arranque
// ============================================================

async function start() {
  await initDb();
  initRedis();

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] gis-sync-service escuchando en http://127.0.0.1:${PORT}`);
    console.log('[server] Para sync inicial: POST http://127.0.0.1:4000/sync/full');
    console.log('[server] Para ver estado:   GET  http://127.0.0.1:4000/sync/status');
  });
}

start();

/*
 * =============================================================
 * RESUMEN PARA HUMANO
 * =============================================================
 * Este archivo es el entry point del gis-sync-service.
 * Levanta un servidor Express en el puerto 4000 (solo localhost)
 * que expone endpoints para disparar syncs manualmente y ver logs.
 * También programa los cron jobs para actualizaciones automáticas.
 *
 * PSEUDOCÓDIGO:
 *   init() {
 *     conectar PostgreSQL
 *     conectar Redis (opcional)
 *     montar rutas Express
 *     registrar cron jobs
 *     escuchar en localhost:4000
 *   }
 *
 *   POST /sync/full {
 *     para cada job en [localidades, upz, sectores, cuadrantes, ...] {
 *       ejecutar job() secuencialmente (respeta FKs)
 *       registrar resultado
 *     }
 *     devolver resumen
 *   }
 *
 * DIAGRAMA MENTAL:
 *   [OAIEE API] → fetchAll() → jobs/sync*.js → PostgreSQL + PostGIS
 *                                                      ↓
 *                                           [argus_lookup() disponible]
 *                                                      ↓
 *                              [tcpServer.js llama argus_lookup en cada GPS fix]
 *
 * MEJORAS RECOMENDADAS:
 *   - Agregar autenticación al endpoint /sync/* (solo IPs internas)
 *   - Implementar notificación por email/Slack si un sync falla
 *   - Paralelizar syncs independientes (cai + estaciones + jurisdicciones)
 *   - Dashboard de monitoreo con Grafana conectado a gis_sync_log
 *
 * DEUDA TÉCNICA:
 *   - Nombres de campos P2 (NUSE) y P3 (RNMC) sin confirmar contra FeatureServer
 *   - POST /sync/full bloquea el proceso (no hay worker threads)
 *   - No hay retry automático si el cron job falla
 * =============================================================
 */
