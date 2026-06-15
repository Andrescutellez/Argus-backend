/**
 * @fileoverview Controlador Weather — proxy de datos meteorológicos en tiempo real.
 *
 * PROPÓSITO:
 *   Expone datos de lluvia en tiempo real de Bogotá desde el SAB (Sistema de
 *   Alerta de Bogotá). El SAB bloquea CORS para dominios externos, así que el
 *   backend actúa como proxy: recibe la request del frontend, consulta SAB,
 *   clasifica la intensidad y retorna un JSON limpio.
 *
 * FUENTE:
 *   SAB — https://app.sab.gov.co/sab/
 *   Endpoint: ServletTipoSensores?idtiposensor=5 (pluviómetros — 71 estaciones)
 *   Actualización: cada ~5 minutos por parte del SAB.
 *
 * CACHE:
 *   5 minutos en memoria. No saturar el SAB con requests por cada usuario conectado.
 *   Si el SAB está caído y hay cache disponible (aunque sea vencida), se retorna
 *   con un flag stale:true para que el frontend lo sepa.
 *
 * COBERTURA:
 *   Solo Bogotá (71 estaciones pluviométricas). Expansión nacional requiere IDEAM
 *   u otra fuente — ver memory reference_sab_api.md para detalles de expansión.
 *
 * @module controllers/weatherController
 */

'use strict';

const https  = require('https');
const http   = require('http');
const AdmZip = require('adm-zip');

const SAB_BASE       = 'https://app.sab.gov.co/sab';
const RADAR_KMZ_URL  = 'https://evp.sire.gov.co/radar_animate/datos/kml/reflectividad.kmz';
const CACHE_TTL_MS   = 5 * 60 * 1000; // 5 minutos

// Cache lluvia SAB — { data, ts }
let _cache = { data: null, ts: 0 };

// Cache radar SIRE — { imageBuffer, bounds, ts }
// imageBuffer: Buffer PNG listo para enviar como response
// bounds: { north, south, east, west } en grados WGS84
let _radarCache = { imageBuffer: null, bounds: null, ts: 0 };

// Servidores de gobierno pueden tener certificados de CA no estándar
const HTTPS_AGENT_GOV = new https.Agent({ rejectUnauthorized: false });

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────

function httpsGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`JSON inválido desde SAB: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Descarga una URL como Buffer crudo. Sigue hasta 3 redirects (301/302).
 * Soporta http y https. Usado para el KMZ del radar SIRE.
 */
function getBuffer(urlStr, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const isHttps = urlStr.startsWith('https');
    const lib     = isHttps ? https : http;
    const opts    = isHttps ? { agent: HTTPS_AGENT_GOV } : {};

    lib.get(urlStr, opts, (res) => {
      // Seguir redirects manualmente — Node.js no lo hace automáticamente
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        if (redirectsLeft === 0) return reject(new Error('Demasiados redirects'));
        return resolve(getBuffer(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} descargando ${urlStr}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ─── Clasificación de intensidad ─────────────────────────────────────────────

/**
 * Clasifica la intensidad de lluvia según el acumulado del día (mm).
 * Escala del SAB / estándar meteorológico colombiano.
 */
function clasificarIntensidad(acumuladoDia) {
  if (acumuladoDia === 0)    return 'sin_lluvia';
  if (acumuladoDia <= 10)   return 'bajo';
  if (acumuladoDia <= 30)   return 'moderado';
  if (acumuladoDia <= 50)   return 'alto';
  return 'muy_alto';
}

// ─── Transformación de respuesta SAB ─────────────────────────────────────────

function transformarEstacion(s) {
  const valor      = parseFloat(s.VALORLECTURA)  || 0;  // mm en último intervalo de 5min
  const acumulado  = parseFloat(s.ACUMULADODIA)  || 0;  // mm acumulados desde 00:00
  const lat        = parseFloat(s.LATITUD);
  const lon        = parseFloat(s.LONGITUD);

  return {
    id:             s.IDSENSOR,
    estacion_id:    s.IDESTACION,
    nombre:         s.ESTACION,
    lat,
    lon,
    valor_mm:       valor,        // lluvia en los últimos 5 minutos
    acumulado_dia:  acumulado,    // lluvia total desde medianoche
    intensidad:     clasificarIntensidad(acumulado),
    localidad:      s.LOCALIDAD  ?? null,
    localidad_id:   s.IDLOCALIDAD ?? null,
    ultima_lectura: s.FECHALECTURA ?? null,
    activa:         s.ESTADO === 1 || s.ESTADO === '1',
  };
}

// ─── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * GET /api/weather/lluvia
 *
 * Retorna las 71 estaciones pluviométricas del SAB con intensidad clasificada.
 * Cache de 5 minutos. Si el SAB está caído, retorna cache vencida con stale:true.
 *
 * Respuesta:
 * {
 *   ok: true,
 *   stale: false,
 *   fuente: "SAB",
 *   ciudad: "Bogotá",
 *   actualizado: "2026-06-15T12:00:00.000Z",
 *   estaciones: [{ id, nombre, lat, lon, valor_mm, acumulado_dia, intensidad, localidad, activa }]
 * }
 */
async function lluvia(req, res) {
  const now = Date.now();

  // Cache válida — retornar directamente sin llamar al SAB
  if (_cache.data && now - _cache.ts < CACHE_TTL_MS) {
    return res.json(_cache.data);
  }

  try {
    const url = `${SAB_BASE}/ServletTipoSensores?idtiposensor=5`;
    const raw = await httpsGetJson(url);

    if (!raw.TipoSensores || !Array.isArray(raw.TipoSensores)) {
      throw new Error('Respuesta inesperada del SAB (sin TipoSensores)');
    }

    const estaciones = raw.TipoSensores
      .map(transformarEstacion)
      .filter(e => !isNaN(e.lat) && !isNaN(e.lon)); // descartar estaciones sin coordenadas

    const result = {
      ok:          true,
      stale:       false,
      fuente:      'SAB',
      ciudad:      'Bogotá',
      actualizado: new Date().toISOString(),
      total:       estaciones.length,
      estaciones,
    };

    _cache = { data: result, ts: now };
    return res.json(result);

  } catch (err) {
    console.error('[Weather] Error consultando SAB:', err.message);

    // Si tenemos cache vencida, retornarla con advertencia antes de dar 503
    if (_cache.data) {
      const stale = { ..._cache.data, stale: true, stale_desde: new Date(_cache.ts).toISOString() };
      return res.json(stale);
    }

    return res.status(503).json({
      ok:      false,
      message: 'SAB no disponible y sin cache. Reintenta en unos minutos.',
      error:   err.message,
    });
  }
}

// ─── Radar SIRE ───────────────────────────────────────────────────────────────

/**
 * Descarga y parsea el KMZ de radar de reflectividad del SIRE.
 * Extrae el PNG de la imagen y los bounds LatLonBox del KML.
 * Cachea en memoria 5 minutos — misma política que lluvia SAB.
 *
 * FLUJO:
 *   1. Descarga el .kmz como Buffer (ZIP que contiene KML + PNG)
 *   2. AdmZip descomprime en memoria sin tocar el disco
 *   3. Regex extrae north/south/east/west del KML
 *   4. Busca el PNG más grande del ZIP (la imagen del radar)
 */
async function fetchRadarData() {
  const now = Date.now();
  if (_radarCache.imageBuffer && now - _radarCache.ts < CACHE_TTL_MS) {
    return _radarCache;
  }

  const kmzBuffer = await getBuffer(RADAR_KMZ_URL);
  const zip       = new AdmZip(kmzBuffer);
  const entries   = zip.getEntries();

  // Parsear el KML para obtener los bounds geográficos
  const kmlEntry = entries.find(e => e.entryName.endsWith('.kml') || e.entryName.endsWith('.xml'));
  if (!kmlEntry) throw new Error('KMZ sin archivo KML');
  const kml = kmlEntry.getData().toString('utf8');

  const extract = (tag) => {
    const m = kml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
    if (!m) throw new Error(`KML sin <${tag}>`);
    return parseFloat(m[1]);
  };

  const bounds = {
    north: extract('north'),
    south: extract('south'),
    east:  extract('east'),
    west:  extract('west'),
  };

  // Buscar la imagen del radar (PNG/JPG — el archivo más grande que no sea KML)
  const imgEntry = entries
    .filter(e => /\.(png|jpg|jpeg|gif)$/i.test(e.entryName))
    .sort((a, b) => b.header.size - a.header.size)[0];

  if (!imgEntry) throw new Error('KMZ sin imagen de radar');
  const imageBuffer = imgEntry.getData();

  _radarCache = { imageBuffer, bounds, ts: now };
  return _radarCache;
}

/**
 * GET /api/weather/radar/image
 *
 * Sirve la imagen PNG del radar de reflectividad del SIRE directamente.
 * El frontend usa esta URL en un ImageOverlay para superponer el radar al mapa.
 * Cache de 5 minutos (mismo ciclo que /lluvia).
 */
async function radarImage(req, res) {
  try {
    const { imageBuffer, ts } = await fetchRadarData();
    res.set('Content-Type',  'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Radar-Ts',    ts.toString());
    res.send(imageBuffer);
  } catch (err) {
    console.error('[Weather/Radar] Error:', err.message);
    res.status(503).json({ ok: false, message: 'Radar SIRE no disponible', error: err.message });
  }
}

/**
 * GET /api/weather/radar/bounds
 *
 * Retorna los bounds geográficos (LatLonBox) de la imagen del radar.
 * El frontend los necesita para posicionar el ImageOverlay correctamente.
 *
 * Respuesta: { ok, bounds: { north, south, east, west }, ts, actualizado }
 */
async function radarBounds(req, res) {
  try {
    const { bounds, ts } = await fetchRadarData();
    res.json({
      ok:          true,
      bounds,
      ts,
      actualizado: new Date(ts).toISOString(),
    });
  } catch (err) {
    console.error('[Weather/Radar] Error bounds:', err.message);
    res.status(503).json({ ok: false, message: 'Radar SIRE no disponible', error: err.message });
  }
}

module.exports = { lluvia, radarImage, radarBounds };

/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — weatherController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Proxy al SAB (Sistema de Alerta de Bogotá). El SAB bloquea
   peticiones desde el navegador (CORS), pero desde Node.js
   funciona sin problema. Este módulo consulta el SAB, clasifica
   la intensidad de lluvia por estación y retorna un JSON limpio.
   Cache de 5 minutos para no saturar el SAB con cada usuario.

   DIAGRAMA MENTAL:
   Frontend → GET /api/weather/lluvia → weatherController
     → ¿Cache válida (<5min)? → retornar cache
     → SAB API → transformar → cache → retornar
     → ¿SAB caído pero cache existe? → retornar stale:true
     → ¿SAB caído sin cache? → 503

   INTENSIDADES (acumulado día en mm):
     0           → sin_lluvia
     0.01 – 10   → bajo
     10.1 – 30   → moderado
     30.1 – 50   → alto
     > 50        → muy_alto

   EXPANSIÓN NACIONAL:
   Agregar un proveedor IDEAM o Open-Meteo para cubrir fuera
   de Bogotá. El schema de respuesta ya está diseñado para
   múltiples ciudades — solo agregar un parámetro ?ciudad=
   y un switch de fuente en la función lluvia().

   ═══════════════════════════════════════════════════════════ */
