/**
 * @fileoverview Pool de conexión a PostgreSQL para gis-sync-service.
 *
 * PROPÓSITO:
 *   Singleton de pg.Pool compartido por todos los jobs de sincronización.
 *   Reutiliza la misma DATABASE_URL del backend principal (misma BD argus).
 *
 * VARIABLES CRÍTICAS:
 *   DATABASE_URL — connection string PostgreSQL. Sin ella, process.exit(1).
 *
 * @module config/db
 */

'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * @brief Inicializa el pool y verifica la conexión.
 *
 * FLUJO:
 *   1. Crear Pool con DATABASE_URL.
 *   2. Probar con SELECT 1.
 *   3. Fallar rápido si no hay conexión.
 *
 * @returns {Promise<void>}
 */
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.error('[db] ERROR: DATABASE_URL no definida');
    process.exit(1);
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('SELECT 1');
    console.log('[db] PostgreSQL conectado');
  } catch (err) {
    console.error('[db] Error de conexión:', err.message);
    process.exit(1);
  }
}

/** @returns {import('pg').Pool} */
const getPool = () => pool;

module.exports = { initDb, getPool };
