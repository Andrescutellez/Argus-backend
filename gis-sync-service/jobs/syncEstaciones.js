/**
 * @fileoverview Sync S1 — Estaciones de Policía (21 puntos).
 *
 * PROPÓSITO:
 *   Carga las 21 estaciones de policía (1 por localidad).
 *   Feature: "Estación más cercana" → GET /gis/estacion-near.
 *
 * FUENTE:
 *   Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/23/query
 *   Campos: OBJECTID, EPONOMBRE, EPODIR_SITIO, EPOLATITUD, EPOLONGITU, EPOTELEFON, EPOIULOCAL
 *
 * @module jobs/syncEstaciones
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT   = 'Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/23/query';
const OUT_FIELDS = 'OBJECTID,EPONOMBRE,EPODIR_SITIO,EPOLATITUD,EPOLONGITU,EPOTELEFON,EPOIULOCAL';

/**
 * @brief Sincroniza las estaciones de policía desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de estaciones insertadas
 */
async function syncEstaciones() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncEstaciones] Iniciando...');
  await logSync(pool, 'estaciones', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < 15) {
    const msg = `Conteo insuficiente: ${features.length} < 15`;
    await logSync(pool, 'estaciones', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE estaciones_policia');

    for (const f of features) {
      const p   = f.properties;
      const loc = p.EPOIULOCAL != null ? String(p.EPOIULOCAL).padStart(2, '0') : null;

      await client.query(
        `INSERT INTO estaciones_policia
           (epo_objectid, epo_nombre, epo_direccion, epo_lat, epo_lon,
            epo_telefono, loc_codigo, geom, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 ST_SetSRID(ST_GeomFromGeoJSON($8), 4326),
                 NOW())`,
        [
          p.OBJECTID,
          p.EPONOMBRE    ?? null,
          p.EPODIR_SITIO ?? null,
          p.EPOLATITUD   ?? null,
          p.EPOLONGITU   ?? null,
          p.EPOTELEFON   ?? null,
          loc,
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'estaciones', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'estaciones', 'success', features.length, duration, null);
  console.log(`[syncEstaciones] OK — ${features.length} estaciones en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncEstaciones };
