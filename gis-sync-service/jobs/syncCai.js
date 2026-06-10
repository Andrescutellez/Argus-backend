/**
 * @fileoverview Sync S2 — Comandos de Atención Inmediata (154 puntos).
 *
 * PROPÓSITO:
 *   Carga los 154 CAI de Bogotá para el feature "CAI más cercano".
 *
 * FUENTE:
 *   Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/22/query
 *
 * ADVERTENCIA CONOCIDA:
 *   Los campos EPOSERVICIO y EPOHORARIO en outFields causan HTTP 400 en S2.
 *   NO incluirlos en OUT_FIELDS. Ver nota en GIS — Integraciones OAIEE.md.
 *
 * @module jobs/syncCai
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT   = 'Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/22/query';
// EPOSERVICIO y EPOHORARIO OMITIDOS intencionalmente — HTTP 400 en este endpoint
const OUT_FIELDS = 'OBJECTID,EPONOMBRE,EPODIR_SITIO,EPOLATITUD,EPOLONGITU,EPOIULOCAL';

/**
 * @brief Sincroniza los CAI de Bogotá desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de CAI insertados
 */
async function syncCai() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncCai] Iniciando...');
  await logSync(pool, 'cai', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < 100) {
    const msg = `Conteo insuficiente: ${features.length} < 100`;
    await logSync(pool, 'cai', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE cai');

    for (const f of features) {
      const p   = f.properties;
      const lat = p.EPOLATITUD ?? null;
      const lon = p.EPOLONGITU ?? null;
      const loc = p.EPOIULOCAL != null ? String(p.EPOIULOCAL).padStart(2, '0') : null;

      await client.query(
        `INSERT INTO cai
           (epo_objectid, epo_nombre, epo_direccion, epo_lat, epo_lon, loc_codigo, geom, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 ST_SetSRID(ST_GeomFromGeoJSON($7), 4326),
                 NOW())`,
        [p.OBJECTID, p.EPONOMBRE ?? null, p.EPODIR_SITIO ?? null, lat, lon, loc, geomStr(f)]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'cai', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'cai', 'success', features.length, duration, null);
  console.log(`[syncCai] OK — ${features.length} CAI en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncCai };
