/**
 * @fileoverview Controlador REST para ingestión y consulta de datos GPS.
 *
 * Este controlador maneja el canal HTTP de datos GPS, complementario al canal TCP.
 * Mientras el canal TCP (tcpServer.js) es el camino optimizado para el ESP32 con
 * módulo SIM A7670, este controlador atiende:
 *   - Dispositivos que usan HTTP en lugar de TCP (compatibilidad con hardware alternativo).
 *   - El frontend web para consultar historial de posiciones.
 *   - La última posición conocida de un dispositivo específico.
 *
 * RELACIÓN CON EL CANAL TCP:
 *   Los datos guardados por el canal TCP (via tcp/queue.js → insertMany) y los guardados
 *   por este controlador (via nuevoDato.save()) terminan en la misma colección MongoDB,
 *   así que las consultas de historial devuelven datos de ambos canales indistintamente.
 *
 * @module controllers/gpsController
 */

'use strict';

const Gps = require('../models/Gps');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

/**
 * Tiempo máximo en milisegundos que se espera a que MongoDB responda antes de
 * devolver 201 al dispositivo de todas formas.
 *
 * CONTEXTO CRÍTICO:
 *   El módulo A7670 del ESP32 tiene un timer interno de ~30 segundos para
 *   el comando AT+HTTPACTION. Si el servidor no responde dentro de ese tiempo,
 *   el módulo marca la acción como fallida y puede reintentar, generando duplicados.
 *   MongoDB Atlas en el tier gratuito puede tardar 3-5 segundos en el cold-start
 *   (primera query después de un período de inactividad).
 *
 *   Con DB_SAVE_TIMEOUT_MS = 8000, el ESP32 siempre recibe respuesta mucho antes
 *   del límite de 30s, incluso en el peor caso de cold-start de Atlas.
 *
 * TRADE-OFF:
 *   Si MongoDB tarda más de 8s, se responde 201 pero el dato se descarta.
 *   En un sistema de telemetría GPS donde el device envía cada 30s, perder
 *   un punto ocasionalmente es aceptable. Si fuera datos financieros o de salud,
 *   NO sería aceptable y el trade-off sería diferente.
 */
const DB_SAVE_TIMEOUT_MS = 8000;

// ─── HANDLERS REST ────────────────────────────────────────────────────────────

/**
 * @brief Recibe y persiste un dato GPS enviado por HTTP POST.
 *
 * PROPÓSITO:
 *   Endpoint de ingestión para dispositivos que envían posiciones GPS vía HTTP
 *   en lugar del canal TCP. Valida la estructura y rangos del payload antes de
 *   intentar la escritura en MongoDB. Implementa un timeout de escritura para
 *   garantizar respuesta oportuna al hardware con timers estrictos.
 *
 * FLUJO LÓGICO:
 *   1. Extraer campos del body (destructuring con fallback ?? {}).
 *   2. Validar presencia de campos obligatorios (deviceId, lat, lon).
 *   3. Parsear lat y lon a Number y validar que sean numéricos.
 *   4. Validar rangos geográficos (lat: -90 a 90, lon: -180 a 180).
 *   5. Crear instancia del modelo Gps con los datos validados.
 *   6. Guardar en MongoDB con un race contra un timeout explícito.
 *   7. Si MongoDB responde a tiempo: retornar 201.
 *   8. Si timeout: retornar 201 de todas formas (dato descartado, no se duplica).
 *   9. Si error real de MongoDB: retornar 500.
 *
 * DEPENDENCIAS:
 *   - Gps: modelo Mongoose (models/Gps.js)
 *   - DB_SAVE_TIMEOUT_MS: constante de este módulo
 *
 * POSIBLES MEJORAS (senior):
 *   1. Responder 202 Accepted en caso de timeout en lugar de 201 Created, para
 *      comunicar honestamente al cliente que el dato podría no haberse persistido.
 *      (El ESP32 actual no distingue 201 de 202, pero un cliente HTTP sofisticado sí.)
 *   2. Emitir evento Socket.io 'gps:update' también desde este endpoint para que
 *      los clientes web reciban actualizaciones en tiempo real tanto del canal TCP
 *      como del canal HTTP.
 *   3. Agregar validación de deviceId contra la whitelist de ALLOWED_DEVICES para
 *      consistencia con el canal TCP.
 *   4. Agregar rate limiting por deviceId: actualmente un device podría hacer
 *      miles de requests HTTP por segundo sin restricción.
 *   5. Loguear con el logger estructurado (tcp/logger.js) en lugar de console.warn/log
 *      para consistencia en el formato de logs del sistema.
 *
 * @param {import('express').Request} req
 *   Body esperado: { deviceId: string, lat: number|string, lon: number|string,
 *                    speed?: number, gpsFix?: boolean, timestamp?: string|number }
 * @param {import('express').Response} res
 *   - 201: dato guardado correctamente (o timeout, para no bloquear el hardware)
 *   - 400: campos faltantes o valores inválidos
 *   - 500: error de MongoDB inesperado
 * @returns {Promise<void>}
 */
const guardarDato = async (req, res) => {
  // t0 captura el timestamp de inicio para medir latencia total del handler.
  // Esta métrica es útil para detectar degradación de performance (si sube de
  // <100ms a >500ms, algo está mal con MongoDB o la red).
  const t0 = Date.now();

  // Destructuring con fallback ?? {} previene que req.body undefined lance TypeError.
  // En Express 5 con express.json() como middleware, req.body siempre es un objeto
  // si el Content-Type es application/json. El ?? {} es una salvaguarda extra.
  const { deviceId, lat, lon, speed, gpsFix, timestamp } = req.body ?? {};

  // ── Validación de campos obligatorios ─────────────────────────────────────
  // deviceId identifica el dispositivo; sin él no sabemos a quién pertenece el dato.
  // lat y lon son la razón de ser del sistema; sin ellos el registro es inútil.
  // speed, gpsFix y timestamp son opcionales: tienen defaults en el schema.
  if (!deviceId || lat === undefined || lon === undefined) {
    // console.warn en lugar del logger estructurado: inconsistencia de logging.
    // ARQUITECTURA ⚠️: mezcla de console.warn y logger estructurado
    //   CÓMO LO HARÍA UN SENIOR: usar el mismo logger JSON en todo el sistema.
    //   IMPACTO ACTUAL: los logs de este controlador no son filtrables por 'event'.
    console.warn(`[GPS] 400 bad-request — body: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ message: 'Campos requeridos: deviceId, lat, lon' });
  }

  // ── Conversión y validación numérica ─────────────────────────────────────
  // parseFloat acepta tanto strings ("19.432") como números (19.432).
  // Si el body viene con lat como string (dispositivos legacy), parseFloat lo convierte.
  // Si viene como NaN o un string no numérico ("norte"), parseFloat retorna NaN
  // y la siguiente validación lo captura.
  const latN = parseFloat(lat);
  const lonN = parseFloat(lon);

  // isNaN() verifica que la conversión fue exitosa.
  // Sin este check, isNaN de parseFloat("abc") → NaN se guardaría en MongoDB
  // como NaN (que Mongoose puede aceptar dependiendo de la versión).
  if (isNaN(latN) || isNaN(lonN)) {
    return res.status(400).json({ message: 'lat y lon deben ser números válidos' });
  }

  // ── Validación de rangos geográficos ──────────────────────────────────────
  // Coordenadas fuera de rango son físicamente imposibles: la Tierra no tiene
  // latitud 91 ni longitud 200. Un GPS sin fix suele reportar 0.0/0.0 (válido
  // pero el Océano Atlántico), o valores como 999.0 (inválido, capturado aquí).
  if (latN < -90 || latN > 90) {
    return res.status(400).json({ message: 'lat debe estar entre -90 y 90' });
  }
  if (lonN < -180 || lonN > 180) {
    return res.status(400).json({ message: 'lon debe estar entre -180 y 180' });
  }

  // ── Construcción del documento Mongoose ───────────────────────────────────
  // Se crea una instancia del modelo con los datos validados.
  // No se usa Gps.create() directamente para tener control del objeto antes de guardarlo
  // (útil si en el futuro se agrega lógica de transformación pre-save).
  const nuevoDato = new Gps({
    deviceId,
    lat: latN,
    lon: lonN,
    // speed puede ser undefined si el device no lo envía; en ese caso, el schema
    // aplica el default de 0. parseFloat(undefined) retorna NaN, así que el
    // check condicional es necesario.
    speed: speed !== undefined ? parseFloat(speed) : 0,
    // Si timestamp viene como ISO string o epoch ms, se convierte a Date.
    // Si no viene, Date.now() como fallback (tiempo de recepción del servidor,
    // que es diferente al tiempo de medición del GPS).
    // ARQUITECTURA ⚠️: timestamp del servidor ≠ timestamp del GPS
    //   CÓMO LO HARÍA UN SENIOR: exigir timestamp del dispositivo y rechazar si
    //   es demasiado diferente al tiempo actual (previene replay de datos históricos).
    //   IMPACTO ACTUAL: si el device tiene el reloj desincronizado, los datos
    //   aparecerán fuera de orden en el historial.
    timestamp: timestamp ? new Date(timestamp) : Date.now(),
  });

  try {
    // ── Race contra timeout explícito ────────────────────────────────────────
    // Promise.race() resuelve o rechaza con el primero que termine.
    // Si MongoDB responde en <8s, nuevoDato.save() gana la race y el dato se guarda.
    // Si MongoDB tarda más de 8s, el timeout gana, reject con Error("DB timeout"),
    // y el catch maneja ese caso especialmente respondiendo 201 para no bloquear el hardware.
    //
    // IMPORTANTE: aunque el timeout gana la race, la Promise de nuevoDato.save()
    // NO se cancela. MongoDB puede terminar de guardar el dato después del timeout.
    // Esto significa que en el caso de timeout, el dato PODRÍA guardarse o NO,
    // dependiendo de si MongoDB termina la operación antes de que la conexión se cierre.
    await Promise.race([
      nuevoDato.save(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB timeout')), DB_SAVE_TIMEOUT_MS)
      ),
    ]);

    const ms = Date.now() - t0;
    console.log(
      `[GPS] 201 ${deviceId} lat=${latN} lon=${lonN} gpsFix=${gpsFix ?? '?'} (${ms}ms)`
    );
    return res.status(201).json({ message: 'OK' });

  } catch (error) {
    const ms = Date.now() - t0;

    if (error.message === 'DB timeout') {
      // Caso especial: timeout intencional.
      // Se responde 201 para evitar que el ESP32 reintente (los reintentos causarían
      // duplicados si MongoDB termina de guardar el dato después del timeout).
      // La telemetría GPS es tolerante a pérdidas individuales: el siguiente ciclo
      // (en ~30 segundos) enviará un dato nuevo con la posición actualizada.
      console.error(
        `[GPS] DB timeout después de ${ms}ms — dato descartado para ${deviceId}`
      );
      return res.status(201).json({ message: 'OK' });
    }

    // Error inesperado de MongoDB: schema inválido, conexión caída sin timeout, etc.
    // Se responde 500 para que el cliente sepa que algo está mal.
    // El ESP32 con el módulo A7670 puede reintentar en el siguiente ciclo.
    console.error(`[GPS] 500 error guardando dato: ${error.message} (${ms}ms)`);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna los últimos 100 registros GPS de todos los dispositivos.
 *
 * PROPÓSITO:
 *   Endpoint para que el frontend consulte el historial reciente de posiciones.
 *   Ordenados por timestamp descendente para que el más reciente aparezca primero.
 *
 * FLUJO LÓGICO:
 *   1. Consultar la colección 'gps' sin filtro (todos los devices).
 *   2. Ordenar por timestamp descendente (más reciente primero).
 *   3. Limitar a 100 resultados (paginación hardcodeada).
 *   4. Retornar el array de documentos como JSON.
 *
 * DEPENDENCIAS:
 *   - Gps: modelo Mongoose.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Paginación real con parámetros de query: ?page=1&limit=50&deviceId=ESP32-001
 *      El hardcode de limit:100 hace que el frontend no pueda cargar más registros.
 *   2. Índice en MongoDB sobre {timestamp: -1} para que el sort sea eficiente.
 *      Sin índice, MongoDB hace un collection scan con sort O(n log n) en memoria.
 *   3. Filtrado por deviceId como query param opcional: GET /api/gps?deviceId=ESP32-001
 *   4. Filtrado por rango de fechas: ?from=2026-01-01&to=2026-01-31
 *   5. Proyección de campos: retornar solo lat, lon, timestamp en lugar del documento completo
 *      para reducir el tamaño de la respuesta.
 *
 * @param {import('express').Request} req — Sin parámetros de query implementados.
 * @param {import('express').Response} res
 *   - 200: array de hasta 100 documentos GPS
 *   - 500: error de MongoDB
 * @returns {Promise<void>}
 */
const obtenerDatos = async (req, res) => {
  try {
    // find({}) sin filtro retorna TODOS los documentos de la colección.
    // sort({ timestamp: -1 }) ordena por timestamp descendente: el más reciente primero.
    // limit(100) previene que una respuesta masiva sature la red o el cliente.
    // ARQUITECTURA ⚠️: sin índice definido en timestamp, este query puede ser lento
    //   CÓMO LO HARÍA UN SENIOR: agregar { timestamp: -1 } al schema de Gps.js:
    //   GpsSchema.index({ timestamp: -1 }) y también { deviceId: 1, timestamp: -1 }
    //   para queries por device.
    //   IMPACTO ACTUAL: con decenas de miles de registros, este query puede tardar
    //   varios segundos sin índice.
    const datos = await Gps.find({}).sort({ timestamp: -1 }).limit(100);
    return res.status(200).json(datos);
  } catch (error) {
    console.error('Error al obtener datos GPS:', error.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna el registro GPS más reciente de un dispositivo específico.
 *
 * PROPÓSITO:
 *   Permite al frontend mostrar la posición actual de una moto específica
 *   sin tener que descargar el historial completo y filtrar en el cliente.
 *   También es útil para que el frontend muestre un mapa con la última
 *   posición conocida cuando el dispositivo está offline.
 *
 * FLUJO LÓGICO:
 *   1. Extraer deviceId del parámetro de URL (:deviceId).
 *   2. Buscar el documento más reciente con ese deviceId usando findOne + sort.
 *   3. Si no hay registros para ese device, retornar 404.
 *   4. Si hay registros, retornar el más reciente con 200.
 *
 * DEPENDENCIAS:
 *   - Gps: modelo Mongoose.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Agregar índice compuesto { deviceId: 1, timestamp: -1 } en el schema
 *      para que findOne().sort() sea O(1) en lugar de O(n).
 *      Sin este índice, MongoDB escanea todos los documentos del deviceId.
 *   2. Validar que deviceId tenga un formato esperado (ej: /^ESP32-\d{3}$/)
 *      para prevenir queries con valores arbitrarios.
 *   3. Agregar caché (Redis con TTL de 30s) ya que la posición más reciente
 *      cambia máximo cada 30 segundos (ciclo de envío del ESP32).
 *      Esto reduciría la carga en MongoDB en el dashboard con múltiples usuarios.
 *
 * @param {import('express').Request} req
 *   Parámetros de URL: { deviceId: string }
 * @param {import('express').Response} res
 *   - 200: el documento GPS más reciente del device
 *   - 404: no hay registros para ese deviceId
 *   - 500: error de MongoDB
 * @returns {Promise<void>}
 */
const getLatestByDevice = async (req, res) => {
  // req.params.deviceId viene del parámetro de ruta definido en routes/gps.js:
  // router.get('/:deviceId/latest', getLatestByDevice)
  const { deviceId } = req.params;

  try {
    // findOne() con sort({ timestamp: -1 }) es más eficiente que find() + [0]
    // porque MongoDB puede usar el índice para retornar solo el primer elemento
    // en lugar de cargar todos en memoria.
    // Si no hay documentos que coincidan, findOne() retorna null (no lanza error).
    const record = await Gps.findOne({ deviceId }).sort({ timestamp: -1 });

    if (!record) {
      // 404 en lugar de 200 con null: es semánticamente más correcto.
      // El frontend puede distinguir "device existe pero no tiene datos" (404)
      // de "device no existe" (también 404 aquí, pero idealmente sería diferente).
      return res.status(404).json({ message: 'No hay datos para este dispositivo' });
    }

    return res.status(200).json(record);
  } catch (error) {
    console.error('Error al obtener GPS latest:', error.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
module.exports = { guardarDato, obtenerDatos, getLatestByDevice };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — controllers/gpsController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador maneja las tres formas en que el sistema web consulta e
   ingiere datos GPS. guardarDato() recibe posiciones de dispositivos que usan
   HTTP (en lugar del canal TCP directo), validando que los datos sean geográficamente
   válidos antes de guardarlos. obtenerDatos() devuelve el historial reciente para
   que el frontend lo muestre en un mapa. getLatestByDevice() devuelve solo la
   última posición de una moto específica, útil para el panel de monitoreo en tiempo
   real. La característica más sofisticada es el timeout de 8 segundos en guardarDato():
   si MongoDB tarda demasiado, el sistema responde "OK" de todas formas para no
   bloquear al hardware del ESP32.

   PSEUDOCÓDIGO:
   guardarDato(req, res):
     → extraer y validar deviceId, lat, lon del body
     → crear documento Gps con datos validados
     → Promise.race([nuevoDato.save(), timeout(8s)])
     → si guarda en tiempo → 201 OK
     → si timeout → 201 OK (dato posiblemente perdido)
     → si error real → 500

   obtenerDatos(req, res):
     → Gps.find().sort(-timestamp).limit(100)
     → 200 con array de documentos

   getLatestByDevice(req, res):
     → Gps.findOne({ deviceId }).sort(-timestamp)
     → 404 si no hay datos
     → 200 con el documento más reciente

   DIAGRAMA MENTAL:
   POST /api/gps → guardarDato() → validate → new Gps() → save() → 201
   GET /api/gps → obtenerDatos() → find().sort().limit(100) → 200 [array]
   GET /api/gps/:id/latest → getLatestByDevice() → findOne().sort() → 200 | 404

   VARIABLES CRÍTICAS:
   - DB_SAVE_TIMEOUT_MS: si se reduce demasiado, los datos se descartan en latencia normal de Atlas
   - nuevoDato: si el schema Mongoose rechaza el documento (validación), se lanza un error 500

   RIESGOS DE SEGURIDAD:
   - Sin autenticación: cualquiera puede POST datos GPS en nombre de cualquier deviceId
   - Sin whitelist de deviceIds: un atacante puede crear datos para devices inexistentes
   - Sin rate limiting HTTP: un bot puede hacer miles de requests por segundo
   - gpsFix se loguea pero no se almacena en el schema de Gps.js (campo fantasma)

   RIESGOS DE CONCURRENCIA:
   - Promise.race() con el timeout no cancela la Promise de save(): MongoDB puede
     guardar el dato DESPUÉS de que el servidor ya respondió 201 por timeout.
     Esto puede crear una inconsistencia entre "el servidor dijo que se perdió" y
     "en realidad sí está en MongoDB".
   - Sin transacciones: si el proceso cae entre crear el documento y llamar .save(),
     no hay dato parcial en MongoDB (MongoDB garantiza atomicidad por documento).

   ═══════════════════════════════════════════════════════════ */
