/**
 * @fileoverview Sync S9 — Entornos Jer ⭐ TABLA MAESTRA DEL SISTEMA.
 *
 * PROPÓSITO:
 *   Carga los 59,384 micro-polígonos de entornos desde OAIEE.
 *   Esta tabla es el corazón de toda la inteligencia geoespacial de Argus:
 *   un solo ST_Contains sobre entornos resuelve la jerarquía completa
 *   (localidad → UPZ → sector → cuadrante → CAI) en <100ms.
 *
 * FUENTE:
 *   Tematicos_NR/Territorio_Referencia/FeatureServer/15/query
 *   Campos: OBJECTID, LOCCODIGO, LOCNOMBRE, UPLCODIGO, UPLNOMBRE,
 *           SCACODIGO, SCANOMBRE, CAICODIGO, PCUCODIGO, HIUNICO
 *
 * PAGINACIÓN:
 *   OBLIGATORIA. 59,384 / 2000 = 30 páginas. ~5s por página = ~2.5 min total.
 *
 * ESTRATEGIA DE SWAP ATÓMICO (staging):
 *   1. Truncar entornos_staging.
 *   2. Descargar 30 páginas → insertar en entornos_staging.
 *   3. Validar COUNT(entornos_staging) >= 59000.
 *   4. En transacción: TRUNCATE entornos + INSERT FROM entornos_staging.
 *   Esto garantiza que la tabla de producción nunca queda a medio llenar.
 *
 * VARIABLES CRÍTICAS:
 *   MIN_EXPECTED — mínimo de registros para validar la descarga completa.
 *                  Aborta el swap si OAIEE devuelve datos incompletos.
 *
 * @module jobs/syncEntornos
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT     = 'Tematicos_NR/Territorio_Referencia/FeatureServer/15/query';
const OUT_FIELDS   = 'OBJECTID,LOCCODIGO,LOCNOMBRE,UPLCODIGO,UPLNOMBRE,SCACODIGO,SCANOMBRE,CAICODIGO,PCUCODIGO,HIUNICO';
const MIN_EXPECTED = 59_000;

/**
 * @brief Sincroniza los 59,384 entornos Jer desde OAIEE a PostGIS.
 *
 * FLUJO:
 *   1. Limpiar staging.
 *   2. Descargar 30 páginas × 2000 features con fetchAll.
 *   3. Bulk insert en entornos_staging (sin FKs para máxima velocidad).
 *   4. Validar COUNT >= MIN_EXPECTED.
 *   5. Atomic swap: TRUNCATE entornos + INSERT FROM entornos_staging.
 *
 * @returns {Promise<number>} Número de entornos insertados en producción
 * @throws {Error} Si el conteo en staging es menor a MIN_EXPECTED
 *
 * @note Este es el job más pesado (~2.5 min). No ejecutar durante horario pico.
 *       Los campos UPLCODIGO y SCACODIGO en OAIEE pueden llegar como número.
 *       padStart(N, '0') normaliza al formato string del schema.
 */
async function syncEntornos() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncEntornos] Iniciando sync de 59,384 entornos (~2.5 min)...');
  await logSync(pool, 'entornos', 'started', null, null, null);

  // --- Paso 1: Limpiar staging ---
  await pool.query('TRUNCATE TABLE entornos_staging');
  console.log('[syncEntornos] Staging limpiado');

  // --- Paso 2: Descargar todas las páginas ---
  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });
  console.log(`[syncEntornos] Descarga completa: ${features.length} features`);

  // --- Paso 3: Insertar en staging ---
  // Usa transacciones de 500 en 500 para no saturar la conexión
  const BATCH = 500;
  const client = await pool.connect();
  try {
    let inserted = 0;
    for (let i = 0; i < features.length; i += BATCH) {
      const batch = features.slice(i, i + BATCH);
      await client.query('BEGIN');

      for (const f of batch) {
        const p = f.properties;
        const locCod = p.LOCCODIGO != null ? String(p.LOCCODIGO).padStart(2, '0') : null;
        const uplCod = p.UPLCODIGO != null ? String(p.UPLCODIGO)                  : null;
        const scaCod = p.SCACODIGO != null ? String(p.SCACODIGO).padStart(6, '0') : null;

        await client.query(
          `INSERT INTO entornos_staging
             (objectid, hiunico,
              loc_codigo, loc_nombre,
              upl_codigo, upl_nombre,
              sca_codigo, sca_nombre,
              cai_codigo, pcu_codigo, pcu_nombre,
              geom)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($12), 4326)))`,
          [
            p.OBJECTID,
            p.HIUNICO    ?? null,
            locCod,
            p.LOCNOMBRE  ?? null,
            uplCod,
            p.UPLNOMBRE  ?? null,
            scaCod,
            p.SCANOMBRE  ?? null,
            p.CAICODIGO  ?? null,
            p.PCUCODIGO  ?? null,
            null,           // pcu_nombre — no disponible en S9
            geomStr(f),
          ]
        );
      }

      await client.query('COMMIT');
      inserted += batch.length;
      console.log(`[syncEntornos] Staging: ${inserted}/${features.length}`);
    }

    // --- Paso 4: Validar conteo en staging ---
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM entornos_staging');
    const stagingCount = parseInt(rows[0].n, 10);

    if (stagingCount < MIN_EXPECTED) {
      const msg = `Staging insuficiente: ${stagingCount} < ${MIN_EXPECTED}. Swap cancelado.`;
      await logSync(pool, 'entornos', 'failed', stagingCount, Date.now() - t0, msg);
      throw new Error(msg);
    }

    console.log(`[syncEntornos] Validación OK (${stagingCount} >= ${MIN_EXPECTED}). Ejecutando swap atómico...`);

    // --- Paso 5: Atomic swap ---
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE entornos CASCADE');
    await client.query(`
      INSERT INTO entornos
        (objectid, hiunico, loc_codigo, loc_nombre, upl_codigo, upl_nombre,
         sca_codigo, sca_nombre, cai_codigo, pcu_codigo, pcu_nombre, geom, updated_at)
      SELECT objectid, hiunico, loc_codigo, loc_nombre, upl_codigo, upl_nombre,
             sca_codigo, sca_nombre, cai_codigo, pcu_codigo, pcu_nombre, geom, NOW()
      FROM entornos_staging
    `);
    await client.query('COMMIT');

    const duration = Date.now() - t0;
    await logSync(pool, 'entornos', 'success', stagingCount, duration, null);
    console.log(`[syncEntornos] OK — ${stagingCount} entornos en ${duration}ms`);
    return stagingCount;

  } catch (err) {
    // Solo hacer rollback si hay transacción activa (el swap o un batch)
    try { await client.query('ROLLBACK'); } catch (_) { /* ignorar */ }
    await logSync(pool, 'entornos', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncEntornos };
