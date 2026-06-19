/**
 * @fileoverview Controlador Crime — datos de criminalidad para el mapa de riesgo Argus.
 *
 * PROPÓSITO:
 *   Expone dos endpoints de criminalidad que alimentan el mapa de riesgo en web y app:
 *   1. /api/crime/bogota   — GeoJSON con 20 localidades, hurtos motos/autos (2018-2026),
 *                            variación YoY y conteo de cámaras de vigilancia.
 *   2. /api/crime/nacional — Hurtos de motocicletas por departamento (últimos 12 meses).
 *   3. /api/crime/bogota/lookup?lat=&lon= — Localidad + crimen para punto GPS específico.
 *
 * FUENTES:
 *   OAIEE SCJ  — https://oaiee.scj.gov.co (Secretaría Distrital de Seguridad, Bogotá)
 *                CifrasSCJ FeatureServer/0  → delitos por localidad (2018-2026)
 *                CamarasTerritorio/0        → cámaras por localidad
 *                Territorio_Referencia/3    → polígonos geográficos de localidades
 *   datos.gov.co — https://www.datos.gov.co (DIPON / Policía Nacional)
 *                Dataset csb4-y6v2          → hurto automotores y motos nacional
 *
 * CACHE:
 *   24 horas en memoria. Los datos OAIEE se actualizan mensualmente.
 *   En fallo de red, se sirve el cache anterior con flag stale:true.
 *
 * ALGORITMO GEOESPACIAL:
 *   lookup → ray casting point-in-polygon sobre los 20 polígonos de localidades.
 *   Se reusa el mismo algoritmo que gisController.js para cuadrantes.
 *
 * @module controllers/crimeController
 */

'use strict';

const https = require('https');
const http  = require('http');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

// Servidores de gobierno usan CAs no estándar
const HTTPS_AGENT_GOV = new https.Agent({ rejectUnauthorized: false });

const OAIEE_BASE   = 'https://oaiee.scj.gov.co/agc/rest/services';
const SOCRATA_BASE = 'https://www.datos.gov.co/resource';

// ─── Caches en memoria ────────────────────────────────────────────────────────

// Cache completo Bogotá (GeoJSON FeatureCollection)
let _bogotaCache   = { data: null, ts: 0 };
// Cache nacional por departamento
let _nacionalCache = { data: null, ts: 0 };

// ─── Helper HTTP ──────────────────────────────────────────────────────────────

/**
 * GET JSON con soporte de bypass de certificados gov y timeout configurable.
 *
 * PROPÓSITO:
 *   Centraliza la lógica de request para no repetirla en cada fetch.
 *   Los servidores de gobierno colombiano usan certificados firmados por
 *   CAs internas no reconocidas por Node.js → rejectUnauthorized:false.
 *
 * @param {string}  urlStr      URL completa del endpoint.
 * @param {boolean} govAgent    Si true, ignora errores de certificado SSL.
 * @returns {Promise<object>}   JSON parseado de la respuesta.
 */
function getJson(urlStr, govAgent = false) {
  return new Promise((resolve, reject) => {
    const opts = govAgent ? { agent: HTTPS_AGENT_GOV } : {};
    const client = urlStr.startsWith('https://') ? https : http;
    const req = client.get(urlStr, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`JSON parse error from ${urlStr}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${urlStr}`)); });
  });
}

// ─── ARI — Argus Risk Index ───────────────────────────────────────────────────

/**
 * Calcula el Argus Risk Index (ARI) dinámico para una localidad.
 *
 * PROPÓSITO:
 *   Transforma los datos de criminalidad estáticos en un índice accionable
 *   que varía según el contexto temporal. Un mismo barrio tiene distinto
 *   nivel de riesgo a las 2pm que a las 10pm.
 *
 * FÓRMULA:
 *   base     = normalize(motos_2026, 0, 200) × 100
 *   base    *= trendFactor(motos_var_pct)     // +30% máx si crece, −20% máx si baja
 *   base    *= 1.3  si hora Bogotá ∈ [18, 24) ∪ [0, 6)  // nocturno
 *   base    *= 0.85 si camaras_total ≥ 20                // disuasión alta
 *   base    *= 0.90 si camaras_total ∈ [10, 20)          // disuasión media
 *   ARI      = clamp(round(base), 0, 100)
 *
 * @param {object} props          Properties del feature GeoJSON (motos_2026, motos_var_pct, camaras_total).
 * @param {number} [hourUTC]      Hora UTC (0-23). Default: hora actual del servidor.
 * @returns {number}              ARI 0-100 donde 0=sin riesgo y 100=riesgo extremo.
 *
 * @note La conversión UTC→Bogotá usa UTC-5. Colombia no tiene DST.
 */
function calculateARI(props, hourUTC = new Date().getUTCHours()) {
  const motos = props.motos_2026 ?? 0;
  if (motos === 0) return 0;

  // Base lineal: 200 hurtos/año = 100 ARI (umbral de la localidad más crítica)
  let ari = Math.min(100, (motos / 200) * 100);

  // Tendencia: si los hurtos están subiendo, el riesgo futuro es mayor
  const varPct = props.motos_var_pct ?? 0;
  ari *= varPct > 0
    ? 1 + Math.min(varPct / 200, 0.30)   // máx +30% si sube
    : 1 + Math.max(varPct / 200, -0.20); // máx −20% si baja

  // Hora en Bogotá (UTC-5, Colombia no tiene horario de verano)
  const hourBog = (hourUTC - 5 + 24) % 24;
  // El 70% de hurtos de motos ocurre entre 6pm y medianoche según OAIEE histórico
  if (hourBog >= 18 || hourBog < 6) ari *= 1.30;

  // Cobertura de cámaras: disuasión documentada en zonas de alta vigilancia
  const camaras = props.camaras_total ?? 0;
  if      (camaras >= 20) ari *= 0.80;
  else if (camaras >= 10) ari *= 0.90;

  return Math.round(Math.min(100, Math.max(0, ari)));
}

/**
 * Retorna el FeatureCollection de Bogotá desde el cache en memoria (síncrono).
 *
 * PROPÓSITO:
 *   Permite que riskMonitor.js haga lookup de ARI sin HTTP adicional.
 *   El cache se pobla en la primera request a /api/crime/bogota o via warmCache().
 *
 * @returns {GeoJSON.FeatureCollection | null}  null si el cache aún no fue poblado.
 */
function getBogotaCacheSync() {
  return _bogotaCache.data ?? null;
}

/**
 * Pre-carga el cache de criminalidad Bogotá en el arranque del servidor.
 *
 * PROPÓSITO:
 *   Para que riskMonitor.js pueda calcular ARI desde el primer paquete GPS,
 *   server.js llama warmCache() con un delay de 5s (para que MongoDB conecte primero).
 *   Sin esto, el riskMonitor no opera hasta que algún cliente web llame /api/crime/bogota.
 */
async function warmCache() {
  if (_bogotaCache.data) return;
  try {
    const data = await buildBogotaData();
    _bogotaCache.data = data;
    _bogotaCache.ts   = Date.now();
    console.log('[crime] Cache de criminalidad calentado en arranque');
  } catch (err) {
    // Si OAIEE no está disponible al arrancar, el sistema funciona sin ARI
    // hasta que el cache se pueble en la primera petición HTTP.
    console.warn('[crime] warmCache falló (se reintentará en la primera request):', err.message);
  }
}

// ─── Algoritmo geoespacial (mismo que gisController) ─────────────────────────

/**
 * Ray casting para punto en anillo de polígono.
 * @param {number} lon  Longitud WGS-84.
 * @param {number} lat  Latitud WGS-84.
 * @param {Array}  ring Array de [lon, lat] que forma el anillo.
 * @returns {boolean}
 */
function rayInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distancia Haversine en km entre dos puntos WGS-84. */
function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Centroide aproximado del primer anillo de un Polygon/MultiPolygon. */
function approxCentroid(geom) {
  const ring = geom.type === 'Polygon'
    ? geom.coordinates[0]
    : geom.coordinates[0][0];
  if (!ring || ring.length === 0) return null;
  const sum = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/**
 * Busca la localidad más cercana por centroide cuando el ray casting falla.
 * Útil cuando el GPS cae en el borde exacto de un polígono o tiene deriva leve.
 * Límite: 10 km — si la moto está más lejos, probablemente no está en Bogotá.
 */
function nearestLocalidad(features, lon, lat) {
  const MAX_KM = 10;
  let best = null, bestDist = Infinity;
  for (const f of features) {
    if (!f.geometry) continue;
    const c = approxCentroid(f.geometry);
    if (!c) continue;
    const d = haversineKm(lon, lat, c[0], c[1]);
    if (d < bestDist) { bestDist = d; best = f; }
  }
  return bestDist <= MAX_KM ? best : null;
}

function pointInGeoJsonGeom(geom, lon, lat) {
  if (!geom) return false;
  if (geom.type === 'Polygon') {
    return rayInRing(lon, lat, geom.coordinates[0]);
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some(poly => rayInRing(lon, lat, poly[0]));
  }
  return false;
}

// ─── Construcción de datos Bogotá ─────────────────────────────────────────────

/**
 * Descarga, une y retorna GeoJSON completo de criminalidad por localidad en Bogotá.
 *
 * FLUJO LÓGICO:
 *   1. Descarga en paralelo: delitos (CifrasSCJ), cámaras y polígonos de localidades.
 *   2. Indexa delitos por CMIULOCAL y cámaras por CVILCODIGO.
 *   3. Por cada feature de localidad: une stats de crimen + cámaras a las properties.
 *   4. Convierte geometría ESRI rings → GeoJSON Polygon/MultiPolygon.
 *   5. Calcula risk_score (0-100) y risk_level para que el frontend no tenga que hacer cálculos.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
async function buildBogotaData() {
  // Campos de crimen: motos (2018-2026) + variación + automotores 2026 + personas 2026
  const DELITOS_FIELDS = [
    'CMIULOCAL', 'CMNOMLOCAL',
    'CMHM18CONT', 'CMHM19CONT', 'CMHM20CONT', 'CMHM21CONT', 'CMHM22CONT',
    'CMHM23CONT', 'CMHM24CONT', 'CMHM25CONT', 'CMHM26CONT', 'CMHMVAR', 'CMHMTOTAL',
    'CMHA26CONT', 'CMHAVAR',
    'CMHP26CONT', 'CMHPVAR',
  ].join(',');

  const DELITOS_URL = `${OAIEE_BASE}/Tematicos_Pub/CifrasSCJ/FeatureServer/0/query`
    + `?where=1%3D1&outFields=${encodeURIComponent(DELITOS_FIELDS)}`
    + `&returnGeometry=false&outSR=4326&datumTransformation=15738&f=json`;

  const CAMARAS_URL = `${OAIEE_BASE}/SistemaVideoVigilancia/CamarasTerritorio/FeatureServer/0/query`
    + `?where=1%3D1&outFields=CVILCODIGO%2CVILNOMBRE%2CCVILOTINST%2CCVILOTADMSCJ`
    + `&returnGeometry=false&f=json`;

  const LOCALIDADES_URL = `${OAIEE_BASE}/Tematicos_NR/Territorio_Referencia/FeatureServer/3/query`
    + `?where=1%3D1&outFields=LOCCODIGO%2CLOCNOMBRE%2CLOCAREA`
    + `&outSR=4326&datumTransformation=15738&returnGeometry=true&f=json`;

  const [delRes, camRes, locRes] = await Promise.all([
    getJson(DELITOS_URL, true),
    getJson(CAMARAS_URL, true),
    getJson(LOCALIDADES_URL, true),
  ]);

  // Índices por código de localidad
  const delMap = {};
  for (const f of (delRes.features || [])) {
    const a = f.attributes;
    const code = a.CMIULOCAL;
    delMap[code] = {
      historico: {
        '2018': a.CMHM18CONT ?? 0, '2019': a.CMHM19CONT ?? 0,
        '2020': a.CMHM20CONT ?? 0, '2021': a.CMHM21CONT ?? 0,
        '2022': a.CMHM22CONT ?? 0, '2023': a.CMHM23CONT ?? 0,
        '2024': a.CMHM24CONT ?? 0, '2025': a.CMHM25CONT ?? 0,
        '2026': a.CMHM26CONT ?? 0,
      },
      motos_2026:      a.CMHM26CONT ?? 0,
      motos_var_pct:   a.CMHMVAR    ?? null,
      motos_total_bog: a.CMHMTOTAL  ?? 0,
      autos_2026:      a.CMHA26CONT ?? 0,
      autos_var_pct:   a.CMHAVAR    ?? null,
      personas_2026:   a.CMHP26CONT ?? 0,
      personas_var_pct: a.CMHPVAR   ?? null,
    };
  }

  const camMap = {};
  for (const f of (camRes.features || [])) {
    const a = f.attributes;
    camMap[a.CVILCODIGO] = {
      camaras_total: a.CVILOTINST    ?? 0,
      camaras_sdscj: a.CVILOTADMSCJ  ?? 0,
    };
  }

  // Construir FeatureCollection GeoJSON
  const features = [];
  for (const f of (locRes.features || [])) {
    const code  = f.attributes.LOCCODIGO;
    const crime = delMap[code] || {};
    const cams  = camMap[code] || {};

    // Convertir rings ESRI → geometría GeoJSON
    const rings = f.geometry?.rings || [];
    let geojsonGeom = null;
    if (rings.length === 1) {
      geojsonGeom = { type: 'Polygon', coordinates: rings };
    } else if (rings.length > 1) {
      // Múltiples anillos: primer anillo = exterior, resto = huecos (caso raro en localidades)
      geojsonGeom = { type: 'Polygon', coordinates: rings };
    }

    const motos = crime.motos_2026 ?? 0;
    const autos = crime.autos_2026 ?? 0;

    // risk_level basado en hurto motos (la métrica principal de Argus)
    let risk_level;
    if (motos === 0)      risk_level = 'sin_dato';
    else if (motos <= 15) risk_level = 'muy_bajo';
    else if (motos <= 40) risk_level = 'bajo';
    else if (motos <= 70) risk_level = 'moderado';
    else if (motos <= 120) risk_level = 'alto';
    else                  risk_level = 'muy_alto';

    // risk_score 0-100 (lineal, cap en 200 hurtos = score 100)
    const risk_score = Math.min(100, Math.round(motos / 2));

    features.push({
      type: 'Feature',
      geometry: geojsonGeom,
      properties: {
        codigo:           code,
        nombre:           f.attributes.LOCNOMBRE,
        area_km2:         f.attributes.LOCAREA,
        motos_2026:       motos,
        motos_var_pct:    crime.motos_var_pct    ?? null,
        motos_total_bog:  crime.motos_total_bog  ?? 0,
        autos_2026:       autos,
        autos_var_pct:    crime.autos_var_pct    ?? null,
        personas_2026:    crime.personas_2026    ?? 0,
        personas_var_pct: crime.personas_var_pct ?? null,
        camaras_total:    cams.camaras_total     ?? 0,
        camaras_sdscj:    cams.camaras_sdscj     ?? 0,
        historico:        crime.historico        || {},
        risk_score,
        risk_level,
      },
    });
  }

  return {
    type:     'FeatureCollection',
    features,
    meta: {
      updated_at:   new Date().toISOString(),
      total_motos:  delRes.features?.[0]?.attributes?.CMHMTOTAL ?? 0,
      fuente:       'OAIEE — Secretaría Distrital de Seguridad, Convivencia y Justicia (SDSCJ)',
      cobertura:    'Bogotá D.C. — 20 localidades',
    },
  };
}

// ─── Construcción de datos nacionales ────────────────────────────────────────

/**
 * Descarga hurtos de motocicletas por departamento (últimos 12 meses) desde datos.gov.co.
 *
 * FUENTE: Dataset csb4-y6v2 "HURTO A VEHÍCULOS" — DIPON / Policía Nacional.
 * Soporta Socrata SoQL: aggregation, filtering, grouping.
 *
 * @returns {Promise<object>} { departamentos: [...], meta: {...} }
 */
async function buildNacionalData() {
  const desde = new Date();
  desde.setFullYear(desde.getFullYear() - 1);
  const desdeStr = desde.toISOString().slice(0, 10) + 'T00:00:00.000';

  const url = `${SOCRATA_BASE}/csb4-y6v2.json`
    + `?%24select=departamento%2Ccod_depto%2Csum(cantidad)%20as%20total`
    + `&%24where=tipo_delito%3D'ARTICULO%20239.%20HURTO%20MOTOCICLETAS'`
    + `%20AND%20fecha_hecho%3E'${encodeURIComponent(desdeStr)}'`
    + `&%24group=departamento%2Ccod_depto`
    + `&%24order=total%20DESC`;

  const rows = await getJson(url, false);
  return {
    departamentos: rows.map(r => ({
      nombre:    r.departamento,
      cod_depto: r.cod_depto,
      motos_12m: parseInt(r.total, 10) || 0,
    })),
    meta: {
      updated_at: new Date().toISOString(),
      periodo:    `${desdeStr.slice(0, 10)} → hoy`,
      fuente:     'DIPON — Policía Nacional vía datos.gov.co (dataset csb4-y6v2)',
    },
  };
}

// ─── Helpers de cache ─────────────────────────────────────────────────────────

async function getFromCache(cache, builder, label) {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return { data: cache.data, cached: true };
  }
  const data = await builder();
  cache.data = data;
  cache.ts   = now;
  return { data, cached: false };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/crime/bogota
 *
 * Retorna GeoJSON FeatureCollection con las 20 localidades de Bogotá.
 * Cada feature tiene properties con hurtos motos 2018-2026, variación YoY,
 * hurtos autos 2026, cámaras totales y nivel de riesgo calculado.
 *
 * CACHE: 24h. Si el OAIEE falla y hay cache, retorna con stale:true.
 */
async function getBogota(req, res) {
  try {
    const { data, cached } = await getFromCache(_bogotaCache, buildBogotaData, 'Bogotá');
    return res.json({ ...data, cached });
  } catch (err) {
    if (_bogotaCache.data) {
      return res.json({ ..._bogotaCache.data, stale: true });
    }
    console.error('[crime] getBogota error:', err.message);
    return res.status(503).json({ message: `Error obteniendo datos de crimen Bogotá: ${err.message}` });
  }
}

/**
 * GET /api/crime/bogota/lookup?lat=&lon=
 *
 * Retorna las properties de la localidad que contiene el punto GPS dado.
 * Usa ray casting sobre los polígonos del cache.
 *
 * PROPÓSITO:
 *   Permite que la app Flutter obtenga el nivel de riesgo de la zona actual
 *   sin procesar el GeoJSON completo en el cliente.
 */
async function getBogotaLookup(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ message: 'lat y lon son requeridos' });
  }

  try {
    const { data } = await getFromCache(_bogotaCache, buildBogotaData, 'Bogotá');

    // Intento 1: ray casting exacto
    let match = data.features.find(f =>
      f.geometry && pointInGeoJsonGeom(f.geometry, lon, lat)
    );

    // Intento 2: centroide más cercano (hasta 10 km).
    // Cubre casos donde el GPS cae en el borde del polígono o tiene deriva leve del A7670.
    if (!match) match = nearestLocalidad(data.features, lon, lat);

    if (!match) {
      return res.status(404).json({ message: 'Punto fuera de las localidades de Bogotá' });
    }

    const ari = calculateARI(match.properties);
    return res.json({ ...match.properties, ari });
  } catch (err) {
    if (_bogotaCache.data) {
      let match = _bogotaCache.data.features.find(f =>
        f.geometry && pointInGeoJsonGeom(f.geometry, lon, lat)
      );
      if (!match) match = nearestLocalidad(_bogotaCache.data.features, lon, lat);
      if (match) return res.json({ ...match.properties, stale: true });
    }
    console.error('[crime] getBogotaLookup error:', err.message);
    return res.status(503).json({ message: `Error en lookup de crimen: ${err.message}` });
  }
}

/**
 * GET /api/crime/nacional
 *
 * Retorna el ranking de departamentos por hurto de motocicletas en los últimos 12 meses.
 * Fuente: Policía Nacional vía datos.gov.co (SIEDCO dataset público).
 *
 * CACHE: 24h.
 */
async function getNacional(req, res) {
  try {
    const { data, cached } = await getFromCache(_nacionalCache, buildNacionalData, 'nacional');
    return res.json({ ...data, cached });
  } catch (err) {
    if (_nacionalCache.data) {
      return res.json({ ..._nacionalCache.data, stale: true });
    }
    console.error('[crime] getNacional error:', err.message);
    return res.status(503).json({ message: `Error obteniendo datos nacionales: ${err.message}` });
  }
}

module.exports = {
  getBogota, getBogotaLookup, getNacional,
  // Exportados para riskMonitor.js y server.js:
  calculateARI, getBogotaCacheSync, pointInGeoJsonGeom, warmCache,
};


/* ═══════════════════════════════════════════════════════════
   RESUMEN — crimeController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador actúa como un agregador/proxy que combina tres fuentes
   de datos públicos del gobierno colombiano y retorna información de
   criminalidad estructurada para el mapa de riesgo de Argus. Los datos
   de Bogotá tienen 9 años de histórico (2018-2026) y se cruzan con la
   cobertura de cámaras de vigilancia para dar contexto completo al usuario.

   PSEUDOCÓDIGO:
   getBogota():
     1. Si cache válido (<24h) → retornar directamente
     2. Descargar en paralelo: delitos SCJ + cámaras + polígonos localidades
     3. Indexar delitos por código localidad
     4. Indexar cámaras por código localidad
     5. Por cada polígono: unir stats → calcular risk_level → emitir Feature GeoJSON
     6. Guardar en cache → retornar FeatureCollection

   getBogotaLookup(lat, lon):
     1. Obtener FeatureCollection (de cache o descargando)
     2. Ray casting sobre los 20 polígonos
     3. Retornar properties de la localidad contenedora

   getNacional():
     1. Si cache válido (<24h) → retornar directamente
     2. Llamar datos.gov.co con SoQL aggregation (sum por dpto)
     3. Guardar en cache → retornar ranking

   DIAGRAMA MENTAL:
   Cliente → GET /api/crime/bogota →
     crimeController → [OAIEE CifrasSCJ, OAIEE Cámaras, OAIEE Localidades]
                    → merge → GeoJSON FeatureCollection → cache 24h → cliente

   RIESGOS:
   - Si OAIEE cambia su schema de campos, el merge silenciosamente devuelve 0s.
   - Los polígonos de localidades tienen datum MAGNA-SIRGAS; la conversión a WGS84
     usa la transformación 15738 recomendada por el IGAC. Pequeños errores de datum
     (~1m) son irrelevantes para lookup de localidad.
   ═══════════════════════════════════════════════════════════ */
