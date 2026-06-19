/**
 * @fileoverview Descarga datos de criminalidad desde el OAIEE y los guarda como archivo estático.
 *
 * PROPÓSITO:
 *   El OAIEE (oaiee.scj.gov.co) solo responde desde redes colombianas.
 *   GCP Europa no puede acceder a él. Este script se ejecuta localmente (Colombia)
 *   para generar data/bogota-crime-static.json, que el backend en GCP usa como fallback.
 *
 * USO:
 *   node scripts/fetch-crime-data.js
 *
 * FRECUENCIA RECOMENDADA:
 *   Una vez al mes — el OAIEE actualiza datos de criminalidad mensualmente.
 */

'use strict';

const { buildBogotaData } = require('../controllers/crimeController');
const fs   = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '../data/bogota-crime-static.json');

console.log('[fetch-crime-data] Descargando desde OAIEE…');

buildBogotaData()
  .then(data => {
    fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[fetch-crime-data] ✅ Guardado: ${OUTPUT}`);
    console.log(`[fetch-crime-data]    Localidades: ${data.features.length}`);
    console.log(`[fetch-crime-data]    Con geometría: ${data.features.filter(f => f.geometry).length}`);
    console.log(`[fetch-crime-data]    Actualizado: ${data.meta?.updated_at}`);
    console.log('[fetch-crime-data] Ahora commitea el archivo y haz push:');
    console.log('  git add data/bogota-crime-static.json && git commit -m "data: actualizar datos OAIEE criminalidad" && git push');
  })
  .catch(err => {
    console.error('[fetch-crime-data] ❌ Error:', err.message);
    process.exit(1);
  });
