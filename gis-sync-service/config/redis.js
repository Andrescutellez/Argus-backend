/**
 * @fileoverview Cliente Redis para gis-sync-service.
 *
 * PROPÓSITO:
 *   Redis se usa en Fase 1 (gis-query-service) para cachear resultados de
 *   argus_lookup() y ST_Distance. Aquí solo se establece la conexión;
 *   los jobs de sync no escriben a Redis directamente.
 *
 * TTLs definidos por el sistema (usados en gis-query-service):
 *   pip (point-in-polygon)  → 300s   (5 min, moto en movimiento)
 *   cai_near / est_near     → 3600s  (1h, infraestructura estática)
 *   risk_sca (sector risk)  → 86400s (24h, datos delictivos cambian lento)
 *   risk_dev (device risk)  → 60s    (1 min, riesgo en tiempo real)
 *
 * @module config/redis
 */

'use strict';

const Redis = require('ioredis');

let client = null;

/**
 * @brief Inicializa el cliente Redis y verifica la conexión.
 *
 * FLUJO:
 *   1. Crear cliente ioredis con REDIS_URL.
 *   2. Escuchar eventos connect/error.
 *   3. No hace process.exit si falla — Redis es opcional en Fase 0.
 *
 * @returns {void}
 */
function initRedis() {
  if (!process.env.REDIS_URL) {
    console.warn('[redis] REDIS_URL no definida — cache deshabilitado');
    return;
  }
  client = new Redis(process.env.REDIS_URL);
  client.on('connect', () => console.log('[redis] Conectado'));
  client.on('error',   (err) => console.error('[redis] Error:', err.message));
}

/** @returns {import('ioredis').Redis | null} */
const getRedis = () => client;

module.exports = { initRedis, getRedis };
