/**
 * @fileoverview Sync S3 — Cuadrantes Policiales ⭐ DIFERENCIADOR ÚNICO.
 *
 * PROPÓSITO:
 *   Carga los 599 cuadrantes policiales de Bogotá, incluyendo el campo
 *   PCUTELEFON (teléfono celular del patrullero asignado).
 *   Este campo es el corazón del feature "Notificar al Cuadrante":
 *   en robo confirmado, Argus llama/SMS al patrullero con coordenadas GPS.
 *
 * FUENTE:
 *   Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/25/query
 *   Campos clave:
 *     PCUCODIGO   → pcu_codigo (PK)
 *     PCUNOMCAI   → pcu_nom_cai (nombre del CAI que cubre el cuadrante)
 *     PCUNOMEST   → pcu_nom_est (nombre de la estación)
 *     PCUTELEFON  → pcu_telefono ⭐
 *     PCUIULOCAL  → loc_codigo
 *     PCUIUSCATA  → sca_codigo
 *     PCUIUUPLOC  → upl_codigo
 *
 * PAGINACIÓN:
 *   599 registros / 2000 = 1 página. No requiere paginación múltiple.
 *
 * DEPENDENCIAS:
 *   localidades, upz, sectores_catastrales deben estar cargadas.
 *
 * @module jobs/syncCuadrantes
 */

'use strict';

const { fetchAll, geomStr } = require('../oaieeClient');
const { getPool }           = require('../config/db');

const ENDPOINT     = 'Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/25/query';
const OUT_FIELDS   = 'PCUCODIGO,PCUNOMCAI,PCUNOMEST,PCUTELEFON,PCUIULOCAL,PCUIUSCATA,PCUIUUPLOC';
const MIN_EXPECTED = 500;

/**
 * @brief Sincroniza los cuadrantes policiales desde OAIEE a PostGIS.
 *
 * FLUJO:
 *   1. Descargar features S3 (599, una página).
 *   2. Validar conteo >= 500.
 *   3. TRUNCATE cuadrantes CASCADE.
 *   4. INSERT con geometría MultiPolygon.
 *
 * @returns {Promise<number>} Número de cuadrantes insertados
 * @throws {Error} Si el conteo es menor a MIN_EXPECTED
 *
 * @note PCUIULOCAL es el código de localidad (2 dígitos).
 *       PCUIUSCATA es el código de sector catastral (6 dígitos).
 *       Valores numéricos en OAIEE → padStart para normalizar formato.
 */
async function syncCuadrantes() {
  const pool = getPool();
  const t0   = Date.now();

  console.log('[syncCuadrantes] Iniciando — descargando 599 cuadrantes + teléfonos patrulleros...');
  await logSync(pool, 'cuadrantes', 'started', null, null, null);

  const features = await fetchAll(ENDPOINT, { outFields: OUT_FIELDS });

  if (features.length < MIN_EXPECTED) {
    const msg = `Conteo insuficiente: ${features.length} < ${MIN_EXPECTED}`;
    await logSync(pool, 'cuadrantes', 'failed', 0, Date.now() - t0, msg);
    throw new Error(msg);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // No CASCADE: entornos no tiene FK strict a cuadrantes (intencionado)
    await client.query('TRUNCATE TABLE cuadrantes');

    for (const f of features) {
      const p = f.properties;

      // Los códigos llegan como números en OAIEE → normalizar a string con padding
      const locCod = p.PCUIULOCAL != null ? String(p.PCUIULOCAL).padStart(2, '0') : null;
      const scaCod = p.PCUIUSCATA != null ? String(p.PCUIUSCATA).padStart(6, '0') : null;
      const uplCod = p.PCUIUUPLOC != null ? String(p.PCUIUUPLOC)                  : null;

      await client.query(
        `INSERT INTO cuadrantes
           (pcu_codigo, pcu_nom_cai, pcu_nom_est, pcu_telefono,
            loc_codigo, sca_codigo, upl_codigo, geom, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($8), 4326)),
                 NOW())`,
        [
          p.PCUCODIGO,
          p.PCUNOMCAI  ?? null,
          p.PCUNOMEST  ?? null,
          p.PCUTELEFON ?? null,
          locCod,
          scaCod,
          uplCod,
          geomStr(f),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSync(pool, 'cuadrantes', 'failed', 0, Date.now() - t0, err.message);
    throw err;
  } finally {
    client.release();
  }

  // Verificar cuántos tienen teléfono
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(pcu_telefono) AS con_telefono FROM cuadrantes`
  );
  console.log(`[syncCuadrantes] ${rows[0].con_telefono}/${rows[0].total} cuadrantes con teléfono patrullero`);

  const duration = Date.now() - t0;
  await logSync(pool, 'cuadrantes', 'success', features.length, duration, null);
  console.log(`[syncCuadrantes] OK — ${features.length} cuadrantes en ${duration}ms`);
  return features.length;
}

async function logSync(pool, job, status, records, duration, errorMsg) {
  await pool.query(
    `INSERT INTO gis_sync_log (job_name, status, records_synced, duration_ms, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [job, status, records, duration, errorMsg]
  );
}

module.exports = { syncCuadrantes };
