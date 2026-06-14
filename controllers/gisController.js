/**
 * @fileoverview Controlador de consultas GIS sobre PostGIS.
 *
 * PROPÓSITO:
 *   Expone tres endpoints que permiten a los frontends enriquecer
 *   cualquier coordenada GPS con contexto geoespacial de Bogotá:
 *   jerarquía territorial, cuadrante policial y POIs cercanos.
 *
 * ARQUITECTURA:
 *   Consulta directamente la BD PostgreSQL/PostGIS mediante el pool
 *   existente en config/postgres.js. Sin capa intermedia de caché
 *   por ahora — los índices GIST de PostGIS garantizan <10ms por query.
 *
 * TABLAS USADAS:
 *   - entornos (59 384 polígonos): tabla maestra de lookup territorial.
 *   - cuadrantes (599): polígonos de cuadrante policial con teléfono patrullero.
 *   - cai (154): puntos de Centros de Atención Inmediata.
 *   - estaciones_policia (21): una por localidad, con teléfono.
 *   - localidades (21) + delitos_hurto_motos (21): para heatmap de riesgo.
 *
 * NOTA DE DATOS:
 *   Si los datasets aún no se cargaron (TASK-GIS-007 pendiente),
 *   los endpoints devuelven 404 / arrays vacíos en lugar de error 500.
 *
 * @module controllers/gisController
 */

'use strict';

const { pool } = require('../config/postgres');

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrae lon/lat de req.query, valida y convierte a float.
 * @returns {{ lon: number, lat: number } | null}
 */
function parseLonLat(req) {
  const lon = parseFloat(req.query.lon);
  const lat = parseFloat(req.query.lat);
  if (isNaN(lon) || isNaN(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

// ─── lookup ───────────────────────────────────────────────────────────────────

/**
 * GET /api/gis/lookup?lon=&lat=
 *
 * PROPÓSITO:
 *   Dado un punto GPS, resuelve toda la jerarquía territorial de Bogotá:
 *   localidad → UPZ → sector catastral → cuadrante policial (con teléfono).
 *   Un solo query ST_Contains sobre la tabla entornos, que tiene 59 384
 *   polígonos indexados con GIST — debería ejecutarse en <5ms.
 *
 * FLUJO:
 *   1. Validar lon/lat.
 *   2. ST_Contains(e.geom, punto) → primer entorno que contiene el punto.
 *   3. JOIN cuadrantes → agrega pcu_telefono y nombre del CAI asignado.
 *   4. Si no hay resultado (punto fuera de Bogotá), devuelve 404.
 *
 * @param {import('express').Request}  req  Query: lon, lat
 * @param {import('express').Response} res
 */
async function lookup(req, res) {
  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat son requeridos y deben ser válidos' });

  const { lon, lat } = coords;

  try {
    const { rows } = await pool.query(
      `SELECT
         e.loc_nombre,
         e.upl_nombre,
         e.sca_nombre,
         e.pcu_codigo,
         e.pcu_nombre,
         c.pcu_telefono,
         c.pcu_nom_cai,
         c.pcu_nom_est
       FROM entornos e
       LEFT JOIN cuadrantes c ON c.pcu_codigo = e.pcu_codigo
       WHERE ST_Contains(e.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
       LIMIT 1`,
      [lon, lat]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Coordenadas fuera del área cubierta' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[GIS lookup]', err.message);
    res.status(500).json({ message: 'Error en consulta GIS' });
  }
}

// ─── near ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/gis/near?lon=&lat=&type=cai|estacion&limit=3
 *
 * PROPÓSITO:
 *   Devuelve los N POIs policiales más cercanos al punto dado,
 *   ordenados por distancia en metros (operador KNN <-> de PostGIS).
 *
 * FLUJO:
 *   1. Validar params.
 *   2. Según type, consultar tabla cai o estaciones_policia.
 *   3. ORDER BY geom <-> punto usa el índice GIST en modo KNN — no hace full scan.
 *   4. ST_Distance::geography calcula la distancia real sobre el esferoide.
 *
 * @param {import('express').Request}  req  Query: lon, lat, type, limit
 * @param {import('express').Response} res
 */
async function near(req, res) {
  const coords = parseLonLat(req);
  if (!coords) return res.status(400).json({ message: 'lon y lat son requeridos' });

  const { lon, lat } = coords;
  const type  = req.query.type  || 'cai';
  const limit = Math.min(parseInt(req.query.limit) || 3, 10);

  if (!['cai', 'estacion'].includes(type)) {
    return res.status(400).json({ message: 'type debe ser "cai" o "estacion"' });
  }

  try {
    let rows;

    if (type === 'cai') {
      ({ rows } = await pool.query(
        `SELECT
           epo_nombre    AS nombre,
           epo_direccion AS direccion,
           epo_lat       AS lat,
           epo_lon       AS lon,
           NULL          AS telefono,
           ROUND(ST_Distance(
             geom::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
           )::numeric) AS distancia_m
         FROM cai
         ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
         LIMIT $3`,
        [lon, lat, limit]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT
           epo_nombre    AS nombre,
           epo_direccion AS direccion,
           epo_lat       AS lat,
           epo_lon       AS lon,
           epo_telefono  AS telefono,
           ROUND(ST_Distance(
             geom::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
           )::numeric) AS distancia_m
         FROM estaciones_policia
         ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
         LIMIT $3`,
        [lon, lat, limit]
      ));
    }

    res.json(rows);
  } catch (err) {
    console.error('[GIS near]', err.message);
    res.status(500).json({ message: 'Error en consulta GIS near' });
  }
}

// ─── heatmap ──────────────────────────────────────────────────────────────────

/**
 * GET /api/gis/heatmap
 *
 * PROPÓSITO:
 *   Devuelve el GeoJSON de las 21 localidades de Bogotá junto con
 *   los datos de hurto de motos 2026 para renderizar un heatmap de riesgo.
 *   Se llama una vez al cargar el mapa — los datos cambian mensualmente.
 *
 * FORMATO RESPUESTA:
 *   { type: 'FeatureCollection', features: [...] }
 *   Cada feature: localidad + properties { loc_nombre, hm_2026, hm_total, quintil }
 *   El campo quintil (1-5) permite al frontend elegir el color de la capa.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
async function heatmap(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT
         l.loc_codigo,
         l.loc_nombre,
         ST_AsGeoJSON(l.geom)::json AS geojson,
         COALESCE(d.hm_2026, 0)      AS hm_2026,
         COALESCE(d.hm_total_anio, 0) AS hm_total,
         NTILE(5) OVER (ORDER BY COALESCE(d.hm_2026, 0)) AS quintil
       FROM localidades l
       LEFT JOIN delitos_hurto_motos d ON d.loc_codigo = l.loc_codigo
       ORDER BY l.loc_nombre`
    );

    const featureCollection = {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature',
        geometry: r.geojson,
        properties: {
          loc_codigo: r.loc_codigo,
          loc_nombre: r.loc_nombre,
          hm_2026:    r.hm_2026,
          hm_total:   r.hm_total,
          quintil:    r.quintil,
        },
      })),
    };

    res.json(featureCollection);
  } catch (err) {
    console.error('[GIS heatmap]', err.message);
    res.status(500).json({ message: 'Error en consulta GIS heatmap' });
  }
}

module.exports = { lookup, near, heatmap };

/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — gisController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador responde tres preguntas que el frontend hace:
   1. lookup  → "¿En qué cuadrante está esta coordenada GPS?"
   2. near    → "¿Cuál es el CAI / estación más cercana a este punto?"
   3. heatmap → "¿Cuántos robos de motos hubo en cada localidad este año?"
   Todas las consultas tocan PostGIS directamente sobre índices GIST.

   PSEUDOCÓDIGO:
   lookup(lon, lat)
     → ST_Contains(entornos.geom, punto) → { localidad, UPZ, cuadrante, teléfono }

   near(lon, lat, type, limit)
     → ORDER BY geom <-> punto LIMIT N → [{ nombre, dirección, distancia_m }]

   heatmap()
     → localidades JOIN delitos_hurto_motos → GeoJSON FeatureCollection

   DIAGRAMA MENTAL:
   Frontend ──GET /api/gis/lookup──► gisController ──SQL──► PostGIS
                                         │
                                    { cuadrante, teléfono, localidad }
                                         │
                                    Frontend muestra badge en mapa

   ═══════════════════════════════════════════════════════════ */
