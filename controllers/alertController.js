/**
 * @fileoverview Controlador REST para consulta y gestión de alertas de seguridad.
 *
 * PROPÓSITO:
 *   Exponer el historial de eventos de seguridad de los devices a través de
 *   la API REST, y permitir que los operadores marquen alertas como atendidas.
 *
 * ENDPOINTS QUE SIRVE (ver routes/alert.js):
 *   GET  /api/alerts/:deviceId          — últimas N alertas del device
 *   PATCH /api/alerts/:alertId/ack      — marcar alerta como atendida
 *
 * CONSUMERS:
 *   - App Flutter: AlertsPage / SecurityScreen para historial de incidentes.
 *   - Web Usuario: HistoryPage para ver qué pasó con la moto.
 *   - Web Operador: AlertsFeed para el feed de tiempo real + historial.
 *
 * VARIABLES CRÍTICAS:
 *   MAX_LIMIT: tope máximo de documentos por query. Sin este tope, un cliente
 *   podría hacer GET /api/alerts/device?limit=999999 y cargar toda la colección
 *   en memoria del servidor de una sola vez.
 *
 * @module controllers/alertController
 */

'use strict';

const Alert = require('../models/Alert');

/**
 * Número máximo de alertas que se pueden pedir en una sola query.
 * El cliente puede pedir menos via ?limit=N, pero nunca más que este valor.
 */
const MAX_LIMIT = 200;

/**
 * @brief Retorna las últimas N alertas de un device, ordenadas de más reciente a más antigua.
 *
 * PROPÓSITO:
 *   Permite a la app y a las webs mostrar el historial de eventos de seguridad
 *   de una moto específica. El parámetro limit es configurable para que la UI
 *   pueda cargar más o menos eventos según la pantalla.
 *
 * FLUJO LÓGICO:
 *   1. Extraer deviceId del parámetro de URL.
 *   2. Parsear y sanitizar el parámetro de query ?limit (default 50, máx MAX_LIMIT).
 *   3. Consultar MongoDB con find + sort + limit + lean().
 *      lean() retorna POJOs en lugar de documentos Mongoose, lo que
 *      reduce el uso de memoria y acelera la serialización JSON.
 *   4. Retornar el array (puede ser vacío si el device no tiene alertas).
 *
 * DISEÑO: retornar array vacío (200) en lugar de 404 cuando no hay alertas.
 *   Un array vacío es un estado válido: "este device no tiene alertas todavía".
 *   Un 404 implicaría que el device no existe, lo cual no es lo que queremos decir.
 *
 * DEPENDENCIAS:
 *   - Alert (models/Alert.js): modelo Mongoose con índice { deviceId, timestamp }.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Paginación basada en cursor (antes/después de un _id) en lugar de skip/limit
 *      para evitar drift cuando se insertan nuevas alertas entre páginas.
 *   2. Filtro por tipo: GET /api/alerts/:deviceId?type=STATE_ALERT para que
 *      la UI pueda mostrar solo alertas críticas.
 *   3. Filtro por acknowledged: GET /api/alerts/:deviceId?acknowledged=false
 *      para el panel del operador que muestra solo lo pendiente.
 *   4. Proyección: si la UI solo necesita type+timestamp, no devolver lat/lon
 *      para reducir el payload de red.
 *
 * @param {import('express').Request} req
 *   Params: { deviceId: string }
 *   Query:  { limit?: string } — número de alertas a retornar (default 50, máx 200)
 * @param {import('express').Response} res
 *   - 200: Array<Alert> (puede ser vacío)
 *   - 500: error de MongoDB
 * @returns {Promise<void>}
 */
const getAlerts = async (req, res) => {
  const { deviceId } = req.params;

  // Sanitizar limit: parseInt puede retornar NaN si el query param no es numérico.
  // El || 50 maneja el caso NaN (si el cliente envió ?limit=abc).
  // Math.min asegura que nunca se supere MAX_LIMIT.
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_LIMIT);

  try {
    // lean() es crítico aquí: retorna POJOs planos en lugar de instancias Mongoose.
    // Las instancias Mongoose tienen getters, virtuals y métodos que
    // JSON.stringify no necesita. lean() reduce el uso de memoria a la mitad
    // para arrays grandes.
    const alerts = await Alert
      .find({ deviceId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(alerts);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Marca una alerta como atendida por un operador.
 *
 * PROPÓSITO:
 *   Permite que el operador del dashboard registre que revisó y atendió una
 *   alerta. Las alertas no-acknowledged aparecen como "pendientes de acción"
 *   en el feed del operador; este endpoint cierra ese ciclo.
 *
 * FLUJO LÓGICO:
 *   1. Extraer alertId del parámetro de URL (ID de MongoDB).
 *   2. Llamar findByIdAndUpdate con { acknowledged: true, acknowledgedAt: now }.
 *      new: true retorna el documento actualizado (no el original).
 *   3. Si el documento no existe → 404 (el ID era inválido o ya fue eliminado).
 *   4. Retornar el documento actualizado para que la UI refleje el cambio.
 *
 * DEPENDENCIAS:
 *   - Alert (models/Alert.js): para el update atómico.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Agregar el ID del operador que hizo el acknowledge (requiere auth JWT).
 *      Campo: acknowledgedBy: String (userId del operador).
 *   2. Permitir des-acknowledge (reapertura de alerta) con un campo de estado
 *      más rico: 'open' | 'acknowledged' | 'resolved'.
 *   3. Validar que alertId sea un ObjectId válido de MongoDB antes de la query,
 *      para retornar 400 en lugar de CastError si el ID está malformado.
 *
 * @param {import('express').Request} req
 *   Params: { alertId: string } — ObjectId de MongoDB de la alerta
 * @param {import('express').Response} res
 *   - 200: Alert actualizada con acknowledged=true
 *   - 404: alerta no encontrada
 *   - 500: error de MongoDB
 * @returns {Promise<void>}
 */
const acknowledgeAlert = async (req, res) => {
  const { alertId } = req.params;

  const by = req.user ? {
    userId:    req.user.sub,
    userEmail: req.user.email,
    role:      req.user.role,
    platform:  req.body?.platform ?? null,
  } : null;

  const now = new Date();

  try {
    const alert = await Alert.findByIdAndUpdate(
      alertId,
      {
        acknowledged:   true,
        acknowledgedAt: now,
        acknowledgedBy: by ?? undefined,
      },
      { new: true },
    );

    if (!alert) {
      return res.status(404).json({ message: 'Alerta no encontrada' });
    }

    // Registrar en el historial quién silenció qué alerta.
    Alert.create({
      deviceId:  alert.deviceId,
      type:      'ALERT_ACKNOWLEDGED',
      source:    'command',
      actor:     by ?? undefined,
      meta:      { refAlertId: alertId },
      timestamp: now,
    }).catch(() => {});

    return res.status(200).json(alert);
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
module.exports = { getAlerts, acknowledgeAlert };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — controllers/alertController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador tiene dos responsabilidades: dar acceso al historial de
   alertas de una moto (para que la app y las webs muestren qué pasó), y
   permitir que el operador marque como "atendida" una alerta que ya revisó.
   Es como el registro de incidentes de una central de monitoreo: puedes
   consultar el historial y marcar cada caso como cerrado.

   PSEUDOCÓDIGO:
   getAlerts(deviceId, limit):
     → alerts = Alert.find({ deviceId }).sort(-timestamp).limit(limit)
     → return 200 alerts

   acknowledgeAlert(alertId):
     → alert = Alert.findByIdAndUpdate(alertId, { acknowledged: true, ... })
     → si null → 404
     → return 200 alert

   DIAGRAMA MENTAL:
   GET /api/alerts/:deviceId?limit=20
     → find({ deviceId }).sort(-ts).limit(20)
     → [alerta1, alerta2, ...] → App Flutter / Web

   PATCH /api/alerts/:alertId/ack
     → findByIdAndUpdate → acknowledged=true
     → Web Operador actualiza badge de "pendiente"

   VARIABLES CRÍTICAS:
   - MAX_LIMIT: sin este tope, queries sin límite pueden agotar la memoria del servidor
   - acknowledged: estado de revisión — si se pierde, operadores no saben qué atender

   ═══════════════════════════════════════════════════════════ */
