/**
 * @fileoverview Controlador GIS — cuadrantes nacionales desde API Policía Nacional + CAI/estaciones Bogotá.
 *
 * PROPÓSITO:
 *   Resuelve consultas geoespaciales en dos capas:
 *   1. Cuadrantes policiales (capa principal): descarga los 4,621 polígonos nacionales desde
 *      el ArcGIS REST API de la Policía Nacional al arrancar el servidor. Se refresca
 *      semanalmente via setInterval. Cero llamadas externas en runtime — ray casting local.
 *   2. CAI y estaciones Bogotá: archivos JSON estáticos opcionales en data/gis/.
 *      Si no existen, los endpoints /near y /heatmap devuelven 503 pero el lookup funciona.
 *
 * FUENTE DE CUADRANTES:
 *   https://gis.policia.gov.co:6443/arcgis/rest/services/ZONAS/ZONAS_ANTECION/MapServer/1/query
 *   Paginado en bloques de 1,000 con resultOffset. Certificado TLS del servidor puede ser
 *   no-estándar (gobierno), por eso el agente HTTPS usa rejectUnauthorized:false.
 *
 * ALGORITMOS:
 *   lookup → ray casting point-in-polygon sobre los polígonos en memoria (<5ms para 4,621).
 *   near   → distancia haversine sobre arrays pequeños (154 CAI, 21 estaciones Bogotá).
 *
 * COBERTURA:
 *   Cuadrantes: nacional (Bogotá, Medellín, Cali, Barranquilla, Bucaramanga y más).
 *   CAI / estaciones: solo Bogotá (datos estáticos opcionales).
 *
 * @module controllers/gisController
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data', 'gis');

// ─── Configuración API Policía Nacional ──────────────────────────────────────

const POLICIA_QUERY_URL = 'https://gis.policia.gov.co:6443/arcgis/rest/services/ZONAS/ZONAS_ANTECION/MapServer/1/query';
const PAGE_SIZE         = 1000;
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// Servidor de la Policía usa TLS con certificado de CA no estándar (gobierno)
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ─── Prefijos de ciudad en NRO_CUADRANTE ─────────────────────────────────────

const PREFIJOS_CIUDAD = {
  MEBOG: 'Bogotá',
  MECAL: 'Cali',
  MEVAL: 'Medellín',
  MEBAR: 'Barranquilla',
  MEBUC: 'Bucaramanga',
  MEMOT: 'Montería',
  DENOR: 'Norte de Santander',
  DECAQ: 'Caquetá',
};

function ciudadDePrefijo(nroCuadrante) {
  const prefix = (nroCuadrante ?? '').slice(0, 5);
  return PREFIJOS_CIUDAD[prefix] ?? prefix;
}

// ─── Estado en memoria ────────────────────────────────────────────────────────

let CUADRANTES          = null;  // GeoJSON FeatureCollection (nacional)
let CAI                 = null;  // array de puntos Bogotá (opcional)
let ESTACIONES          = null;  // array de puntos Bogotá (opcional)
let CUADRANTE_CENTROIDS = null;  // [{ cx, cy, feature }] — precalculados
let GIS_READY           = false;
let LAST_REFRESH        = null;  // Date de la última carga exitosa de cuadrantes

// ─── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * GET a una URL HTTPS y parsea el cuerpo como JSON.
 * Devuelve una Promise que rechaza si la conexión falla o el cuerpo no es JSON válido.
 */
function httpsGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { agent: HTTPS_AGENT }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`JSON inválido en ${urlStr}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── Descarga paginada desde API Policía ─────────────────────────────────────

/**
 * Descarga todos los cuadrantes nacionales desde el ArcGIS de la Policía.
 * Pagina de PAGE_SIZE en PAGE_SIZE hasta agotar resultados o error.
 * Retorna un GeoJSON FeatureCollection con propiedades normalizadas.
 */
async function fetchCuadrantesFromPolicia() {
  const features = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      where:             '1=1',
      outFields:         'NRO_CUADRANTE,DESCRIPCION,CUAD_ID,CODIGO_ZONA',
      returnGeometry:    'true',
      f:                 'geojson',
      resultOffset:      offset,
      resultRecordCount: PAGE_SIZE,
    });

    const url  = `${POLICIA_QUERY_URL}?${params}`;
    const data = await httpsGetJson(url);

    if (!data.features || data.features.length === 0) break;

    // Normalizar propiedades a nombres internos consistentes
    for (const f of data.features) {
      const p = f.properties;
      features.push({
        ...f,
        properties: {
          cuadrante_id: p.NRO_CUADRANTE,
          descripcion:  p.DESCRIPCION,
          cuad_id:      p.CUAD_ID,
          codigo_zona:  p.CODIGO_ZONA,
          ciudad:       ciudadDePrefijo(p.NRO_CUADRANTE),
        },
      });
    }

    if (data.features.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (features.length === 0) throw new Error('API Policía devolvió 0 cuadrantes');

  return { type: 'FeatureCollection', features };
}

// ─── Centroide aproximado ─────────────────────────────────────────────────────

function buildCentroids(featuresArr) {
  return featuresArr.map(f => {
    let sumX = 0, sumY = 0, count = 0;
    const addRing = ring => { for (const [x, y] of ring) { sumX += x; sumY += y; count++; } };
    if (f.geometry.type === 'Polygon')
      addRing(f.geometry.coordinates[0]);
    if (f.geometry.type === 'MultiPolygon')
      f.geometry.coordinates.forEach(p => addRing(p[0]));
    return { cx: sumX / count, cy: sumY / count, feature: f };
  });
}

// ─── Carga inicial y refresh ──────────────────────────────────────────────────

async function loadCuadrantesFromPolicia() {
  console.log('[GIS] Descargando cuadrantes nacionales desde API Policía…');
  const fc = await fetchCuadrantesFromPolicia();

  // Actualización atómica: la data vieja sigue sirviendo hasta que la nueva esté lista
  CUADRANTES          = fc;
  CUADRANTE_CENTROIDS = buildCentroids(fc.features);
  GIS_READY           = true;
  LAST_REFRESH        = new Date();

  console.log(`[GIS] ${fc.features.length} cuadrantes cargados (${LAST_REFRESH.toISOString()})`);
}

function loadLocalFiles() {
  try {
    const caiFile = path.join(DATA_DIR, 'cai.json');
    const estFile = path.join(DATA_DIR, 'estaciones.json');
    if (fs.existsSync(caiFile))  CAI        = JSON.parse(fs.readFileSync(caiFile,  'utf8'));
    if (fs.existsSync(estFile))  ESTACIONES = JSON.parse(fs.readFileSync(estFile,  'utf8'));
    if (CAI || ESTACIONES)
      console.log(`[GIS] Archivos locales: ${CAI?.length ?? 0} CAI, ${ESTACIONES?.length ?? 0} estaciones`);
  } catch (err) {
    console.warn('[GIS] Error leyendo archivos locales (no crítico):', err.message);
  }
}

async function loadGisData() {
  loadLocalFiles();
  await loadCuadrantesFromPolicia();

  // Refresh semanal en background — no bloquea ni afecta requests en vuelo
  setInterval(async () => {
    try {
      await loadCuadrantesFromPolicia();
    } catch (err) {
      console.error('[GIS] Refresh semanal fallido (datos anteriores siguen activos):', err.message);
    }
  }, REFRESH_INTERVAL_MS);
}

// Arrancar al importar el módulo. Si falla, GIS_READY queda false y los endpoints devuelven 503.
loadGisData().catch(err => console.error('[GIS] Carga inicial fallida:', err.message));

// ─── Algoritmos geoespaciales ─────────────────────────────────────────────────

function rayInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygon(lon, lat, coordinates) {
  return rayInRing(lon, lat, coordinates[0]);
}

function containsPoint(geometry, lon, lat) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon')      return inPolygon(lon, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => inPolygon(lon, lat, poly));
  return false;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ─── Helpers de validación ────────────────────────────────────────────────────

function parseLonLat(req) {
  const lon = parseFloat(req.query.lon);
  const lat = parseFloat(req.query.lat);
  if (isNaN(lon) || isNaN(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

function notReady(res) {
  return res.status(503).json({
    message: 'Datos GIS no disponibles — el servidor está cargando los cuadrantes desde la API de la Policía. Reintenta en 30 segundos.',
  });
}

function noLocalData(res, type) {
  return res.status(503).json({
    message: `Datos de ${type} no disponibles. Ejecutar: node gis-sync-service/scripts/fetchGisStatic.js`,
  });
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /api/gis/lookup?lon=&lat=
 *
 * Identifica el cuadrante policial que contiene el punto GPS.
 * Cubre todo el país. Ray casting local — sin llamadas externas.
 *
 * Respuesta: { cuadrante_id, descripcion, cuad_id, codigo_zona, ciudad }
 */
async function lookup(req, res) {
  if (!GIS_READY) return notReady(res);

  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat requeridos y válidos' });

  const { lon, lat } = coords;
  const found = CUADRANTES.features.find(f => containsPoint(f.geometry, lon, lat));

  if (!found) return res.status(404).json({ message: 'Coordenadas fuera del área cubierta' });

  const p = found.properties;
  res.json({
    cuadrante_id: p.cuadrante_id,
    descripcion:  p.descripcion,
    cuad_id:      p.cuad_id,
    codigo_zona:  p.codigo_zona,
    ciudad:       p.ciudad,
  });
}

/**
 * GET /api/gis/near?lon=&lat=&type=cai|estacion&limit=3
 *
 * Devuelve los N puntos policiales más cercanos (Bogotá — datos locales).
 */
async function near(req, res) {
  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat requeridos' });

  const type  = req.query.type  || 'cai';
  const limit = Math.min(parseInt(req.query.limit) || 3, 10);

  if (!['cai', 'estacion'].includes(type))
    return res.status(400).json({ message: 'type debe ser "cai" o "estacion"' });

  const source = type === 'cai' ? CAI : ESTACIONES;
  if (!source) return noLocalData(res, type);

  const { lon, lat } = coords;
  const result = source
    .map(p => ({
      nombre:      p.nombre,
      direccion:   p.direccion,
      lat:         p.lat,
      lon:         p.lon,
      telefono:    p.telefono ?? null,
      distancia_m: haversineM(lat, lon, p.lat, p.lon),
    }))
    .sort((a, b) => a.distancia_m - b.distancia_m)
    .slice(0, limit);

  res.json(result);
}

/**
 * GET /api/gis/heatmap
 *
 * Conteo de CAI por localidad (Bogotá — datos locales).
 */
async function heatmap(req, res) {
  if (!CAI) return noLocalData(res, 'CAI');

  const byLoc = {};
  for (const cai of CAI) {
    const loc = cai.loc_codigo ?? 'XX';
    if (!byLoc[loc]) byLoc[loc] = { loc_codigo: loc, loc_nombre: cai.loc_nombre ?? loc, count_cai: 0 };
    byLoc[loc].count_cai++;
  }

  res.json({ ok: true, localidades: Object.values(byLoc).sort((a, b) => a.loc_codigo.localeCompare(b.loc_codigo)) });
}

/**
 * GET /api/gis/cuadrantes?ciudad=MEBOG
 *
 * Devuelve el GeoJSON FeatureCollection de cuadrantes.
 * Parámetro ?ciudad= filtra por prefijo de NRO_CUADRANTE (ej: MEBOG = Bogotá).
 * Sin ?ciudad= devuelve los 4,621 cuadrantes nacionales (~15MB).
 */
async function cuadrantes(req, res) {
  if (!GIS_READY) return notReady(res);

  const ciudadFilter = req.query.ciudad?.toUpperCase();
  const features = ciudadFilter
    ? CUADRANTES.features.filter(f => f.properties.cuadrante_id?.startsWith(ciudadFilter))
    : CUADRANTES.features;

  res.set('Cache-Control', 'private, max-age=3600');
  res.json({
    type: 'FeatureCollection',
    features,
    meta: {
      total:         features.length,
      last_refresh:  LAST_REFRESH,
      ciudad_filtro: ciudadFilter ?? 'todos',
    },
  });
}

/**
 * GET /api/gis/cuadrantes-near?lon=&lat=&limit=5
 *
 * Devuelve los N cuadrantes más cercanos al punto GPS (por centroide).
 * Incluye cuadrante contenedor + vecinos inmediatos.
 */
async function cuadrantesNear(req, res) {
  if (!GIS_READY) return notReady(res);

  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat requeridos' });

  const { lon, lat } = coords;
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);

  const nearest = CUADRANTE_CENTROIDS
    .map(({ cx, cy, feature }) => ({ feature, dist: haversineM(lat, lon, cy, cx) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map(x => x.feature);

  res.json({ type: 'FeatureCollection', features: nearest });
}

/**
 * GET /api/gis/status
 *
 * Estado interno del módulo GIS. Útil para diagnóstico en producción.
 */
async function status(req, res) {
  res.json({
    ready:          GIS_READY,
    cuadrantes:     CUADRANTES?.features.length ?? 0,
    cai:            CAI?.length ?? 0,
    estaciones:     ESTACIONES?.length ?? 0,
    last_refresh:   LAST_REFRESH,
    refresh_period: '7 días',
    fuente:         'gis.policia.gov.co:6443 (ArcGIS REST)',
  });
}

module.exports = { lookup, near, heatmap, cuadrantes, cuadrantesNear, status };

/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — gisController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Al arrancar el servidor, este módulo descarga los 4,621
   cuadrantes policiales de TODA Colombia desde el ArcGIS
   REST API de la Policía Nacional. Los mantiene en memoria
   y hace ray casting local — cero llamadas a la API en
   runtime. Se refresca automáticamente cada 7 días.
   CAI y estaciones de Bogotá vienen de archivos locales
   opcionales (si existen).

   SETUP:
   No requiere setup manual. El servidor descarga los datos
   al arrancar. Los archivos locales de CAI/estaciones siguen
   siendo opcionales para el endpoint /near.

   DIAGRAMA MENTAL:
   Arranque servidor
     → loadLocalFiles() → CAI, ESTACIONES (opcional)
     → fetchCuadrantesFromPolicia() → paginado 5x1000 requests
     → CUADRANTES = 4621 features, GIS_READY = true
     → setInterval(7 días) → refresh en background

   GET /api/gis/lookup?lon=-74.07&lat=4.711
     → ray casting → feature → { cuadrante_id, ciudad, ... }

   GET /api/gis/cuadrantes?ciudad=MEBOG
     → filter por prefix → ~599 Bogotá features

   DEUDA TÉCNICA:
   - Sin índice espacial (R-tree) — 4,621 iteraciones son
     manejables (<5ms) pero no escala a millones de features.
   - CAI / estaciones nacionales aún no disponibles (solo Bogotá).
   - TLS del servidor de Policía con rejectUnauthorized:false —
     aceptable para tráfico backend→gobierno pero no ideal.
   - Sin fallback local si la API de Policía está caída al arrancar.

   ═══════════════════════════════════════════════════════════ */
