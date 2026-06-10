/**
 * @fileoverview Sync S7 — Sectores Catastrales (1,196 polígonos).
 *
 * PROPÓSITO:
 *   Carga los 1,196 sectores catastrales desde OAIEE.
 *   Es la clave de join para P1 (hurto motos), P2 (NUSE), P3 (RNMC).
 *   Depende de `localidades` y `upz`.
 *
 * FUENTE:
 *   Tematicos_NR/Territorio_Referencia/FeatureServer/1/query
 *   Campos: SCACODIGO, SCANOMBRE, LOCCODIGO
 *   (UPLCODIGO no disponible en S7 — se deja NULL en upl_codigo)
 *
 * PAGINACIÓN:
 *   1196 / 2000 = 1 página
 *
 * @module jobs/syncSectores
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT     = 'Tematicos_NR/Territorio_Referencia/FeatureServer/1/query';
const OUT_FIELDS   = 'SCACODIGO,SCANOMBRE,LOCCODIGO';
const MIN_EXPECTED = 1000;

/**
 * @brief Sincroniza los sectores catastrales de Bogotá desde OAIEE a PostGIS.
 *
 * @returns {Promise<number>} Número de registros insertados
 */
async function syncSectores() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncSectores] Iniciando...');
  await logSync(pool, 'sectores', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < MIN_EXPECTED) {
    const msg = `Conteo insuficiente: ${features.length} < ${MIN_EXPECTED}`;
    await logSync(pool, 'sectores', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // CASCADE: limpia cuadrantes, entornos, incidentes_nuse, rnmc que referencian sectores
    await client.query('TRUNCATE TABLE sectores_catastrales CASCADE');

    for (const f of features) {
      const p = f.properties;
      await client.query(
        `INSERT INTO sectores_catastrales (sca_codigo, sca_nombre, loc_codigo, geom)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)))`,
        [
          p.SCACODIGO?.toString().padStart(6, '0'),
          p.SCANOMBRE,
          p.LOCCODIGO?.toString().padStart(2, '0'),
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'sectores', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'sectores', 'success', features.length, duration, null);
  console.log(`[syncSectores] OK — ${features.length} sectores en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncSectores };
