/**
 * @fileoverview Sync P3 — Registro de Novedades Modelo de Ciudad (RNMC).
 *
 * PROPÓSITO:
 *   Carga ~7,768 filas del RNMC (estructura normalizada: 1 fila por sector × artículo × mes).
 *   Contiene tipos específicos de delitos por sector catastral.
 *   Variables f₄ (disparos), f₅ (porte ilegal armas), f₆ (orden público) del ARU Bloque B.
 *
 * FUENTE:
 *   Tematicos_Pub/CifrasSCJ/FeatureServer/8/query
 *   Paginación: 4 páginas × 2000 registros
 *   Join key: SCACODIGO → sectores_catastrales
 *
 * FLUJO:
 *   1. Descargar ~7768 features (4 páginas, sin geometría).
 *   2. TRUNCATE + INSERT en rnmc (tabla normalizada).
 *
 * @module jobs/syncRnmc
 */

'use strict';

const { fetchAll } = require('../oaieeClient');
const { getPool }  = require('../config/db');

const ENDPOINT   = 'Tematicos_Pub/CifrasSCJ/FeatureServer/8/query';
const OUT_FIELDS = 'SCACODIGO,SCANOMBRE,ARTICULO,NUMARTICULO,DESCRIPCION,MES,CONTEO,TOTAL';

/**
 * @brief Sincroniza el RNMC por sector catastral desde OAIEE a PostgreSQL.
 *
 * @returns {Promise<number>} Número de filas insertadas
 *
 * @note Si el sync P3 falla con HTTP 400, ejecutar un query de descubrimiento
 *       para obtener los campos reales: ?where=1=1&outFields=*&f=json&resultRecordCount=1
 */
async function syncRnmc() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncRnmc] Iniciando (4 páginas × 2000)...');
  await logSync(pool, 'rnmc', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, {
    outFields:      OUT_FIELDS,
    returnGeometry: false,
  });

  if (features.length < 3000) {
    const msg = `Conteo insuficiente: ${features.length} < 3000`;
    await logSync(pool, 'rnmc', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE rnmc');

    const BATCH = 500;
    for (let i = 0; i < features.length; i += BATCH) {
      const batch = features.slice(i, i + BATCH);
      for (const f of batch) {
        const p      = f.properties;
        const scaCod = p.SCACODIGO != null ? String(p.SCACODIGO).padStart(6, '0') : null;

        await client.query(
          `INSERT INTO rnmc (sca_codigo, sca_nombre, articulo, num_articulo, descripcion, mes, conteo, total, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [
            scaCod,
            p.SCANOMBRE    ?? null,
            p.ARTICULO     ?? null,
            p.NUMARTICULO  ?? null,
            p.DESCRIPCION  ?? null,
            p.MES          ?? null,
            p.CONTEO       ?? 0,
            p.TOTAL        ?? 0,
          ]
        );
      }
      console.log(`[syncRnmc] Insertadas ${Math.min(i + BATCH, features.length)}/${features.length}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'rnmc', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'rnmc', 'success', features.length, duration, null);
  console.log(`[syncRnmc] OK — ${features.length} filas en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncRnmc };
