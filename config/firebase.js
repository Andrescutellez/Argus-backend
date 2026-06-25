/**
 * @file config/firebase.js
 * @brief Inicializa Firebase Admin SDK (singleton).
 *
 * PROPÓSITO:
 *   Proveer una instancia única de firebase-admin para enviar push notifications
 *   (FCM) desde el backend. Se inicializa una sola vez al arrancar el servidor.
 *
 * PREREQUISITO:
 *   1. Crear proyecto en Firebase Console.
 *   2. Project Settings → Service accounts → Generate new private key.
 *   3. Guardar el JSON descargado como config/firebase-service-account.json.
 *   4. npm install firebase-admin
 *
 * @note Si el archivo de service account no existe, el módulo queda desactivado
 *       y pushService.js falla silenciosamente (no rompe el servidor).
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'firebase-service-account.json');

let initialized = false;

function initFirebase() {
  if (initialized) return;

  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn('[Firebase] firebase-service-account.json no encontrado — push notifications desactivadas.');
    return;
  }

  const serviceAccount = require(SERVICE_ACCOUNT_PATH);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialized = true;
  console.log('[Firebase] Admin SDK inicializado correctamente.');
}

function getAdmin() {
  return initialized ? admin : null;
}

module.exports = { initFirebase, getAdmin };
