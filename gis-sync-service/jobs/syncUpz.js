/**
 * @fileoverview Sync S6 — Unidades de Planeamiento Zonal (123 polígonos).
 *
 * PROPÓSITO:
 *   Carga las 123 UPZ desde OAIEE hacia la tabla `upz`.
 *   Depende de que `localidades` ya esté cargada (FK loc_codigo).
 *
 * FUENTE:
 *   Tematicos_NR/Territorio_Referencia/FeatureServer/2/query
 *   Campos: UPLCODIGO, UPLNOMBRE, UPLCLASIF, UPLAREA, LOCCODIGO
 *
 * @module jobs/syncUpz
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT     = 'Tematicos_NR/Territorio_Referencia/FeatureServer/2/query';
const OUT_FIELDS   = 'UPLCODIGO,UPLNOMBRE,UPLCLASIF,UPLAREA,LOCCODIGO';
const MIN_EXPECTED = 110;

/**
 * @brief Sincroniza las UPZ de Bogotá desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de registros insertados
 * @throws {Error} Si el conteo de features es menor a MIN_EXPECTED
 */
async function syncUpz() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncUpz] Iniciando...');
  await logSync(pool, 'upz', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < MIN_EXPECTED) {
    const msg = `Conteo insuficiente: ${features.length} < ${MIN_EXPECTED}`;
    await logSync(pool, 'upz', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE upz CASCADE');

    for (const f of features) {
      const p = f.properties;
      await client.query(
        `INSERT INTO upz (upl_codigo, upl_nombre, upl_tipo, upl_area_m2, loc_codigo, geom)
         VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)))`,
        [
          p.UPLCODIGO?.toString(),
          p.UPLNOMBRE,
          p.UPLCLASIF ?? null,
          p.UPLAREA   ?? null,
          p.LOCCODIGO?.toString().padStart(2, '0'),
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'upz', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'upz', 'success', features.length, duration, null);
  console.log(`[syncUpz] OK — ${features.length} UPZ en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncUpz };
