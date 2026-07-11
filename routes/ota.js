'use strict';

/**
 * @file routes/ota.js
 * @brief Rutas REST para el sistema de actualización OTA del firmware Argus.
 *
 * PROPÓSITO:
 *   Permitir que la app Flutter verifique si hay una nueva versión del firmware
 *   disponible y obtenga la URL de descarga del archivo .bin. El dispositivo
 *   ESP32 reporta su versión actual en el frame DIAG (campo fw_version).
 *
 * ENDPOINTS:
 *   GET  /api/ota/version          → versión disponible + URL del .bin
 *   GET  /api/ota/device/:deviceId → versión instalada en un dispositivo específico
 *
 * FLUJO OTA COMPLETO:
 *   1. App carga → llama GET /api/ota/version → obtiene { latest, url, changelog }
 *   2. App compara latest vs fwVersion del socket device:diag
 *   3. Si hay actualización: app muestra banner → usuario acepta → app descarga .bin
 *   4. App transfiere .bin al ESP32 por BLE (servicio OTA GATT)
 *   5. ESP32 flashea, reinicia → reporta nueva versión en siguiente DIAG
 *
 * SUBIR NUEVA VERSIÓN (flujo de release):
 *   1. Compilar en IDF: idf.py build → genera build/argus-secure.bin
 *   2. Subir al servidor:
 *        scp build/argus-secure.bin usuario@argussecure.online:/opt/argus/ota/
 *   3. Actualizar LATEST_VERSION en este archivo → PM2 restart argus-api
 *
 * @module routes/ota
 */

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');

// ─── Versión disponible en el servidor ───────────────────────────────────────
// ACTUALIZAR AQUÍ en cada release, junto con subir el nuevo .bin al servidor.
// Debe coincidir con FIRMWARE_VERSION en components/core/include/firmware_version.h
const LATEST_VERSION = '1.0.0';
const FIRMWARE_URL   = 'https://ota.argussecure.online/argus-secure.bin';
const CHANGELOG      = 'Primera versión con soporte OTA vía BLE. Sistema de alarma rediseñado.';

/**
 * GET /api/ota/version
 *
 * Retorna la versión más reciente disponible del firmware y la URL de descarga.
 * La app compara esta versión contra la reportada por el dispositivo en device:diag.
 *
 * No requiere autenticación — la URL del .bin es pública (el archivo en sí no
 * contiene información sensible; es el firmware compilado del ESP32).
 *
 * Respuesta:
 *   { version: "1.0.0", url: "https://...", changelog: "...", publishedAt: "ISO" }
 */
router.get('/version', (_req, res) => {
  res.json({
    version:     LATEST_VERSION,
    url:         FIRMWARE_URL,
    changelog:   CHANGELOG,
    publishedAt: '2026-07-11T00:00:00Z',
  });
});

/**
 * GET /api/ota/device/:deviceId
 *
 * Retorna la versión instalada actualmente en un dispositivo (según el último DIAG).
 * Permite a la app saber si el dispositivo ya tiene la última versión sin esperar
 * al próximo frame DIAG (que solo se envía al conectar TCP).
 *
 * Requiere autenticación JWT + acceso al dispositivo.
 *
 * Respuesta:
 *   { deviceId, installedVersion, latestVersion, updateAvailable }
 */
router.get('/device/:deviceId', authenticate, async (req, res) => {
  try {
    const DeviceState = require('../models/DeviceState');
    const state = await DeviceState.findOne({ deviceId: req.params.deviceId }).lean();
    const installedVersion = state?.fwVersion ?? null;
    const updateAvailable  = installedVersion
      ? installedVersion !== LATEST_VERSION
      : null;  // null = desconocida (device no ha reportado DIAG con fw_version aún)

    res.json({
      deviceId:         req.params.deviceId,
      installedVersion,
      latestVersion:    LATEST_VERSION,
      updateAvailable,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
