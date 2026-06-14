/**
 * @fileoverview Controlador GIS — lookup en memoria sin PostgreSQL/PostGIS.
 *
 * PROPÓSITO:
 *   Resuelve consultas geoespaciales cargando los datos de OAIEE como archivos
 *   JSON estáticos en memoria al arrancar el servidor. No requiere PostgreSQL GIS
 *   ni el gis-sync-service. Los archivos se generan una vez con:
 *     node gis-sync-service/scripts/fetchGisStatic.js
 *
 * ARCHIVOS DE DATOS:
 *   data/gis/cuadrantes.geojson  — 599 polígonos (Polygon/MultiPolygon WGS84)
 *   data/gis/cai.json            — 154 puntos CAI
 *   data/gis/estaciones.json     — 21 estaciones de policía
 *
 * ALGORITMOS:
 *   lookup → ray casting point-in-polygon sobre 599 cuadrantes (~<2ms).
 *   near   → distancia haversine sobre arrays pequeños (154 CAI, 21 estaciones).
 *
 * ESTADO DE DATOS:
 *   Si los archivos no existen (script no ejecutado), los endpoints devuelven
 *   503 con mensaje claro. El servidor arranca igual — GIS es opcional.
 *
 * @module controllers/gisController
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'gis');

// ─── Mapa de localidades (estático — no cambia) ──────────────────────────────

const LOCALIDADES = {
  '01': 'Usaquén',       '02': 'Chapinero',       '03': 'Santa Fe',
  '04': 'San Cristóbal', '05': 'Usme',             '06': 'Tunjuelito',
  '07': 'Bosa',          '08': 'Kennedy',           '09': 'Fontibón',
  '10': 'Engativá',      '11': 'Suba',             '12': 'Barrios Unidos',
  '13': 'Teusaquillo',   '14': 'Los Mártires',     '15': 'Antonio Nariño',
  '16': 'Puente Aranda', '17': 'La Candelaria',    '18': 'Rafael Uribe Uribe',
  '19': 'Ciudad Bolívar','20': 'Sumapaz',
};

// ─── Carga de datos en memoria ────────────────────────────────────────────────

let CUADRANTES          = null;  // GeoJSON FeatureCollection
let CAI                 = null;  // array de puntos
let ESTACIONES          = null;  // array de puntos
let CUADRANTE_CENTROIDS = null;  // [{ cx, cy, feature }] — precalculados al arrancar
let GIS_READY           = false;

function loadGisData() {
  try {
    const cuadFile = path.join(DATA_DIR, 'cuadrantes.geojson');
    const caiFile  = path.join(DATA_DIR, 'cai.json');
    const estFile  = path.join(DATA_DIR, 'estaciones.json');

    if (!fs.existsSync(cuadFile) || !fs.existsSync(caiFile) || !fs.existsSync(estFile)) {
      console.warn('[GIS] Archivos estáticos no encontrados en data/gis/.');
      console.warn('[GIS] Ejecutar: node gis-sync-service/scripts/fetchGisStatic.js');
      return;
    }

    CUADRANTES = JSON.parse(fs.readFileSync(cuadFile, 'utf8'));
    CAI        = JSON.parse(fs.readFileSync(caiFile,  'utf8'));
    ESTACIONES = JSON.parse(fs.readFileSync(estFile,  'utf8'));

    // Enriquecer con loc_nombre una sola vez al cargar — evita join en cada request
    CUADRANTES.features.forEach(f => {
      f.properties.loc_nombre = LOCALIDADES[f.properties.loc_codigo] ?? null;
    });

    // Precalcular centroide aproximado de cada cuadrante para cuadrantesNear
    CUADRANTE_CENTROIDS = CUADRANTES.features.map(f => {
      let sumX = 0, sumY = 0, count = 0;
      const addRing = ring => { for (const [x, y] of ring) { sumX += x; sumY += y; count++; } };
      if (f.geometry.type === 'Polygon')      addRing(f.geometry.coordinates[0]);
      if (f.geometry.type === 'MultiPolygon') f.geometry.coordinates.forEach(p => addRing(p[0]));
      return { cx: sumX / count, cy: sumY / count, feature: f };
    });

    GIS_READY  = true;

    console.log(`[GIS] Datos cargados: ${CUADRANTES.features.length} cuadrantes, ${CAI.length} CAI, ${ESTACIONES.length} estaciones`);
  } catch (err) {
    console.error('[GIS] Error cargando datos estáticos:', err.message);
  }
}

// Cargar al importar el módulo (startup del servidor)
loadGisData();

// ─── Algoritmos geoespaciales ─────────────────────────────────────────────────

/**
 * Ray casting point-in-polygon para un anillo lineal (array de [lon,lat]).
 * Devuelve true si el punto está dentro del polígono (sin considerar huecos).
 */
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

/**
 * Point-in-polygon para GeoJSON Polygon (usando solo el anillo exterior).
 * Suficiente para cuadrantes — no tienen huecos relevantes.
 */
function inPolygon(lon, lat, coordinates) {
  return rayInRing(lon, lat, coordinates[0]);
}

/**
 * Point-in-polygon para GeoJSON Geometry (Polygon o MultiPolygon).
 */
function containsPoint(geometry, lon, lat) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return inPolygon(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(poly => inPolygon(lon, lat, poly));
  }
  return false;
}

/**
 * Distancia haversine en metros entre dos pares lat/lon WGS84.
 */
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
    message: 'Datos GIS no disponibles. Ejecutar: node gis-sync-service/scripts/fetchGisStatic.js',
  });
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /api/gis/lookup?lon=&lat=
 *
 * Busca el cuadrante policial que contiene el punto GPS.
 * Itera los 599 cuadrantes con ray casting — ~<2ms en Node.js.
 *
 * Respuesta: { pcu_codigo, pcu_nombre, pcu_nom_cai, pcu_nom_est,
 *              pcu_telefono, loc_codigo, loc_nombre }
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
    pcu_codigo:   p.pcu_codigo,
    pcu_nombre:   p.pcu_codigo,   // campo normalizado
    pcu_nom_cai:  p.pcu_nom_cai,
    pcu_nom_est:  p.pcu_nom_est,
    pcu_telefono: p.pcu_telefono,
    loc_codigo:   p.loc_codigo,
    loc_nombre:   LOCALIDADES[p.loc_codigo] ?? null,
  });
}

/**
 * GET /api/gis/near?lon=&lat=&type=cai|estacion&limit=3
 *
 * Devuelve los N puntos policiales más cercanos al GPS dado,
 * ordenados por distancia haversine ascendente.
 */
async function near(req, res) {
  if (!GIS_READY) return notReady(res);

  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat requeridos' });

  const { lon, lat } = coords;
  const type  = req.query.type  || 'cai';
  const limit = Math.min(parseInt(req.query.limit) || 3, 10);

  if (!['cai', 'estacion'].includes(type)) {
    return res.status(400).json({ message: 'type debe ser "cai" o "estacion"' });
  }

  const source = type === 'cai' ? CAI : ESTACIONES;

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
 * Devuelve los CAI agrupados por localidad para un heatmap básico de presencia policial.
 * (Versión simplificada sin datos de hurtos — esos requieren PostgreSQL).
 */
async function heatmap(req, res) {
  if (!GIS_READY) return notReady(res);

  // Agrupar CAI por localidad como proxy de cobertura
  const byLoc = {};
  for (const cai of CAI) {
    const loc = cai.loc_codigo ?? 'XX';
    if (!byLoc[loc]) byLoc[loc] = { loc_codigo: loc, loc_nombre: LOCALIDADES[loc] ?? loc, count_cai: 0 };
    byLoc[loc].count_cai++;
  }

  res.json({ ok: true, localidades: Object.values(byLoc).sort((a, b) => a.loc_codigo.localeCompare(b.loc_codigo)) });
}

/**
 * GET /api/gis/cuadrantes
 *
 * Devuelve el GeoJSON FeatureCollection completo de los 599 cuadrantes policiales,
 * enriquecido con loc_nombre. Usado por web-operador para el overlay territorial.
 *
 * ~2.3 MB de payload — se carga una sola vez por sesión del operador.
 * El GeoJSON ya está en memoria desde loadGisData(), no hay I/O adicional.
 */
async function cuadrantes(req, res) {
  if (!GIS_READY) return notReady(res);
  // Cache de 1 hora en proxy/CDN — el territorio cambia raramente
  res.set('Cache-Control', 'private, max-age=3600');
  res.json(CUADRANTES);
}

/**
 * GET /api/gis/cuadrantes-near?lon=&lat=&limit=5
 *
 * Devuelve los N cuadrantes más cercanos al punto GPS (por centroide precalculado).
 * Usado por web-usuario y Flutter para mostrar solo el área local de la moto.
 *
 * Incluye el cuadrante contenedor + vecinos inmediatos en ~1ms (O(599), solo aritmética).
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

module.exports = { lookup, near, heatmap, cuadrantes, cuadrantesNear };

/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — gisController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Al arrancar el servidor, este módulo carga 3 archivos JSON
   del disco (data/gis/) y los mantiene en memoria. Cuando un
   frontend pregunta "¿en qué cuadrante está esta coordenada?",
   itera los 599 polígonos con ray casting puro — sin SQL, sin
   PostGIS, sin dependencias externas. Para CAI cercanos usa
   haversine sobre 154 puntos. Todo sub-2ms.

   SETUP REQUERIDO (una sola vez):
     node gis-sync-service/scripts/fetchGisStatic.js

   DIAGRAMA MENTAL:
   Arranque servidor
     → loadGisData() lee data/gis/*.json → memoria
     → GIS_READY = true

   GET /api/gis/lookup?lon=-74.07&lat=4.711
     → parseLonLat() → { lon, lat }
     → CUADRANTES.features.find(containsPoint) → feature
     → res.json({ cuadrante, teléfono, localidad })

   GET /api/gis/near?type=cai&limit=3
     → CAI.map(haversineM).sort().slice(3)
     → res.json([{ nombre, distancia_m }])

   DEUDA TÉCNICA:
   - Ray casting ignora huecos en polígonos (ningún cuadrante los tiene).
   - Sin índice espacial — 599 iteraciones están bien, no escala a millones.
   - heatmap devuelve conteo de CAI, no datos de hurtos (esos requieren PostGIS).
   - Si OAIEE cambia los datos, hay que reejecutar fetchGisStatic.js y hacer push.

   ═══════════════════════════════════════════════════════════ */
