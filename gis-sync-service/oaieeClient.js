/**
 * @fileoverview Cliente HTTP para la API OAIEE de la Secretaría de Seguridad de Bogotá.
 *
 * PROPÓSITO:
 *   Centraliza todas las llamadas HTTP a OAIEE con:
 *   - Retry automático (3 intentos, backoff exponencial)
 *   - Paginación transparente (max 2000 registros por request)
 *   - Conversión de coordenadas MAGNA-SIRGAS → WGS84 via datumTransformation=15738
 *   - Formato GeoJSON (f=geojson) para compatibilidad directa con PostGIS
 *
 * VARIABLES CRÍTICAS:
 *   BASE_URL — raíz de todos los servicios OAIEE
 *   COMMON_PARAMS — parámetros obligatorios en cada request (outSR, datum, formato)
 *
 * RIESGOS:
 *   - OAIEE no tiene SLA. Timeouts de 30s son normales en S9 (polígonos grandes).
 *   - maxRecordCount del servidor = 2000. No se puede aumentar.
 *   - S2 (CAI): EPOSERVICIO/EPOHORARIO en outFields → HTTP 400. Ver syncCai.js.
 *
 * @module oaieeClient
 */

'use strict';

const axios = require('axios');

const BASE_URL = 'https://oaiee.scj.gov.co/agc/rest/services';

const COMMON_PARAMS = {
  outSR:               4326,
  datumTransformation: 15738,
  f:                   'geojson',
  returnGeometry:      true,
  where:               '1=1',
};

const RECORD_COUNT = 2000;
const MAX_PAGES    = 50;
const TIMEOUT_MS   = 45_000;

/**
 * @brief Descarga una página de features de un FeatureServer OAIEE.
 *
 * FLUJO:
 *   1. Construir URL con parámetros + offset.
 *   2. GET con timeout y retry (3 intentos, backoff 2s/4s).
 *   3. Devolver el GeoJSON FeatureCollection.
 *
 * @param {string} path   Ruta relativa al BASE_URL (ej: "Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/25/query")
 * @param {number} offset Offset de paginación (0, 2000, 4000, ...)
 * @param {object} extra  Parámetros adicionales (outFields, returnGeometry, etc.)
 * @returns {Promise<{features: object[], exceededTransferLimit: boolean}>}
 *
 * @note Si el servidor devuelve 400, probablemente hay un campo inválido en outFields.
 */
async function fetchPage(path, offset = 0, extra = {}) {
  const url    = `${BASE_URL}/${path}`;
  const params = {
    ...COMMON_PARAMS,
    ...extra,
    resultRecordCount: RECORD_COUNT,
    resultOffset:      offset,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url, { params, timeout: TIMEOUT_MS });

      if (res.data.error) {
        throw new Error(`OAIEE error ${res.data.error.code}: ${res.data.error.message}`);
      }

      return {
        features:             res.data.features || [],
        exceededTransferLimit: res.data.properties?.exceededTransferLimit === true,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const delay = attempt * 2000;
        console.warn(`[oaiee] intento ${attempt} falló (${err.message}), reintentando en ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/**
 * @brief Descarga TODAS las páginas de un endpoint OAIEE y las concatena.
 *
 * FLUJO:
 *   1. Llamar fetchPage(offset=0).
 *   2. Si features.length === RECORD_COUNT o exceededTransferLimit, incrementar offset.
 *   3. Repetir hasta que lleguen menos de RECORD_COUNT features o se alcance MAX_PAGES.
 *
 * @param {string} path   Ruta relativa al BASE_URL
 * @param {object} extra  Parámetros adicionales (outFields, etc.)
 * @returns {Promise<object[]>} Array de GeoJSON features
 *
 * @note Progresa logueando cada página para datasets grandes (S9 = 30 páginas).
 */
async function fetchAll(path, extra = {}) {
  const all = [];
  let   offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { features, exceededTransferLimit } = await fetchPage(path, offset, extra);
    all.push(...features);

    console.log(`[oaiee] página ${page + 1}: +${features.length} features (total: ${all.length})`);

    // Sin más páginas cuando recibimos menos del máximo
    if (features.length < RECORD_COUNT && !exceededTransferLimit) break;

    offset += RECORD_COUNT;
  }

  return all;
}

/**
 * @brief Extrae el string JSON de la geometría de un feature GeoJSON.
 *
 * PROPÓSITO:
 *   PostGIS acepta ST_GeomFromGeoJSON(text). Este helper serializa
 *   feature.geometry a string para pasarlo como parámetro SQL.
 *
 * @param {object} feature GeoJSON Feature
 * @returns {string|null} JSON de la geometría, o null si no hay geometría
 */
function geomStr(feature) {
  if (!feature.geometry) return null;
  return JSON.stringify(feature.geometry);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { fetchAll, fetchPage, geomStr };
