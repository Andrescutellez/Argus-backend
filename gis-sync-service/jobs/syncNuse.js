/**
 * @fileoverview Sync P2 — Incidentes NUSE por Sector Catastral.
 *
 * PROPÓSITO:
 *   Carga los incidentes del sistema NUSE (123 línea de emergencias) por sector.
 *   Variable f₃ (densidad incidentes hurto) del ARU.
 *   Tras sync, refrescar la materialized view mv_risk_sector.
 *
 * FUENTE:
 *   Tematicos_Pub/CifrasSCJ/FeatureServer/7/query
 *   Join key: SCACODIGO → sectores_catastrales
 *
 * ADVERTENCIA:
 *   Los nombres exactos de campos del FeatureServer/7 no están confirmados
 *   en la documentación OAIEE. OUT_FIELDS usa el patrón CifrasSCJ observado
 *   en P1 y P3. Si el primer sync falla con HTTP 400, ejecutar:
 *     GET .../FeatureServer/7/query?where=1=1&outFields=*&f=json&resultRecordCount=1
 *   para descubrir los campos reales.
 *
 * @module jobs/syncNuse
 */

'use strict';

const { fetchAll } = require('../oaieeClient');
const { getPool }  = require('../config/db');

const ENDPOINT = 'Tematicos_Pub/CifrasSCJ/FeatureServer/7/query';

// NOTA: Verificar contra FeatureServer/7 antes del primer sync real.
// Patrón basado en P1 (CMHM{YY}CONT) y P3 (CMD26CONT, CMPIA26CONT, CMAOP26CONT).
const OUT_FIELDS = [
  'SCACODIGO', 'SCANOMBRE',
  'CMRI25CONT',  'CMNA25CONT',  'CMAOP25CONT', 'CMMA25CONT',
  'CMD25CONT',   'CMPIA25CONT', 'CMHU25CONT',
  'CMRI26CONT',  'CMNA26CONT',  'CMAOP26CONT', 'CMMA26CONT',
  'CMD26CONT',   'CMPIA26CONT', 'CMHU26CONT',  'CMTOT26CONT',
].join(',');

/**
 * @brief Sincroniza los incidentes NUSE por sector catastral desde OAIEE.
 *
 * FLUJO:
 *   1. Descargar ~1,170 features (sin geometría).
 *   2. TRUNCATE + INSERT en incidentes_nuse.
 *   3. Refrescar materialized view mv_risk_sector.
 *
 * @returns {Promise<number>} Número de sectores insertados
 */
async function syncNuse() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncNuse] Iniciando...');
  await logSync(pool, 'nuse', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, {
    outFields:      OUT_FIELDS,
    returnGeometry: false,
  });

  if (features.length < 500) {
    const msg = `Conteo insuficiente: ${features.length} < 500`;
    await logSync(pool, 'nuse', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE incidentes_nuse');

    for (const f of features) {
      const p      = f.properties;
      const scaCod = p.SCACODIGO != null ? String(p.SCACODIGO).padStart(6, '0') : null;

      await client.query(
        `INSERT INTO incidentes_nuse
           (sca_codigo, sca_nombre,
            nuse_rina_2025, nuse_narco_2025, nuse_orden_2025, nuse_maltrato_2025,
            nuse_disparo_2025, nuse_porte_2025, nuse_hurto_2025,
            nuse_rina_2026, nuse_narco_2026, nuse_orden_2026, nuse_maltrato_2026,
            nuse_disparo_2026, nuse_porte_2026, nuse_hurto_2026, nuse_total_2026,
            synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())`,
        [
          scaCod,
          p.SCANOMBRE     ?? null,
          p.CMRI25CONT    ?? 0,
          p.CMNA25CONT    ?? 0,
          p.CMAOP25CONT   ?? 0,
          p.CMMA25CONT    ?? 0,
          p.CMD25CONT     ?? 0,
          p.CMPIA25CONT   ?? 0,
          p.CMHU25CONT    ?? 0,
          p.CMRI26CONT    ?? 0,
          p.CMNA26CONT    ?? 0,
          p.CMAOP26CONT   ?? 0,
          p.CMMA26CONT    ?? 0,
          p.CMD26CONT     ?? 0,
          p.CMPIA26CONT   ?? 0,
          p.CMHU26CONT    ?? 0,
          p.CMTOT26CONT   ?? 0,
        ]
      );
    }

    await client.query('COMMIT');

    // Refrescar vista materializada post-sync
    console.log('[syncNuse] Refrescando mv_risk_sector...');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_risk_sector');

  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'nuse', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  const duration = Date.now() - t0;
  await logSync(pool, 'nuse', 'success', features.length, duration, null);
  console.log(`[syncNuse] OK — ${features.length} sectores en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncNuse };
