/**
 * @fileoverview Sync P1 — Delitos Alto Impacto: Hurto de Motos por Localidad.
 *
 * PROPÓSITO:
 *   Carga el histórico de hurto de motos 2018-2026 (21 filas, 1 por localidad).
 *   Variables f₁ (tasa hurto motos) y f₂ (tendencia YoY) del ARU.
 *   Sync mensual porque los datos se actualizan cada mes.
 *
 * FUENTE:
 *   Tematicos_Pub/CifrasSCJ/FeatureServer/0/query
 *   Campo PK: CMIULOCAL → loc_codigo
 *   Campos de conteo: CMHM{YY}CONT (2018-2026)
 *   Variación YoY: CMHMVAR
 *   Total año actual: CMHMTOTAL
 *
 * DEPENDENCIAS:
 *   localidades debe estar cargada (FK).
 *
 * @module jobs/syncDelitosMotos
 */

'use strict';

const { fetchAll } = require('../oaieeClient');
const { getPool }  = require('../config/db');

const ENDPOINT   = 'Tematicos_Pub/CifrasSCJ/FeatureServer/0/query';
const OUT_FIELDS = [
  'CMIULOCAL', 'CMNOMLOCAL',
  'CMHM18CONT', 'CMHM19CONT', 'CMHM20CONT', 'CMHM21CONT',
  'CMHM22CONT', 'CMHM23CONT', 'CMHM24CONT', 'CMHM25CONT', 'CMHM26CONT',
  'CMHMVAR', 'CMHMTOTAL',
].join(',');

/**
 * @brief Sincroniza el histórico de hurto de motos desde OAIEE a PostgreSQL.
 *
 * FLUJO:
 *   1. Descargar 21 features (sin geometría — solo atributos).
 *   2. TRUNCATE + INSERT en delitos_hurto_motos.
 *
 * @returns {Promise<number>} Número de registros insertados (siempre 21)
 *
 * @note returnGeometry=false para evitar cargar ~500KB de polígonos innecesarios.
 *       Ya tenemos la geometría de localidades cargada en la tabla `localidades`.
 */
async function syncDelitosMotos() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncDelitosMotos] Iniciando...');
  await logSync(pool, 'delitos_motos', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, {
    outFields:      OUT_FIELDS,
    returnGeometry: false,
  });

  if (features.length < 15) {
    const msg = `Conteo insuficiente: ${features.length} < 15`;
    await logSync(pool, 'delitos_motos', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE delitos_hurto_motos');

    for (const f of features) {
      const p      = f.properties;
      const locCod = p.CMIULOCAL != null ? String(p.CMIULOCAL).padStart(2, '0') : null;

      await client.query(
        `INSERT INTO delitos_hurto_motos
           (loc_codigo, loc_nombre,
            hm_2018, hm_2019, hm_2020, hm_2021, hm_2022, hm_2023, hm_2024, hm_2025, hm_2026,
            hm_variacion, hm_total_anio, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
        [
          locCod,
          p.CMNOMLOCAL  ?? null,
          p.CMHM18CONT  ?? 0,
          p.CMHM19CONT  ?? 0,
          p.CMHM20CONT  ?? 0,
          p.CMHM21CONT  ?? 0,
          p.CMHM22CONT  ?? 0,
          p.CMHM23CONT  ?? 0,
          p.CMHM24CONT  ?? 0,
          p.CMHM25CONT  ?? 0,
          p.CMHM26CONT  ?? 0,
          p.CMHMVAR     ?? null,
          p.CMHMTOTAL   ?? 0,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'delitos_motos', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'delitos_motos', 'success', features.length, duration, null);
  console.log(`[syncDelitosMotos] OK — ${features.length} localidades en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncDelitosMotos };
