/**
 * @fileoverview Controlador REST para consulta de estado y envío de comandos a dispositivos ESP32.
 *
 * PROPÓSITO:
 *   Exponer la información y el control de los dispositivos TCP a través de la API REST.
 *   Actúa como puente entre el mundo HTTP (el frontend del operador hace REST) y
 *   el mundo TCP (el hardware ESP32 tiene una conexión persistente en tcpServer.js).
 *
 * RELACIÓN CON tcpServer.js:
 *   Este controlador importa dos cosas de tcpServer.js:
 *   - connectedDevices: Map<deviceId, Socket> — para saber si el device está online.
 *   - sendCommand(): función que escribe el comando en el socket TCP del device.
 *   Sin esta integración, el controlador no podría distinguir "device online" de
 *   "device offline" ni enviar comandos en tiempo real.
 *
 * COMANDOS VÁLIDOS:
 *   VALID_COMMANDS define la whitelist completa de comandos aceptados. Incluye:
 *   - Comandos de control de seguridad: ARM, DISARM, ALERT, ENGINE_CUT
 *   - Comandos de sensibilidad del acelerómetro: SENSITIVITY_VERY_LOW → VERY_HIGH
 *     (5 niveles, ver regla de documentación del proyecto para detalles de sensibilidad)
 *
 * VARIABLES CRÍTICAS:
 *   VALID_COMMANDS: si se agrega un nuevo comando en el firmware pero no aquí,
 *   el operador recibirá 400 al intentar enviarlo. Mantener sincronizado con firmware.
 *
 * @module controllers/deviceController
 */

'use strict';

const Gps = require('../models/Gps');
const Alert = require('../models/Alert');
const DeviceState = require('../models/DeviceState');
const { connectedDevices, sendCommand, getIo } = require('../tcp/tcpServer');
const { gt06OnlineImeis, sendGt06Command }      = require('../tcp/gt06Server');

/**
 * Whitelist de comandos válidos que el servidor acepta y puede transmitir al ESP32.
 *
 * PROPÓSITO:
 *   Prevenir que un cliente REST envíe strings arbitrarios al device, lo que podría
 *   corromper el protocolo TCP o explotar el parser del firmware.
 *
 * SINCRONIZACIÓN CON FIRMWARE:
 *   Estos comandos deben coincidir exactamente (case-sensitive) con los strings
 *   que el firmware del ESP32 espera recibir en el canal TCP.
 *   Si el firmware cambia un comando (ej: 'CUTENGINE' → 'ENGINE_CUT'), este array
 *   debe actualizarse simultáneamente.
 *
 * SENSIBILIDAD MPU6050 — 5 NIVELES:
 *   SENSITIVITY_VERY_LOW  (0) — mínima sensibilidad al acelerómetro
 *   SENSITIVITY_LOW       (1) — sensibilidad baja
 *   SENSITIVITY_MEDIUM    (2) — sensibilidad media (default)
 *   SENSITIVITY_HIGH      (3) — sensibilidad alta
 *   SENSITIVITY_VERY_HIGH (4) — máxima sensibilidad al acelerómetro
 *   Corresponden a BLE bytes 0x10-0x14 / NVS key "sensitivity" en el firmware.
 */
const VALID_COMMANDS = [
  'ARM',
  'DISARM',
  'SIREN_ON',         // Bocina de búsqueda: buzzer ON sin cambiar estado de la máquina
  'SIREN_OFF',        // Bocina de búsqueda: buzzer OFF sin cambiar estado
  'ENGINE_CUT',       // Corte de motor preventivo/silencioso — sin cambio de estado
  'ENGINE_RESTORE',   // Restaurar motor → STATE_IDLE (motor libre)
  'PURSUIT_CONFIRM',  // Robo confirmado → STATE_PURSUIT → GPS cada 10s (sin sirena ni corte de motor)
  'SENSITIVITY_VERY_LOW',
  'SENSITIVITY_LOW',
  'SENSITIVITY_MEDIUM',
  'SENSITIVITY_HIGH',
  'SENSITIVITY_VERY_HIGH',
  // Diagnóstico GT06 temporal — vibration alarm + status
  'SENALM_QUERY',
  'SENALM_ON',
  'SENALM_OFF',
  'STATUS_QUERY',
  'PARAM_QUERY',
  'DEFENSE_ON',
  'DEFENSE_OFF',
  'DEFENSE_QUERY',
];

/**
 * @brief Retorna el estado de conexión y la última posición conocida de un device.
 *
 * PROPÓSITO:
 *   Permite al dashboard del operador saber si un device está actualmente
 *   conectado al servidor TCP y cuál fue su última posición GPS registrada.
 *   Combina información en tiempo real (connectedDevices Map) con información
 *   histórica (MongoDB).
 *
 * FLUJO LÓGICO:
 *   1. Extraer deviceId del parámetro de URL.
 *   2. Verificar si el deviceId está en connectedDevices (conexión TCP activa).
 *   3. Consultar MongoDB para la última posición conocida (puede ser de una sesión anterior).
 *   4. Combinar y retornar ambas informaciones.
 *
 * CASOS DE RESPUESTA:
 *   - device conectado + datos en BD: { connected: true, lastSeen: Date, lat, lon, speed }
 *   - device offline + datos en BD:   { connected: false, lastSeen: Date, lat, lon, speed }
 *   - device desconocido (nunca conectado): { connected: false, lastSeen: null, lat: null, ... }
 *
 * DEPENDENCIAS:
 *   - Gps (models/Gps.js): para consultar la última posición.
 *   - connectedDevices (tcp/tcpServer.js): Map de sockets TCP activos.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Agregar caché (Redis con TTL de 30s) para este endpoint: si el dashboard
 *      tiene 100 operadores mirando el mismo device, cada request hace un findOne()
 *      innecesario cuando el dato no habrá cambiado en 30 segundos.
 *   2. Agregar 'batteryLevel' si el firmware lo envía en el payload TCP.
 *   3. Agregar 'firmwareVersion' si el device la envía en el handshake inicial.
 *   4. Distinguir entre "device desconocido" (404) y "device offline pero registrado" (200).
 *
 * @param {import('express').Request} req — Params: { deviceId: string }
 * @param {import('express').Response} res
 *   - 200: objeto con estado y última posición (incluso si todo es null)
 *   - 500: error de MongoDB
 * @returns {Promise<void>}
 */
const getDeviceStatus = async (req, res) => {
  const { deviceId } = req.params;
  try {
    // connectedDevices.has() es O(1) amortizado sobre el Map de sockets activos.
    // Es la fuente de verdad para "¿está conectado ahora mismo?".
    // Si el socket existía pero se destruyó, el handler 'close' de tcpServer.js
    // ya lo eliminó del Map, así que esta información es siempre precisa.
    // GT06 devices (J16 y clones) se rastrean en gt06OnlineImeis en lugar de connectedDevices
    const connected = connectedDevices.has(deviceId) || gt06OnlineImeis.has(deviceId);

    // Ejecutar las dos queries en paralelo: no tienen dependencia entre sí
    // y hacerlas secuenciales añadiría latencia innecesaria al endpoint.
    const [latest, state] = await Promise.all([
      Gps.findOne({ deviceId }).sort({ timestamp: -1 }),
      DeviceState.findOne({ deviceId }),
    ]);

    return res.status(200).json({
      deviceId,
      connected,
      armed: state?.armed ?? false,
      state: state?.state ?? 'STATE_IDLE',
      motorCut: state?.motorCut ?? false,
      lastSeen: latest?.timestamp ?? null,
      lat: latest?.lat ?? null,
      lon: latest?.lon ?? null,
      speed: latest?.speed ?? null,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Persiste un comando enviado como alerta de auditoría y actualiza DeviceState.
 *
 * PROPÓSITO:
 *   Registrar en MongoDB cada comando enviado desde la plataforma, creando un
 *   audit trail de quién envió qué y cuándo. También actualiza DeviceState.armed
 *   de forma optimista cuando el comando es ARM o DISARM, de modo que el endpoint
 *   GET /status refleje el nuevo estado antes de que el device lo confirme.
 *
 * FLUJO LÓGICO:
 *   1. Normalizar el tipo: 'ALERT' → 'ALERT_CMD' para evitar colisión con
 *      el tipo STATE_ALERT que usa el device (tienen semánticas distintas).
 *   2. Crear documento Alert con source='command'.
 *   3. Si es ARM o DISARM: upsert DeviceState con el nuevo valor de armed.
 *   4. Emitir 'alert:new' por Socket.io para notificar a las UIs en tiempo real.
 *
 * NOTA SOBRE OPTIMISTIC UPDATE:
 *   DeviceState.armed se actualiza aquí aunque el device todavía no ejecutó el
 *   comando. Si el device está offline, el estado en BD será "armado" pero el
 *   hardware seguirá desarmado hasta que reciba el CMD en la próxima reconexión.
 *   Cuando el device confirma con un frame EVENT|ARM o EVENT|DISARM, tcpServer.js
 *   vuelve a hacer upsert con el valor real (idempotente, mismo resultado).
 *   Este trade-off es aceptable: el usuario ve respuesta inmediata y el estado
 *   real se sincroniza cuando el device se conecta.
 *
 * @param {string} deviceId
 * @param {string} command — uno de VALID_COMMANDS
 * @returns {Promise<void>}
 */
/**
 * Mapa de niveles de sensibilidad para guardar en meta.
 * @type {Record<string, {level: number, label: string}>}
 */
const SENSITIVITY_META = {
  SENSITIVITY_VERY_LOW:  { level: 0, label: 'Muy baja' },
  SENSITIVITY_LOW:       { level: 1, label: 'Baja'     },
  SENSITIVITY_MEDIUM:    { level: 2, label: 'Media'    },
  SENSITIVITY_HIGH:      { level: 3, label: 'Alta'     },
  SENSITIVITY_VERY_HIGH: { level: 4, label: 'Muy alta' },
};

/**
 * @brief Persiste un comando enviado como alerta de auditoría y actualiza DeviceState.
 *
 * @param {string} deviceId
 * @param {string} command           — uno de VALID_COMMANDS
 * @param {object|null} actor        — { userId, userEmail, role, platform }
 * @param {object|null} extraMeta    — campos adicionales de contexto (ari, etc.)
 */
async function saveCommandAlert(deviceId, command, actor = null, extraMeta = null) {
  // Los comandos SENSITIVITY_* se unifican en un solo tipo con nivel en meta.
  const isSensitivity = command in SENSITIVITY_META;
  const alertType = isSensitivity ? 'SENSITIVITY_CHANGE' : command;

  const meta = isSensitivity
    ? { ...SENSITIVITY_META[command], ...extraMeta }
    : (extraMeta ?? undefined);

  const alert = await Alert.create({
    deviceId,
    type: alertType,
    source: 'command',
    actor: actor ?? undefined,
    meta: meta ?? undefined,
    lat: null,
    lon: null,
    timestamp: new Date(),
  });

  // Actualización optimista del estado para comandos que cambian el estado del device.
  // El device confirmará vía frame EVENT cuando ejecute el cambio.
  const stateUpdate = {};
  if (command === 'ARM')             stateUpdate.armed = true;
  if (command === 'DISARM')          { stateUpdate.armed = false; stateUpdate.state = 'STATE_IDLE'; stateUpdate.motorCut = false; }
  if (command === 'ENGINE_CUT')      stateUpdate.motorCut = true;   // corte preventivo — state permanece sin cambio
  if (command === 'ENGINE_RESTORE')  stateUpdate.motorCut = false;
  if (command === 'PURSUIT_CONFIRM') { stateUpdate.state = 'STATE_PURSUIT'; }  // motor/sirena NO se activan automáticamente (firmware June 23)

  if (Object.keys(stateUpdate).length > 0) {
    await DeviceState.findOneAndUpdate(
      { deviceId },
      { ...stateUpdate, updatedAt: new Date() },
      { upsert: true },
    );
  }

  // Notificar a clientes WebSocket para que las UIs reflejen el comando enviado
  // sin esperar al próximo poll del frontend.
  const io = getIo();
  if (io) io.emit('alert:new', alert.toObject());
}

/**
 * @brief Envía o encola un comando de control para un device ESP32.
 *
 * PROPÓSITO:
 *   Permite al operador (vía frontend o API) enviar comandos al hardware físico
 *   instalado en la moto. Si el device está online, el comando viaja por TCP
 *   inmediatamente. Si está offline, queda encolado en memoria hasta la próxima
 *   reconexión.
 *
 * FLUJO LÓGICO:
 *   1. Extraer deviceId de URL params y command del body.
 *   2. Validar que command esté en VALID_COMMANDS (whitelist).
 *   3. Llamar sendCommand(deviceId, command) de tcpServer.js.
 *   4. Si sendCommand retorna true (device en commandQueues):
 *      - Si el socket estaba activo → comando enviado inmediatamente → 200.
 *      - Si el socket estaba destruido → comando encolado → 202.
 *   5. Si sendCommand retorna false (device nunca se conectó) → 202 con aviso.
 *
 * NOTA SOBRE CÓDIGOS HTTP:
 *   - 200: comando entregado al device en este momento.
 *   - 202 Accepted: petición aceptada pero procesamiento diferido (device offline).
 *   - 400: comando inválido o ausente.
 *
 * NOTA SOBRE EL RETURN VALUE DE sendCommand():
 *   sendCommand() retorna true si el deviceId tiene una cola de comandos (fue registrado),
 *   independientemente de si el socket estaba activo. El campo 'delivered' en la respuesta
 *   indica si se entregó inmediatamente (basado en si el socket existía en connectedDevices).
 *   ARQUITECTURA ⚠️: la distinción "enviado ahora" vs "encolado" no es perfecta porque
 *   sendCommand() no retorna esa información directamente — el controller infiere si
 *   el device estaba online en el momento de llamar sendCommand.
 *
 * DEPENDENCIAS:
 *   - sendCommand (tcp/tcpServer.js): envía o encola el comando por TCP.
 *   - VALID_COMMANDS: whitelist de comandos aceptados.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Registrar cada comando enviado en MongoDB (audit log) con timestamp,
 *      operador que lo envió, y si fue entregado inmediatamente o encolado.
 *   2. Agregar autenticación: solo operadores autenticados pueden enviar ENGINE_CUT.
 *   3. Agregar rate limiting por operador para prevenir flood accidental de comandos.
 *   4. Retornar el número de comandos en la cola del device para que el frontend
 *      muestre cuántos comandos están pendientes de entrega.
 *
 * @param {import('express').Request} req
 *   Params: { deviceId: string }
 *   Body: { command: string } — debe estar en VALID_COMMANDS
 * @param {import('express').Response} res
 *   - 200: { message: 'Comando enviado', delivered: true }
 *   - 202: { message: 'Dispositivo offline. Comando encolado.', delivered: false }
 *   - 400: { message: 'Comando inválido. Válidos: [lista]' }
 * @returns {void} — No es async: sendCommand() es síncrono.
 */
const postCommand = (req, res) => {
  const { deviceId } = req.params;

  // req.body ?? {} previene TypeError si express.json() no pudo parsear el body.
  const { command } = req.body ?? {};

  // Validación de whitelist: rechaza comandos no reconocidos antes de tocar el socket.
  // Sin esta validación, un atacante podría enviar strings arbitrarios al firmware.
  if (!command || !VALID_COMMANDS.includes(command)) {
    return res.status(400).json({
      message: `Comando inválido. Válidos: ${VALID_COMMANDS.join(', ')}`,
    });
  }

  // Intentar el path ESP32 primero (commandQueues de tcpServer).
  // Si el deviceId nunca se conectó como ESP32, intentar el path GT06.
  // Para GT06: ENGINE_CUT → DYD,000000# / ENGINE_RESTORE → HFYD,000000# (frame binario 0x80).
  // ARM/DISARM/SIREN_*/SENSITIVITY_* en GT06 son comandos "lógicos" — solo DeviceState.
  let delivered = sendCommand(deviceId, command);
  if (!delivered) delivered = sendGt06Command(deviceId, command);

  // Construir el actor desde el JWT: quién envió el comando, desde qué plataforma.
  // req.body.platform es opcional — el frontend puede informar 'app' o 'web'.
  const actor = req.user ? {
    userId:    req.user.sub,
    userEmail: req.user.email,
    role:      req.user.role,
    platform:  req.body.platform ?? null,
  } : null;

  saveCommandAlert(deviceId, command, actor).catch(() => {});

  if (delivered) {
    return res.status(200).json({ message: 'Comando enviado', delivered: true });
  }

  // sendCommand() retornó false: el device nunca se conectó en esta sesión del servidor.
  // El comando NO fue encolado porque commandQueues no tiene entrada para este deviceId.
  // 202 Accepted: la petición es válida pero no hay garantía de entrega.
  return res.status(202).json({
    message: 'Dispositivo offline. Comando encolado.',
    delivered: false,
  });
};

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
module.exports = { getDeviceStatus, postCommand };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — controllers/deviceController.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este controlador permite al operador (la persona en el dashboard) hacer dos
   cosas: saber si una moto está conectada ahora mismo y dónde estaba la última
   vez (status), y enviar órdenes al dispositivo GPS instalado en la moto
   (command). Si la moto está en zona sin señal cuando se envía una orden, el
   sistema la guarda y se la manda en cuanto la moto vuelva a conectarse.

   PSEUDOCÓDIGO:
   getDeviceStatus(deviceId):
     → connected = connectedDevices.has(deviceId)
     → latest = Gps.findOne({ deviceId }).sort(-timestamp)
     → return { connected, lastSeen, lat, lon, speed }

   postCommand(deviceId, command):
     → si command no en VALID_COMMANDS → 400
     → delivered = sendCommand(deviceId, command)
     → si delivered → 200 "Comando enviado"
     → si !delivered → 202 "Comando encolado"

   DIAGRAMA MENTAL:
   Operador (frontend) → POST /api/device/:id/command
                                ↓
                         postCommand()
                                ↓
                         sendCommand() [tcpServer.js]
                                ↓
              device online → TCP socket → ESP32 ejecuta
              device offline → commandQueues → próxima reconexión

   VARIABLES CRÍTICAS:
   - VALID_COMMANDS: lista de comandos aceptados — debe sincronizarse con firmware
   - connectedDevices: importado de tcpServer.js — fuente de verdad del estado de conexión

   RIESGOS DE SEGURIDAD:
   - Sin autenticación: cualquiera puede enviar ENGINE_CUT a cualquier device
   - Sin logging estructurado: los comandos enviados no quedan en audit log
   - postCommand() no es async — si sendCommand() fuera async en el futuro, hay que actualizar

   RIESGOS DE CONCURRENCIA:
   - sendCommand() es síncrono y opera sobre Maps del event loop single-threaded de Node.js.
     No hay riesgos de concurrencia reales en la arquitectura actual.
   - Con cluster mode, connectedDevices sería local a cada proceso y los comandos
     del operador podrían ir al proceso equivocado (sin el device conectado).

   ═══════════════════════════════════════════════════════════ */
