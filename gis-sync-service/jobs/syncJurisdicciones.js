/**
 * @fileoverview Sync S8 — Jurisdicciones CAI (153 polígonos).
 *
 * PROPÓSITO:
 *   Carga las 153 jurisdicciones de CAI.
 *   El campo jcai_entorno ("JCAINETORNO") es la variable f₉ del ARU:
 *   indica si un polígono es "entorno priorizado" por la policía.
 *
 * FUENTE:
 *   Tematicos_NR/Territorio_Referencia/FeatureServer/14/query
 *   Campos: JCAICODJURIS, JCAIPCUNOMCAI, JCAINOMEST, JCAIIULOCAL, JCAINETORNO
 *
 * @module jobs/syncJurisdicciones
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT   = 'Tematicos_NR/Territorio_Referencia/FeatureServer/14/query';
const OUT_FIELDS = 'JCAICODJURIS,JCAIPCUNOMCAI,JCAINOMEST,JCAIIULOCAL,JCAINETORNO';

/**
 * @brief Sincroniza las jurisdicciones CAI desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de registros insertados
 */
async function syncJurisdicciones() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncJurisdicciones] Iniciando...');
  await logSync(pool, 'jurisdicciones', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < 100) {
    const msg = `Conteo insuficiente: ${features.length} < 100`;
    await logSync(pool, 'jurisdicciones', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE jurisdicciones_cai');

    for (const f of features) {
      const p   = f.properties;
      const loc = p.JCAIIULOCAL != null ? String(p.JCAIIULOCAL).padStart(2, '0') : null;

      await client.query(
        `INSERT INTO jurisdicciones_cai
           (jcai_cod_juris, jcai_nom_cai, jcai_nom_est, loc_codigo, jcai_entorno, geom, updated_at)
         VALUES ($1, $2, $3, $4, $5,
                 ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)),
                 NOW())`,
        [
          String(p.JCAICODJURIS),
          p.JCAIPCUNOMCAI ?? null,
          p.JCAINOMEST    ?? null,
          loc,
          p.JCAINETORNO   ?? null,
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'jurisdicciones', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'jurisdicciones', 'success', features.length, duration, null);
  console.log(`[syncJurisdicciones] OK — ${features.length} jurisdicciones en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncJurisdicciones };
