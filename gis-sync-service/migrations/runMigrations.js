/**
 * @fileoverview Runner de migraciones GIS.
 *
 * PROPÓSITO:
 *   Ejecuta 01_gis_schema.sql sobre la base de datos argus.
 *   PostGIS debe estar habilitado primero (00_enable_postgis.sql como superusuario).
 *
 * FLUJO:
 *   1. Conectar al pool de PostgreSQL.
 *   2. Leer 01_gis_schema.sql del disco.
 *   3. Ejecutar el SQL completo en una transacción.
 *   4. Si falla, hace rollback y sale con código 1.
 *
 * USO:
 *   node migrations/runMigrations.js
 *
 * PREREQUISITO:
 *   sudo -u postgres psql -d argus -f migrations/00_enable_postgis.sql
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] ERROR: DATABASE_URL no definida en .env');
    process.exit(1);
  }

  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  const sqlPath = path.join(__dirname, '01_gis_schema.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('[migrate] Aplicando 01_gis_schema.sql...');
  const t0 = Date.now();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[migrate] Schema GIS aplicado en ${Date.now() - t0}ms`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] ERROR — rollback ejecutado:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
