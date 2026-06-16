/**
 * @fileoverview Script manual para refrescar CAI/estaciones de OAIEE como JSON estático.
 *
 * PROPÓSITO:
 *   Descarga cuadrantes, CAI y estaciones directamente de OAIEE y los persiste
 *   como archivos JSON en data/gis/ del backend principal.
 *   El backend carga estos archivos en memoria al arrancar — sin BD GIS necesaria.
 *   Los cuadrantes nacionales (4,621) ya no dependen de este script — vienen en
 *   vivo de la API Policía Nacional vía gisController.js. Esto solo cubre CAI/
 *   estaciones de Bogotá, que no cambian con frecuencia.
 *
 * USO (correr desde gis-sync-service/):
 *   node scripts/fetchGisStatic.js
 *
 * OUTPUT:
 *   ../data/gis/cuadrantes.geojson  — 599 polígonos + teléfono patrullero
 *   ../data/gis/cai.json            — 154 puntos CAI
 *   ../data/gis/estaciones.json     — 21 estaciones de policía
 *
 * TIEMPO ESTIMADO: ~30 segundos (solo 3 páginas de datos).
 *
 * @module scripts/fetchGisStatic
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const axios = require('axios');
const { fetchAll } = require('../oaieeClient');

const OAIEE_BASE = 'https://oaiee.scj.gov.co/agc/rest/services';

/**
 * Fetch directo de CAI con parámetros mínimos — sin datumTransformation ni outSR,
 * porque el endpoint 22 retorna 400 con esos parámetros.
 * CAI ya viene en WGS84 con lat/lon en los atributos propios.
 * Usa f=json (no geojson) para evitar cualquier transformación de coordenadas.
 */
/**
 * Fetch directo de CAI probando variantes de params hasta encontrar la que
 * no retorna 400. El endpoint 22 no soporta todas las combinaciones de parámetros.
 */
async function fetchCaiDirect() {
  const url = `${OAIEE_BASE}/Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/22/query`;

  // Variantes de parámetros a probar en orden — del más minimal al más específico.
  // Algunos endpoints OAIEE retornan 400 con outSR, datumTransformation o resultOffset.
  const variants = [
    // Variante 1: absolutamente mínimo, sin paginación, todos los campos
    { where: '1=1', outFields: '*', returnGeometry: false, f: 'json' },
    // Variante 2: campos específicos, sin paginación
    { where: '1=1', outFields: 'OBJECTID,EPONOMBRE,EPODIR_SITIO,EPOLATITUD,EPOLONGITU,EPOIULOCAL', returnGeometry: false, f: 'json' },
    // Variante 3: con outSR pero sin datumTransformation
    { where: '1=1', outFields: '*', returnGeometry: false, outSR: 4326, f: 'json' },
    // Variante 4: geojson sin datum
    { where: '1=1', outFields: '*', returnGeometry: false, f: 'geojson' },
  ];

  let lastErr = null;
  for (const params of variants) {
    try {
      console.log(`  [cai] probando params: ${JSON.stringify(params)}`);
      const res = await axios.get(url, { params, timeout: 45_000 });
      if (res.data.error) throw new Error(`OAIEE error ${res.data.error.code}: ${res.data.error.message}`);

      // f=json → features[].attributes; f=geojson → features[].properties
      const raw = res.data.features || [];
      console.log(`  [cai] ✓ variante exitosa — ${raw.length} features`);
      return raw;
    } catch (err) {
      console.warn(`  [cai] variante falló: ${err.message}`);
      lastErr = err;
    }
  }

  throw lastErr;
}

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'gis');

// ─── helpers ─────────────────────────────────────────────────────────────────

function padCode(val, len) {
  return val != null ? String(val).padStart(len, '0') : null;
}

function save(filename, data) {
  const filePath = path.join(OUT_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const kb = (fs.statSync(filePath).size / 1024).toFixed(1);
  console.log(`  ✓ ${filename} — ${kb} KB`);
}

// ─── fetch functions ──────────────────────────────────────────────────────────

async function fetchCuadrantes() {
  console.log('\n[1/3] Descargando cuadrantes (599 polígonos + teléfonos patrulleros)...');
  const features = await fetchAll(
    'Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/25/query',
    { outFields: 'PCUCODIGO,PCUNOMCAI,PCUNOMEST,PCUTELEFON,PCUIULOCAL' }
  );

  if (features.length < 500) throw new Error(`Solo ${features.length} cuadrantes — esperaba ≥500`);

  const geojson = {
    type: 'FeatureCollection',
    features: features
      .filter(f => f.geometry)
      .map(f => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          pcu_codigo:   f.properties.PCUCODIGO,
          pcu_nom_cai:  f.properties.PCUNOMCAI  ?? null,
          pcu_nom_est:  f.properties.PCUNOMEST  ?? null,
          pcu_telefono: f.properties.PCUTELEFON ?? null,
          loc_codigo:   padCode(f.properties.PCUIULOCAL, 2),
        },
      })),
  };

  const conTelefono = geojson.features.filter(f => f.properties.pcu_telefono).length;
  console.log(`  ${features.length} cuadrantes, ${conTelefono} con teléfono patrullero`);
  save('cuadrantes.geojson', geojson);
  return geojson.features.length;
}

async function fetchCai() {
  console.log('\n[2/3] Descargando CAI (154 puntos)...');
  // El endpoint 22 retorna 400 con datumTransformation o outSR — usa fetchCaiDirect
  // que hace el request con parámetros mínimos y f=json (atributos en .attributes).
  const features = await fetchCaiDirect();

  if (features.length < 100) throw new Error(`Solo ${features.length} CAI — esperaba ≥100`);

  const data = features
    .map(f => {
      // f=json → .attributes; f=geojson → .properties
      // Campos reales del endpoint 22: CAI* (no EPO* como en las estaciones)
      const a = f.attributes || f.properties || {};
      return {
        id:         a.OBJECTID,
        nombre:     a.CAINOMBRE   ?? null,
        descripcion:a.CAIDESCRIP  ?? null,
        direccion:  a.CAIDIR_SIT  ?? null,
        lat:        a.CAILATITUD  ?? null,
        lon:        a.CAILONGITU  ?? null,
        telefono:   a.CAITELEFON  ?? null,
        loc_codigo: padCode(a.CAIIULOCAL, 2),
      };
    })
    .filter(c => c.lat != null && c.lon != null);

  console.log(`  ${data.length} CAI con coordenadas válidas`);
  save('cai.json', data);
  return data.length;
}

async function fetchEstaciones() {
  console.log('\n[3/3] Descargando estaciones de policía (21 puntos)...');
  const features = await fetchAll(
    'Tematicos_NR/EquipamientoPMSDSCJ/FeatureServer/23/query',
    { outFields: 'OBJECTID,EPONOMBRE,EPODIR_SITIO,EPOLATITUD,EPOLONGITU,EPOTELEFON,EPOIULOCAL' }
  );

  if (features.length < 15) throw new Error(`Solo ${features.length} estaciones — esperaba ≥15`);

  const data = features
    .map(f => ({
      id:         f.properties.OBJECTID,
      nombre:     f.properties.EPONOMBRE    ?? null,
      direccion:  f.properties.EPODIR_SITIO ?? null,
      lat:        f.properties.EPOLATITUD   ?? null,
      lon:        f.properties.EPOLONGITU   ?? null,
      telefono:   f.properties.EPOTELEFON   ?? null,
      loc_codigo: padCode(f.properties.EPOIULOCAL, 2),
    }))
    .filter(e => e.lat != null && e.lon != null);

  console.log(`  ${data.length} estaciones con coordenadas válidas`);
  save('estaciones.json', data);
  return data.length;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' Argus GIS — Descarga estática desde OAIEE');
  console.log('═══════════════════════════════════════════════');
  console.log(`Destino: ${OUT_DIR}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const t0 = Date.now();
  try {
    const [c, cai, est] = await Promise.all([
      fetchCuadrantes(),
      fetchCai(),
      fetchEstaciones(),
    ]);

    console.log('\n═══════════════════════════════════════════════');
    console.log(` ✓ COMPLETO en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`   Cuadrantes: ${c} | CAI: ${cai} | Estaciones: ${est}`);
    console.log(' Ahora: git add data/gis/ && git push');
    console.log('═══════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n✗ ERROR:', err.message);
    process.exit(1);
  }
}

main();
