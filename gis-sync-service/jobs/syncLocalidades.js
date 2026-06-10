/**
 * @fileoverview Sync S5 — Localidades de Bogotá (21 polígonos).
 *
 * PROPÓSITO:
 *   Carga las 21 localidades desde OAIEE hacia la tabla `localidades`.
 *   Es la tabla base de todo el schema GIS — debe sincronizarse primero.
 *
 * FUENTE:
 *   Tematicos_NR/Territorio_Referencia/FeatureServer/3/query
 *   Campos: LOCCODIGO, LOCNOMBRE, LOCAREA
 *
 * FLUJO:
 *   1. Descargar ~20 features (1 página suficiente).
 *   2. Validar conteo >= 20.
 *   3. TRUNCATE + INSERT en transacción.
 *   4. Registrar en gis_sync_log.
 *
 * DEPENDENCIAS:
 *   - oaieeClient.js (fetchAll, geomStr)
 *   - config/db.js (getPool)
 *
 * @module jobs/syncLocalidades
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT     = 'Tematicos_NR/Territorio_Referencia/FeatureServer/3/query';
const OUT_FIELDS   = 'LOCCODIGO,LOCNOMBRE,LOCAREA';
const MIN_EXPECTED = 20;

/**
 * @brief Sincroniza las localidades de Bogotá desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de registros insertados
 * @throws {Error} Si el conteo de features es menor a MIN_EXPECTED
 */
async function syncLocalidades() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncLocalidades] Iniciando...');
  await logSync(pool, 'localidades', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < MIN_EXPECTED) {
    const msg = `Conteo insuficiente: ${features.length} < ${MIN_EXPECTED}`;
    await logSync(pool, 'localidades', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE localidades CASCADE');

    for (const f of features) {
      const p = f.properties;
      await client.query(
        `INSERT INTO localidades (loc_codigo, loc_nombre, loc_area_m2, geom)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)))`,
        [
          p.LOCCODIGO?.toString().padStart(2, '0'),
          p.LOCNOMBRE,
          p.LOCAREA ?? null,
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'localidades', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'localidades', 'success', features.length, duration, null);
  console.log(`[syncLocalidades] OK — ${features.length} localidades en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncLocalidades };
