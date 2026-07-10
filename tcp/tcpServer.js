/**
 * @fileoverview Servidor TCP de Argus Secure para recibir paquetes del ESP32.
 *
 * Este módulo implementa el canal de comunicación de baja latencia entre
 * el hardware (ESP32 + módulo SIM A7670) y el backend. A diferencia de
 * HTTP, TCP permite mantener una conexión persistente, lo que elimina el
 * overhead de handshake TLS en cada envío y permite que el servidor empuje
 * comandos al device sin que el device tenga que hacer polling.
 *
 * El protocolo de wire es texto plano delimitado por newlines:
 *   Device → Server: "ARGUS|device_id|timestamp_ms|lat|lng|crc32_hex\n"
 *   Server → Device: "ACK\r\n" (dato aceptado)
 *   Server → Device: "ERR\r\n" (dato rechazado)
 *   Server → Device: "CMD|accion\n" (comando del operador)
 *
 * @module tcp/tcpServer
 */

'use strict';

const net = require('net'); // Módulo nativo de Node.js para sockets TCP crudos
const tls = require('tls'); // TLS sobre TCP — mismo API de socket, canal cifrado
const fs  = require('fs');  // Leer certificados del disco al arrancar
const { log } = require('./logger');
const { isAllowed, verifySignature } = require('./deviceAuth');
const { enqueue } = require('./queue');
const { checkRiskZone } = require('./riskMonitor');       // ARI: vigilancia reforzada automática
const { checkGeofence } = require('./geofenceMonitor');   // Geocerca: detecta salida de zona
const Alert = require('../models/Alert');
const DeviceState = require('../models/DeviceState');
const DriveMetrics = require('../models/DriveMetrics');
const { sendAlarmPush } = require('../services/pushService');

// ─── CONSTANTES DE CONFIGURACIÓN ─────────────────────────────────────────────

/**
 * Puerto TCP en el que escucha el servidor para conexiones del ESP32.
 *
 * En GCP se abre una regla de firewall VPC para este puerto.
 * El fallback a 80 permite que en entornos sin root (Cloud Run) el proceso
 * no necesite privilegios especiales, pero es confuso porque 80 es HTTP.
 *
 * ARQUITECTURA ⚠️: Puerto 80 como fallback para TCP IoT
 *   CÓMO LO HARÍA UN SENIOR: usar TCP_PORT=9000 como default explícito en
 *   el .env.example para que nunca haya ambigüedad con el puerto HTTP.
 *   IMPACTO ACTUAL: en un despliegue descuidado, nginx y el servidor TCP
 *   podrían competir por el puerto 80.
 */
const TCP_PORT     = parseInt(process.env.TCP_PORT     || '80',   10);

/**
 * Puerto TLS del servidor TCP. El firmware con TCP_USE_TLS=1 se conecta aquí.
 * El puerto TCP_PORT (9000) sigue activo en paralelo para rollback inmediato:
 * si el TLS falla, basta con flashear TCP_USE_TLS=0 en el firmware.
 */
const TCP_TLS_PORT = parseInt(process.env.TCP_TLS_PORT || '9001', 10);

/** Paths a los archivos de certificado generados con scripts/gen-tls-cert.js */
const TLS_KEY_PATH  = process.env.TLS_KEY_PATH  || './certs/key.pem';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || './certs/cert.pem';

/**
 * Milisegundos sin datos tras los cuales el servidor cierra la conexión.
 *
 * En modo activo el ESP32 envía cada 30s. En inactividad (>5 min quieto),
 * el firmware pausa la telemetría GPS y envía un keepalive cada 5 minutos.
 * 10 minutos da margen sobre ese keepalive sin dejar sockets zombi demasiado
 * tiempo en caso de pérdida de señal real.
 */
const INACTIVITY_TIMEOUT_MS = 600_000;

/**
 * Intervalo mínimo en ms entre dos paquetes aceptados del mismo device.
 *
 * Previene que un device (o un atacante que conoce el protocolo) sature
 * el sistema con paquetes a alta frecuencia. 5 segundos es generoso para
 * el caso de uso normal (posición cada 30s) pero corta ataques de flood.
 * Si el device envía más rápido, recibe ERR y el paquete se descarta.
 */
const RATE_LIMIT_MS = 5_000;

/**
 * Antigüedad máxima en ms que se acepta en el timestamp de un paquete.
 *
 * Protege contra replay attacks: si un atacante captura un paquete válido
 * (firma CRC32 correcta) y lo reenvía horas después, el servidor lo rechaza
 * porque su timestamp es demasiado viejo. 60 segundos da margen para
 * variaciones de reloj entre el ESP32 (sincroniza por GNSS) y el servidor.
 *
 * Los keepalives (timestamp=0) están exentos de este check.
 */
const MAX_PACKET_AGE_MS = 60_000;

// ─── ESTADO GLOBAL DEL SERVIDOR TCP ──────────────────────────────────────────

/**
 * Mapa de conexiones TCP activas indexadas por deviceId.
 *
 * @type {Map<string, import('net').Socket>}
 *
 * PROPÓSITO: permite que deviceController.js envíe comandos inmediatamente
 * al socket del device sin esperar al próximo paquete entrante.
 *
 * RIESGO DE CONCURRENCIA: si el mismo deviceId se conecta dos veces (por
 * ejemplo por un reconect rápido antes de que el server detecte el close),
 * el segundo socket sobreescribe el primero en el Map. El primer socket
 * queda "huérfano" hasta que su timeout lo destruya. En ese lapso, comandos
 * enviados al Map se irían al socket nuevo, que es el comportamiento correcto.
 */
const connectedDevices = new Map();

/**
 * Último comando enviado por flushCommands() pero aún no confirmado por el device.
 *
 * @type {Map<string, string>} — Map<deviceId, comando>
 *
 * PROPÓSITO: cuando flushCommands() hace q.shift() + socket.write(), el comando
 * se pierde si el socket muere antes de que el device lo reciba. Este Map retiene
 * el comando hasta que el device envía su próximo paquete (confirma implícitamente
 * que el socket estaba vivo). En el evento 'close', si el deviceId tiene entrada
 * aquí, el comando se re-inserta al frente de commandQueues para reintento.
 */
const lastSentCommands = new Map();

/**
 * Cola de comandos pendientes por device, indexada por deviceId.
 *
 * @type {Map<string, string[]>}
 *
 * PROPÓSITO: cuando un operador envía un comando vía REST y el device está
 * offline, el comando se guarda aquí. En cuanto el device se reconecte y
 * envíe su próximo paquete válido, flushCommands() extrae y envía el comando.
 *
 * RIESGO: los comandos aquí son volátiles (solo en memoria RAM). Si el
 * proceso Node.js se reinicia, los comandos pendientes se pierden.
 * MEJORA: persistir commandQueues en Redis con TTL.
 */
const commandQueues = new Map();

/**
 * Timestamp del último paquete aceptado por device, para rate limiting.
 *
 * @type {Map<string, number>} — Map<deviceId, epoch_ms>
 *
 * PROPÓSITO: evitar que un device o atacante envíe paquetes a frecuencia
 * mayor que RATE_LIMIT_MS, lo que inflaría MongoDB y la CPU del worker.
 *
 * RIESGO: al igual que commandQueues, es volátil. Un reinicio del servidor
 * resetea todos los rate limits, pero dado que es una medida de protección
 * de recursos y no de seguridad crítica, el impacto es bajo.
 */
const lastSeen = new Map();

// ─── FUNCIONES UTILITARIAS ────────────────────────────────────────────────────

/**
 * @brief Parsea una línea de texto del protocolo Argus y extrae sus campos.
 *
 * PROPÓSITO:
 *   Valida la estructura sintáctica del frame antes de cualquier validación
 *   semántica (auth, rate limit, coordenadas). Si el frame no tiene exactamente
 *   6 campos separados por '|' y el primero es 'ARGUS', retorna null para que
 *   el caller descarte el paquete y responda ERR.
 *
 * FLUJO LÓGICO:
 *   1. Eliminar whitespace del extremo de la línea (trim)
 *   2. Dividir por '|' y verificar que haya exactamente 6 partes
 *   3. Verificar que el primer campo sea 'ARGUS' (magic byte del protocolo)
 *   4. Destructurar los campos y verificar que ninguno sea vacío/undefined
 *   5. Convertir lat y lng a Number con parseFloat
 *   6. Retornar el objeto de paquete o null si algo falla
 *
 * DEPENDENCIAS:
 *   - Ninguna dependencia externa; función pura.
 *
 * POSIBLES MEJORAS (senior):
 *   - Validar que timestamp sea un número entero positivo aquí mismo.
 *   - Retornar un objeto { ok, error, packet } en lugar de null para
 *     poder incluir el motivo del fallo en el log.
 *   - Soportar versiones del protocolo: si parts[0] === 'ARGUS2', aplicar
 *     otro parser sin romper retrocompatibilidad.
 *
 * @param {string} line — Una línea completa del stream TCP (sin el \n final)
 * @returns {{ deviceId: string, timestamp: string, lat: number, lng: number, signature: string } | null}
 *   El objeto de paquete si la línea es válida, o null si el frame está malformado.
 */
function parsePacket(line) {
  const parts = line.trim().split('|');

  // Frame v2: 7 campos — ARGUS|deviceId|timestamp|lat|lng|speed_kmh|crc32.
  // speed está entre lng y la firma; no forma parte del CRC (es telemetría de display).
  if (parts.length !== 7 || parts[0] !== 'ARGUS') return null;

  const [, deviceId, timestamp, lat, lng, speed, signature] = parts;

  // speed puede ser "0.0" (moto detenida) — falsy como número pero válido.
  // Solo validamos que los campos requeridos para la firma existan.
  if (!deviceId || !timestamp || !lat || !lng || !signature) return null;

  return {
    deviceId,
    timestamp,
    lat:       parseFloat(lat),
    lng:       parseFloat(lng),
    speed:     parseFloat(speed) || 0,
    signature,
  };
}

/**
 * @brief Envía el siguiente comando pendiente de la cola del device al socket.
 *
 * PROPÓSITO:
 *   Implementa el mecanismo "piggybacking" de comandos: el servidor espera
 *   a que el device envíe un paquete válido (ACK loop) para despachar el
 *   comando inmediatamente después. Esto evita tener que abrir una conexión
 *   inversa (imposible con NAT/CGNAT de las redes móviles) y asegura que
 *   el device esté escuchando cuando llega el CMD.
 *
 * FLUJO LÓGICO:
 *   1. Obtener la cola del device del Map commandQueues.
 *   2. Si no existe o está vacía, retornar sin hacer nada.
 *   3. Extraer el primer comando con shift() — política FIFO.
 *   4. Escribir "CMD|{cmd}\n" al socket.
 *   5. Registrar el evento en el log.
 *
 * DEPENDENCIAS:
 *   - commandQueues: Map<deviceId, string[]> definido en este módulo.
 *   - log: logger estructurado JSON.
 *
 * POSIBLES MEJORAS (senior):
 *   - En lugar de shift() (que muta el array), usar una implementación de
 *     cola circular para evitar el O(n) de reindexación del array nativo.
 *   - Agregar retry: si socket.write() retorna false (backpressure), reinsertar
 *     el comando al frente de la cola y esperar el evento 'drain'.
 *   - Implementar confirmación: el device podría responder "CMDACK|{cmd}" y
 *     solo entonces eliminar el comando de la cola (at-least-once delivery).
 *
 * @param {import('net').Socket} socket — Socket TCP activo del device.
 * @param {string} deviceId — Identificador del device (ej: "ESP32-001").
 * @returns {void}
 */
function flushCommands(socket, deviceId) {
  const q = commandQueues.get(deviceId);

  // Si no hay cola o está vacía no hay nada que hacer.
  // Este check previene el error "Cannot read properties of undefined"
  // si flushCommands se llama antes de que el device haya sido registrado.
  if (!q || q.length === 0) return;

  // shift() extrae el primer elemento del array, implementando FIFO.
  // Los comandos se ejecutan en el orden en que los encoló el operador.
  // Solo se envía UN comando por paquete recibido para no saturar el
  // buffer del ESP32 (que es limitado en RAM).
  const cmd = q.shift();

  // Guardar en lastSentCommands ANTES de escribir al socket.
  // Si el socket muere antes de que el device confirme recepción (próximo paquete),
  // el handler 'close' re-insertará este comando al frente de la cola.
  lastSentCommands.set(deviceId, cmd);

  // El formato CMD|accion\n es el protocolo Argus para comandos.
  // El ESP32 espera este prefijo para distinguir un comando de un ACK.
  // Nota: se usa \n (no \r\n) para los comandos; el ESP32 hace trim() en su parser.
  socket.write(`CMD|${cmd}\n`);
  log('info', 'tcp.cmd.sent', { deviceId, cmd });
}

// ─── REFERENCIA GLOBAL A SOCKET.IO ───────────────────────────────────────────

/**
 * Referencia a la instancia de Socket.io, guardada al llamar startTcpServer(io).
 *
 * PROPÓSITO: permite que deviceController.js emita eventos WebSocket cuando
 * envía un comando (ARM, DISARM, etc.) sin acceder a server.js directamente,
 * lo que crearía una dependencia circular (server.js → routes → controller → server.js).
 * Al exponer getIo() desde este módulo se rompe el ciclo: el controller ya importa
 * tcpServer.js para sendCommand(), así que añadir getIo() no agrega dependencias nuevas.
 *
 * @type {import('socket.io').Server | null}
 */
let ioRef = null;

// ─── PARSER DE FRAMES EVENT ───────────────────────────────────────────────────

/**
 * Tipos de evento válidos que el ESP32 puede reportar en un frame EVENT.
 *
 * SINCRONIZACIÓN CON FIRMWARE: si el firmware agrega un nuevo tipo de evento
 * (ej: STATE_LOW_BATTERY), debe añadirse aquí simultáneamente o los frames
 * de ese tipo serán rechazados con ERR y el evento se perderá.
 */
const VALID_EVENT_TYPES = new Set([
  'STATE_ALERT',
  'STATE_PURSUIT',
  'STATE_MOVING',
  'STATE_IDLE',
  'ARM',
  'DISARM',
]);

/**
 * @brief Parsea una línea del protocolo Argus con formato EVENT y extrae sus campos.
 *
 * PROPÓSITO:
 *   Validar la estructura sintáctica de un frame de evento antes de cualquier
 *   validación semántica (auth, firma). El frame EVENT es análogo al frame ARGUS
 *   GPS pero incluye un campo 'type' que indica qué cambio de estado reporta el device.
 *
 * FORMATO DEL FRAME:
 *   "EVENT|device_id|type|timestamp_ms|lat|lon|crc32\n"
 *   Campos:  [0]    [1]   [2]  [3]        [4] [5]  [6]
 *
 * FIRMA CRC32:
 *   El CRC32 se calcula sobre el mismo payload que para los frames GPS:
 *   "{deviceId}|{timestamp}|{lat:.6f}|{lon:.6f}|{SECRET}"
 *   El campo 'type' NO está en el CRC. Esto es aceptable porque el device ya
 *   está autenticado por whitelist + firma; si llegara a forjarse el tipo
 *   de evento, el device estaría auto-reportando un estado falso de sí mismo,
 *   lo que no tiene sentido de seguridad en este modelo de amenazas.
 *
 * FLUJO LÓGICO:
 *   1. Split por '|' → verificar exactamente 7 partes y prefijo 'EVENT'.
 *   2. Verificar que ningún campo esté vacío.
 *   3. Verificar que 'type' esté en VALID_EVENT_TYPES.
 *   4. Convertir lat y lon a Number con parseFloat.
 *   5. Retornar objeto de evento o null si algo falla.
 *
 * DEPENDENCIAS:
 *   - VALID_EVENT_TYPES: Set de tipos conocidos.
 *
 * @param {string} line — Línea completa del stream TCP (sin el \n final).
 * @returns {{ deviceId: string, type: string, timestamp: string, lat: number, lon: number, signature: string } | null}
 */
function parseEventPacket(line) {
  const parts = line.trim().split('|');

  // 7 campos: EVENT, deviceId, type, timestamp, lat, lon, signature.
  // Con 6 o 8 campos el frame está malformado.
  if (parts.length !== 7 || parts[0] !== 'EVENT') return null;

  const [, deviceId, type, timestamp, lat, lon, signature] = parts;

  // Cualquier campo vacío indica un frame truncado.
  if (!deviceId || !type || !timestamp || !lat || !lon || !signature) return null;

  // Rechazar tipos desconocidos aquí, antes de gastar CPU en auth/CRC.
  // Si el firmware envía un tipo no registrado, el caller logueará y responderá ERR.
  if (!VALID_EVENT_TYPES.has(type)) return null;

  return {
    deviceId,
    type,
    timestamp,
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    signature,
  };
}

// ─── PARSER DE FRAMES DRIVE ───────────────────────────────────────────────────

/**
 * @brief Parsea una línea del protocolo Argus con formato DRIVE y extrae sus campos.
 *
 * PROPÓSITO:
 *   Validar la estructura sintáctica de un frame de métricas de conducción antes
 *   de cualquier validación semántica (auth, firma). El frame DRIVE transporta las
 *   métricas acumuladas por el MPU6050 durante la ventana GPS (~30s en PREMIUM).
 *
 * FORMATO DEL FRAME:
 *   "DRIVE|device_id|epoch_ms|lat|lon|peakAccelDev|peakGyroMag|hardCount|softCount|crc32\n"
 *   Campos:  [0]    [1]       [2]  [3] [4]    [5]          [6]       [7]       [8]    [9]
 *
 * FIRMA CRC32:
 *   El CRC32 se calcula con el mismo payload base que los frames ARGUS y EVENT:
 *   "{deviceId}|{epoch}|{lat:.6f}|{lon:.6f}|{SECRET}"
 *   Los campos de métricas (peakAccelDev, etc.) NO están en el CRC por diseño del
 *   firmware (buildDriveFrame usa el mismo signatureBase que buildArgusPacket).
 *   Esto es aceptable: la autenticidad del device está garantizada por la firma;
 *   la integridad de las métricas depende de que el device sea legítimo.
 *
 * FLUJO LÓGICO:
 *   1. Split por '|' → verificar exactamente 10 partes y prefijo 'DRIVE'.
 *   2. Verificar que ningún campo esté vacío.
 *   3. Convertir campos numéricos.
 *   4. Retornar objeto o null si algo falla.
 *
 * @param {string} line — Línea completa del stream TCP (sin el \n final).
 * @returns {{ deviceId, timestamp, lat, lon, peakAccelDev, peakGyroMag, hardCount, softCount, signature } | null}
 */
function parseDrivePacket(line) {
  const parts = line.trim().split('|');

  // Frame v1 (legado): 10 campos — DRIVE|id|epoch|lat|lon|accel|gyro|hard|soft|crc32
  // Frame v2: 12 campos — añade avgSpeedKmh y distanceM antes del crc32
  // Frame v3 (actual): 14 campos — añade maxSpeedKmh y stoppedSec antes del crc32
  const isV2 = parts.length === 12;
  const isV3 = parts.length === 14;
  if ((parts.length !== 10 && !isV2 && !isV3) || parts[0] !== 'DRIVE') return null;

  const [, deviceId, timestamp, lat, lon, peakAccelDev, peakGyroMag, hardCount, softCount] = parts;
  const avgSpeedKmh = (isV2 || isV3) ? parts[9]  : null;
  const distanceM   = (isV2 || isV3) ? parts[10] : null;
  const maxSpeedKmh = isV3           ? parts[11] : null;
  const stoppedSec  = isV3           ? parts[12] : null;
  const signature   = isV3 ? parts[13] : isV2 ? parts[11] : parts[9];

  if (!deviceId || !timestamp || !lat || !lon || !peakAccelDev || !peakGyroMag
    || hardCount === '' || softCount === '' || !signature) return null;

  return {
    deviceId,
    timestamp,
    lat:          parseFloat(lat),
    lon:          parseFloat(lon),
    peakAccelDev: parseFloat(peakAccelDev),
    peakGyroMag:  parseFloat(peakGyroMag),
    hardCount:    parseInt(hardCount, 10),
    softCount:    parseInt(softCount, 10),
    avgSpeedKmh:  avgSpeedKmh !== null ? parseFloat(avgSpeedKmh) : null,
    distanceM:    distanceM   !== null ? parseFloat(distanceM)   : null,
    maxSpeedKmh:  maxSpeedKmh !== null ? parseFloat(maxSpeedKmh) : null,
    stoppedSec:   stoppedSec  !== null ? parseInt(stoppedSec, 10) : null,
    signature,
  };
}

/**
 * @brief Persiste métricas de conducción en MongoDB (fire-and-forget).
 *
 * PROPÓSITO:
 *   Encapsular el guardado async de DriveMetrics de forma que pueda llamarse
 *   desde el handler TCP síncrono sin bloquear el event loop ni retrasar el ACK.
 *   Mismo patrón que persistAlert(): se llama con .catch() para atrapar errores
 *   sin generar UnhandledPromiseRejection.
 *
 * POR QUÉ NO SE AWAITA:
 *   El ESP32 espera el ACK en milisegundos. MongoDB puede tardar 50-300ms.
 *   Si esperáramos, el módulo SIM podría dar timeout y reenviar el frame,
 *   generando documentos duplicados.
 *
 * DEPENDENCIAS:
 *   - DriveMetrics (models/DriveMetrics.js)
 *   - log: logger estructurado
 *
 * @param {object} data
 * @param {string} data.deviceId
 * @param {number|null} data.lat
 * @param {number|null} data.lon
 * @param {number} data.peakAccelDev
 * @param {number} data.peakGyroMag
 * @param {number} data.hardCount
 * @param {number} data.softCount
 * @param {Date}   data.timestamp
 * @returns {Promise<void>}
 */
async function persistDriveMetrics({ deviceId, lat, lon, peakAccelDev, peakGyroMag, hardCount, softCount, avgSpeedKmh, distanceM, maxSpeedKmh, stoppedSec, timestamp }) {
  await DriveMetrics.create({ deviceId, lat, lon, peakAccelDev, peakGyroMag, hardCount, softCount, avgSpeedKmh, distanceM, maxSpeedKmh, stoppedSec, timestamp });
}

/**
 * @brief Persiste una alerta en MongoDB y emite el evento WebSocket alert:new.
 *
 * PROPÓSITO:
 *   Encapsular el guardado async de alertas de forma que pueda llamarse desde
 *   el handler síncrono de datos TCP sin bloquear el event loop ni retrasar el ACK.
 *   Se llama con .catch() para que los errores de MongoDB no generen
 *   UnhandledPromiseRejection sin interrumpir el procesamiento del paquete.
 *
 * FLUJO LÓGICO:
 *   1. Crear el documento Alert en MongoDB.
 *   2. Si el tipo es ARM o DISARM, actualizar (upsert) DeviceState.armed.
 *   3. Emitir 'alert:new' por Socket.io a todos los clientes conectados.
 *
 * POR QUÉ NO SE AWAITA EN EL CALLER:
 *   El handler 'data' de TCP debe responder ACK al ESP32 en microsegundos.
 *   Insertar en MongoDB puede tardar 50-300ms. Si esperáramos, el ESP32
 *   podría dar timeout esperando el ACK y reintentar el envío, generando
 *   alertas duplicadas. Fire-and-forget con .catch() es el patrón correcto.
 *
 * DEPENDENCIAS:
 *   - Alert (models/Alert.js)
 *   - DeviceState (models/DeviceState.js)
 *   - ioRef: referencia al servidor Socket.io
 *   - log: logger estructurado
 *
 * @param {object} data
 * @param {string} data.deviceId
 * @param {string} data.type         — tipo de evento (VALID_EVENT_TYPES)
 * @param {string} data.source       — 'device'
 * @param {number|null} data.lat
 * @param {number|null} data.lon
 * @param {Date}   data.timestamp
 * @returns {Promise<void>}
 */
async function persistAlert({ deviceId, type, source, lat, lon, timestamp }) {
  // Guardar el evento en MongoDB como registro permanente.
  const alert = await Alert.create({ deviceId, type, source, lat, lon, timestamp });

  // Los eventos ARM/DISARM son la fuente de verdad del estado del device.
  // Actualizar DeviceState aquí es la confirmación real de que el hardware ejecutó el cambio.
  // Los eventos STATE_* también actualizan el campo state para que los frontends
  // puedan derivar si el motor está cortado (STATE_PURSUIT) sin otra consulta.
  const stateUpdate = {};
  if (type === 'ARM')    stateUpdate.armed = true;
  if (type === 'DISARM') { stateUpdate.armed = false; stateUpdate.state = 'STATE_IDLE'; }
  if (type === 'STATE_IDLE')    stateUpdate.state = 'STATE_IDLE';
  if (type === 'STATE_MOVING')  stateUpdate.state = 'STATE_MOVING';
  if (type === 'STATE_ALERT')   stateUpdate.state = 'STATE_ALERT';
  if (type === 'STATE_PURSUIT') stateUpdate.state = 'STATE_PURSUIT';

  if (Object.keys(stateUpdate).length > 0) {
    await DeviceState.findOneAndUpdate(
      { deviceId },
      { ...stateUpdate, updatedAt: new Date() },
      { upsert: true },
    );
  }

  // Solo notifica al room del device dueño de la alerta.
  // El cliente se une a device:${deviceId} al conectar (server.js, handshake query).
  if (ioRef) ioRef.to(`device:${deviceId}`).emit('alert:new', alert.toObject());

  // Push notification al dueño — solo para alarma física (vibración MPU6050).
  // Fire-and-forget: si falla no afecta el flujo TCP ni el ACK al ESP32.
  if (type === 'STATE_ALERT') {
    sendAlarmPush(deviceId, lat, lon).catch((err) =>
      log('error', 'push.alarm_error', { deviceId, err: err.message }),
    );
  }
}

// ─── FÁBRICA DEL SERVIDOR TCP ─────────────────────────────────────────────────

/**
 * @brief Crea y configura el servidor TCP net.Server con toda la lógica de protocolo.
 *
 * PROPÓSITO:
 *   Centraliza la creación del servidor TCP y su pipeline de procesamiento de
 *   paquetes. Separar esta función de startTcpServer() permite testar la lógica
 *   del servidor sin tener que hacer .listen() en un puerto real.
 *
 * FLUJO LÓGICO:
 *   1. net.createServer() crea un servidor TCP; el callback se llama por cada nueva conexión.
 *   2. Para cada conexión: configurar timeout e keepalive.
 *   3. En el evento 'data': acumular en buffer, dividir por newlines, procesar cada línea.
 *   4. Por cada línea: parsear → auth → rate limit → registrar device → validar coords → encolar.
 *   5. En el evento 'timeout': destruir el socket.
 *   6. En el evento 'close': limpiar connectedDevices.
 *   7. En el evento 'error': loguear (cleanup lo hace 'close').
 *
 * DEPENDENCIAS:
 *   - net (nativo Node.js)
 *   - log (./logger)
 *   - isAllowed, verifySignature (./deviceAuth)
 *   - enqueue (./queue)
 *   - connectedDevices, commandQueues, lastSeen (maps de este módulo)
 *   - io (socket.io Server) — inyectado como parámetro para evitar dependencia circular
 *
 * POSIBLES MEJORAS (senior):
 *   - Implementar TLS (net.createServer → tls.createServer) para cifrar el canal.
 *     Actualmente las coordenadas GPS viajan en texto plano por internet.
 *   - Agregar un Map de IP con contadores de intentos para bloquear IPs que
 *     generan muchos ERR (fail2ban a nivel de aplicación).
 *   - Limitar el tamaño del buffer (ej: si buffer > 1KB sin \n, destruir socket)
 *     para prevenir ataques de memory exhaustion.
 *
 * @param {import('socket.io').Server} io — Instancia de Socket.io para push al frontend.
 * @returns {(socket: import('net').Socket) => void} — Handler reutilizable para net.Server y tls.Server.
 */
function _makeSocketHandler(io) {
  return (socket) => {
    // Dirección IP y puerto efímero del cliente (el ESP32).
    // Útil para logs de diagnóstico y para correlacionar eventos de red con eventos de protocolo.
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log('info', 'tcp.connect', { remote });

    // Configura el timeout de inactividad. Tras INACTIVITY_TIMEOUT_MS sin datos,
    // el socket emite el evento 'timeout'. SIN esto, un ESP32 que deja de enviar
    // (se apaga, pierde señal) mantendría el file descriptor abierto indefinidamente,
    // agotando los recursos del proceso a lo largo del tiempo.
    socket.setTimeout(INACTIVITY_TIMEOUT_MS);

    // keepAlive envía sondas TCP vacías para detectar conexiones muertas y para
    // mantener viva la sesión TLS ante el idle-timeout del carrier móvil (Tigo ~20s).
    // initialDelay=10 000 ms: primera sonda a los 10s de inactividad, antes de que
    // Tigo cierre el socket. Sin esto, el socket persiste solo mientras el ESP32
    // envíe datos; en indoor sin GPS fix puede haber >20s de silencio → RST del carrier.
    socket.setKeepAlive && socket.setKeepAlive(true, 10000);

    // Buffer acumulador de datos parciales.
    // TCP es un protocolo de stream, no de mensajes. Un chunk puede contener
    // un mensaje completo, uno parcial, o varios mensajes concatenados.
    // Este buffer acumula bytes hasta encontrar el delimitador \n.
    let buffer = '';

    // deviceId se establece DESPUÉS de que el primer paquete pasa auth y rate-limit.
    // Mientras sea null, el socket es anónimo. Esto es importante para el evento
    // 'close': solo limpiamos connectedDevices si el device llegó a autenticarse.
    let deviceId = null;

    // Contador de intentos de autenticación fallidos en esta conexión.
    // Después de MAX_FAILED_AUTH fallos, se destruye el socket para prevenir
    // fuerza bruta sobre deviceIds o firmas.
    let failedAuthAttempts = 0;
    const MAX_FAILED_AUTH = 3;

    // ── EVENTO: datos entrantes ──────────────────────────────────────────────
    socket.on('data', async (chunk) => {
      // Log de bytes crudos para diagnóstico de protocolo.
      // El hex permite ver caracteres no imprimibles (\r, \0, etc.) que podrían
      // confundir el parser. En producción esto puede ser muy verboso;
      // idealmente se controla con una variable de entorno LOG_LEVEL=debug.
      try {
        log('debug', 'tcp.raw', {
          remote,
          rawHex: chunk.toString('hex'),
          rawUtf8: chunk.toString('utf8'),
        });
      } catch (e) {
        // Un error al loguear nunca debe interrumpir el procesamiento del paquete.
        // Por eso el try/catch solo rodea el log, no el procesamiento.
      }

      // Acumular el chunk en el buffer de líneas.
      // chunk.toString('utf8') puede fallar con bytes inválidos en UTF-8 pero
      // Node.js reemplaza secuencias inválidas con el carácter de reemplazo U+FFFD,
      // lo que causará que el parsePacket() falle en la validación de firma (correcto).
      buffer += chunk.toString('utf8');

      // Dividir por \r\n o \n para manejar tanto Unix como Windows line endings.
      // El ESP32 termina sus líneas con \n; el \r opcional es por robustez.
      const lines = buffer.split(/\r?\n/);

      // El último elemento tras split() es el fragmento de línea incompleto
      // (o "" si el chunk terminó exactamente en \n). Lo devolvemos al buffer
      // para que se concatene con el próximo chunk.
      // Si no hiciéramos esto, perderíamos la parte final de frames fragmentados.
      buffer = lines.pop();

      // Procesar cada línea completa encontrada en este chunk.
      for (const line of lines) {
        // Ignorar líneas vacías (por \r\n\r\n o keepalive del device).
        if (!line || !line.trim()) continue;

        // ── DETECCIÓN DE TIPO DE FRAME ────────────────────────────────────
        // El protocolo Argus tiene dos tipos de frame:
        //   ARGUS|... → posición GPS periódica
        //   EVENT|... → cambio de estado de seguridad reportado por el device
        // La detección por prefijo es O(1) y evita parsear el frame completo
        // antes de saber qué parser aplicar.
        if (line.startsWith('EVENT|')) {
          // ── FRAME DE EVENTO: STATE_ALERT, ARM, DISARM, etc. ──────────────

          const event = parseEventPacket(line);
          if (!event) {
            log('warn', 'tcp.event.malformed', { remote, raw: line.slice(0, 120) });
            socket.write('ERR\r\n');
            continue;
          }

          // Mismas validaciones de auth que para frames GPS.
          if (!(await isAllowed(event.deviceId))) {
            log('warn', 'tcp.auth.unknown_device', { deviceId: event.deviceId, remote });
            failedAuthAttempts += 1;
            socket.write('ERR\r\n');
            if (failedAuthAttempts >= MAX_FAILED_AUTH) {
              log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
              socket.destroy();
              return;
            }
            continue;
          }

          // La firma CRC32 del frame EVENT usa el mismo payload que GPS:
          // "deviceId|timestamp|lat.6f|lon.6f|SECRET" (sin el campo 'type').
          // verifySignature espera (deviceId, timestamp, lat, lng, signature),
          // por eso pasamos event.lon como 'lng' — son el mismo valor.
          if (!verifySignature(event.deviceId, event.timestamp, event.lat, event.lon, event.signature)) {
            log('warn', 'tcp.auth.bad_signature', { deviceId: event.deviceId, remote });
            failedAuthAttempts += 1;
            socket.write('ERR\r\n');
            if (failedAuthAttempts >= MAX_FAILED_AUTH) {
              log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
              socket.destroy();
              return;
            }
            continue;
          }

          // Anti-replay: rechazar eventos con timestamp demasiado viejo o futuro.
          // Excepción: timestamp=0 es el evento de boot (sin GPS fix aún) — mismo
          // patrón que el keepalive del frame ARGUS, se acepta sin ventana temporal.
          if (event.timestamp !== '0' && Math.abs(Date.now() - Number(event.timestamp)) > MAX_PACKET_AGE_MS) {
            log('warn', 'tcp.event.replay', { deviceId: event.deviceId, ts: event.timestamp });
            socket.write('ERR\r\n');
            continue;
          }

          // Registrar el device en connectedDevices si no estaba.
          // Un device puede enviar un EVENT sin haber enviado antes un GPS frame
          // (ej: se armó justo después de conectarse). Esto asegura que los
          // comandos pendientes se puedan despachar también tras un EVENT.
          if (deviceId !== event.deviceId) {
            deviceId = event.deviceId;
            connectedDevices.set(deviceId, socket);
            if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
            log('info', 'tcp.auth.ok', { deviceId, remote });
          }

          // Coordenadas opcionales: si el device no tiene fix GPS al momento
          // del evento (ej: STATE_ALERT en garaje cerrado), puede enviar 0,0.
          // Guardamos null en ese caso para que la UI sepa que no hay coordenadas.
          const evLat = (isNaN(event.lat) || (event.lat === 0 && event.lon === 0)) ? null : event.lat;
          const evLon = (isNaN(event.lon) || (event.lat === 0 && event.lon === 0)) ? null : event.lon;

          // Persistir alerta en MongoDB y emitir socket.io: fire-and-forget.
          // No se awaita para no retrasar el ACK al ESP32.
          persistAlert({
            deviceId,
            type: event.type,
            source: 'device',
            lat: evLat,
            lon: evLon,
            timestamp: new Date(Number(event.timestamp) || Date.now()),
          }).catch((err) => log('error', 'tcp.event.persist_error', { deviceId, err: err.message }));

          log('info', 'tcp.event.accepted', { deviceId, type: event.type });
          socket.write('ACK\r\n');
          lastSentCommands.delete(deviceId);
          flushCommands(socket, deviceId);
          continue; // No procesar este línea como frame GPS
        }

        // ── FRAME DE DIAGNÓSTICO: DIAG ───────────────────────────────────
        // Enviado por el firmware en cada nueva conexión TCP, justo después
        // del primer ARGUS exitoso. No tiene firma CRC — solo datos informativos.
        // El device ya está autenticado cuando este frame llega.
        // Formato: "DIAG|deviceId|rssi|cgatt"
        if (line.startsWith('DIAG|')) {
          const parts = line.split('|');
          // 4 partes = firmware pre-TLS ("DIAG|id|rssi|cgatt"); 5 partes agrega
          // el flag tls ("...|cgatt|tls", 2026-07-09). Aceptar ambos formatos
          // para no romper devices en campo con firmware viejo.
          if (parts.length === 4 || parts.length === 5) {
            const diagDeviceId = parts[1];
            // Verificar que el device esté registrado (whitelist), pero no requerir
            // que el deviceId del scope ya esté seteado — el DIAG llega antes del
            // primer ARGUS exitoso porque el EVENT de boot puede tener epoch=0.
            if (await isAllowed(diagDeviceId)) {
              const rssi  = parseInt(parts[2], 10);
              const cgatt = parseInt(parts[3], 10) === 1;
              // tls: null cuando el firmware no reporta el campo (pre-2026-07-09) —
              // distinto de false ("reportó canal plano") para no mostrar falsos negativos.
              const tls   = parts.length === 5 ? parseInt(parts[4], 10) === 1 : null;
              const now   = new Date();

              DeviceState.findOneAndUpdate(
                { deviceId: diagDeviceId },
                { rssi, cgatt, tls, lastDiagAt: now },
                { upsert: true },
              ).catch((err) => log('error', 'tcp.diag.persist_error', { deviceId: diagDeviceId, err: err.message }));

              if (io) {
                io.to(`device:${diagDeviceId}`).emit('device:diag', { deviceId: diagDeviceId, rssi, cgatt, tls });
              }

              log('info', 'tcp.diag.accepted', { deviceId: diagDeviceId, rssi, cgatt, tls });
              // El firmware no espera respuesta al DIAG — no se hace socket.write()
            } else {
              log('warn', 'tcp.diag.unknown_device', { remote, deviceId: parts[1] });
            }
          } else {
            log('warn', 'tcp.diag.malformed', { remote, raw: line.slice(0, 80) });
          }
          continue;
        }

        // ── FRAME DE CONDUCCIÓN: DRIVE ───────────────────────────────────
        if (line.startsWith('DRIVE|')) {
          const drive = parseDrivePacket(line);
          if (!drive) {
            log('warn', 'tcp.drive.malformed', { remote, raw: line.slice(0, 140) });
            socket.write('ERR\r\n');
            continue;
          }

          // Misma auth que para GPS y EVENT.
          if (!(await isAllowed(drive.deviceId))) {
            log('warn', 'tcp.auth.unknown_device', { deviceId: drive.deviceId, remote });
            failedAuthAttempts += 1;
            socket.write('ERR\r\n');
            if (failedAuthAttempts >= MAX_FAILED_AUTH) {
              socket.destroy();
              return;
            }
            continue;
          }

          // La firma CRC32 del frame DRIVE usa el mismo payload base que GPS y EVENT:
          // "{deviceId}|{epoch}|{lat:.6f}|{lon:.6f}|{SECRET}". verifySignature espera
          // (deviceId, timestamp, lat, lng, signature) con el cuarto param como 'lng'.
          if (!verifySignature(drive.deviceId, drive.timestamp, drive.lat, drive.lon, drive.signature)) {
            log('warn', 'tcp.auth.bad_signature', { deviceId: drive.deviceId, remote });
            failedAuthAttempts += 1;
            socket.write('ERR\r\n');
            if (failedAuthAttempts >= MAX_FAILED_AUTH) {
              socket.destroy();
              return;
            }
            continue;
          }

          // Anti-replay: rechazar métricas con timestamp demasiado viejo o futuro.
          if (Math.abs(Date.now() - Number(drive.timestamp)) > MAX_PACKET_AGE_MS) {
            log('warn', 'tcp.drive.replay', { deviceId: drive.deviceId, ts: drive.timestamp });
            socket.write('ERR\r\n');
            continue;
          }

          // Registrar el device si el DRIVE llega antes que el GPS frame de la sesión.
          if (deviceId !== drive.deviceId) {
            deviceId = drive.deviceId;
            connectedDevices.set(deviceId, socket);
            if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
          }

          // Coordenadas: guardar null si el ESP32 reporta 0,0 (sin fix GPS).
          const driveLat = (isNaN(drive.lat) || (drive.lat === 0 && drive.lon === 0)) ? null : drive.lat;
          const driveLon = (isNaN(drive.lon) || (drive.lat === 0 && drive.lon === 0)) ? null : drive.lon;

          // Persistir en MongoDB: fire-and-forget (mismo patrón que persistAlert).
          persistDriveMetrics({
            deviceId,
            lat:          driveLat,
            lon:          driveLon,
            peakAccelDev: isNaN(drive.peakAccelDev) ? 0 : drive.peakAccelDev,
            peakGyroMag:  isNaN(drive.peakGyroMag)  ? 0 : drive.peakGyroMag,
            hardCount:    isNaN(drive.hardCount)     ? 0 : drive.hardCount,
            softCount:    isNaN(drive.softCount)     ? 0 : drive.softCount,
            avgSpeedKmh:  (drive.avgSpeedKmh  !== null && !isNaN(drive.avgSpeedKmh))  ? drive.avgSpeedKmh  : null,
            distanceM:    (drive.distanceM    !== null && !isNaN(drive.distanceM))    ? drive.distanceM    : null,
            maxSpeedKmh:  (drive.maxSpeedKmh  !== null && !isNaN(drive.maxSpeedKmh))  ? drive.maxSpeedKmh  : null,
            stoppedSec:   (drive.stoppedSec   !== null && !isNaN(drive.stoppedSec))   ? drive.stoppedSec   : null,
            timestamp:    new Date(Number(drive.timestamp) || Date.now()),
          }).catch((err) => log('error', 'tcp.drive.persist_error', { deviceId, err: err.message }));

          log('info', 'tcp.drive.accepted', {
            deviceId,
            peakAccelDev: drive.peakAccelDev,
            peakGyroMag:  drive.peakGyroMag,
            hardCount:    drive.hardCount,
            softCount:    drive.softCount,
          });
          socket.write('ACK\r\n');
          lastSentCommands.delete(deviceId);
          flushCommands(socket, deviceId);
          continue;
        }

        // ── PASO 1: Parseo sintáctico ─────────────────────────────────────
        const packet = parsePacket(line);
        if (!packet) {
          // El frame no sigue el protocolo Argus. Podría ser:
          // - Un intento de reconocimiento del puerto (scanner de red)
          // - Un ESP32 con firmware antiguo que usa otro formato
          // - Corrupción de datos en la red móvil
          log('warn', 'tcp.packet.malformed', { remote, raw: line.slice(0, 100) });
          socket.write('ERR\r\n');
          continue;
        }

        // ── PASO 2: Whitelist de dispositivos ─────────────────────────────
        // Verificar que el deviceId esté en la lista de devices autorizados
        // ANTES de verificar la firma. Esto evita que un atacante con un
        // deviceId inventado consuma CPU calculando CRC32.
        if (!(await isAllowed(packet.deviceId))) {
          log('warn', 'tcp.auth.unknown_device', { deviceId: packet.deviceId, remote });
          failedAuthAttempts += 1;
          socket.write('ERR\r\n');

          // Umbral de intentos: 3 fallos de auth destruyen el socket.
          // Sin esto, un atacante podría probar deviceIds indefinidamente
          // en la misma conexión sin costo de reconexión TCP.
          if (failedAuthAttempts >= MAX_FAILED_AUTH) {
            log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
            socket.destroy();
            return; // 'return' necesario: 'destroy' es asíncrono, el loop continuaría
          }
          continue;
        }

        // ── PASO 3: Verificación de firma CRC32 ──────────────────────────
        // La firma es un CRC32 del payload + el secreto compartido (TCP_SECRET).
        // Esto previene que un atacante que conoce el protocolo forje paquetes
        // con coordenadas falsas. Sin esta verificación, cualquiera que sepa
        // el formato podría mover el GPS de un dispositivo registrado.
        if (!verifySignature(
          packet.deviceId,
          packet.timestamp,
          packet.lat,
          packet.lng,
          packet.signature,
        )) {
          log('warn', 'tcp.auth.bad_signature', { deviceId: packet.deviceId, remote });
          failedAuthAttempts += 1;
          socket.write('ERR\r\n');
          if (failedAuthAttempts >= MAX_FAILED_AUTH) {
            log('warn', 'tcp.auth.max_attempts', { remote, attempts: failedAuthAttempts });
            socket.destroy();
            return;
          }
          continue;
        }

        // ── PASO 3b: Protección anti-replay ──────────────────────────────
        // Rechazar paquetes con timestamp demasiado viejo o futuro.
        // Los keepalives (timestamp='0') están exentos: son intencionalmente
        // "sin hora real" y se manejan en PASO 7.
        const packetTs = Number(packet.timestamp);
        if (packet.timestamp !== '0' && Math.abs(Date.now() - packetTs) > MAX_PACKET_AGE_MS) {
          log('warn', 'tcp.packet.replay', { deviceId: packet.deviceId, ts: packet.timestamp });
          socket.write('ERR\r\n');
          continue;
        }

        // ── PASO 4: Rate limiting por device ─────────────────────────────
        // Comparar el timestamp actual con el del último paquete aceptado.
        // Usar Date.now() (tiempo del servidor) en lugar del timestamp del
        // paquete previene que un device manipule su timestamp para bypassear
        // el rate limit.
        const now = Date.now();
        const last = lastSeen.get(packet.deviceId) || 0;
        if (now - last < RATE_LIMIT_MS) {
          log('warn', 'tcp.ratelimit', {
            deviceId: packet.deviceId,
            msSinceLast: now - last,
          });
          // Nota: aquí se usa ERR\n (sin \r) a diferencia de los otros ERR\r\n.
          // Inconsistencia menor pero el ESP32 hace trim() así que funciona igual.
          socket.write('ERR\n');
          continue;
        }

        // Actualizar el timestamp del último paquete ACEPTADO.
        // Se actualiza ANTES de validar coordenadas para que incluso un paquete
        // con coordenadas inválidas cuente para el rate limit (evita flood de
        // paquetes con coords inválidas que eludan el rate limit).
        lastSeen.set(packet.deviceId, now);

        // ── PASO 5: Registro del device en conexiones activas ─────────────
        // Este bloque solo se ejecuta en el primer paquete válido de la sesión
        // (cuando deviceId local es null o cambió, lo que no debería pasar).
        // Registrar el socket en connectedDevices permite enviarle comandos
        // desde deviceController.js sin recorrer todos los sockets.
        if (deviceId !== packet.deviceId) {
          deviceId = packet.deviceId;
          connectedDevices.set(deviceId, socket);

          // Crear la cola de comandos si no existía (device nuevo o primera reconexión).
          // Si ya existía (reconexión de device con comandos pendientes), se respeta
          // la cola existente para no perder comandos encolados durante la desconexión.
          if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
          log('info', 'tcp.auth.ok', { deviceId, remote });
        }

        // Confirmar que el último comando enviado llegó: el device está vivo y respondiendo.
        // El device envía paquetes periódicos — si llegó este, el socket era funcional
        // cuando se envió el último CMD. Limpiar el "unconfirmed" evita re-envíos innecesarios.
        lastSentCommands.delete(deviceId);

        // ── PASO 6: Validación de coordenadas geográficas ─────────────────
        // Aunque parseFloat ya corrió en parsePacket(), aquí validamos rangos.
        // Un GPS con fix inválido puede enviar 0.0/0.0 o valores fuera de rango.
        // Guardar (0,0) en MongoDB haría que el mapa del frontend mostrara la
        // moto en el Océano Atlántico (intersección del Ecuador y el Meridiano de Greenwich).
        const { lat, lng } = packet;
        if (
          isNaN(lat) || isNaN(lng)
          || lat < -90 || lat > 90
          || lng < -180 || lng > 180
        ) {
          log('warn', 'tcp.packet.invalid_coords', { deviceId, lat, lng });
          socket.write('ERR\r\n');
          continue;
        }

        // ── PASO 7: Keepalive — no guardar ni emitir ─────────────────────
        // Cuando el firmware está en pausa por inactividad (moto quieta >5min),
        // envía paquetes con epoch=0 para mantener el socket abierto sin que el
        // servidor los interprete como posición real. Solo confirmamos recepción
        // y despachamos comandos pendientes (ARM/DISARM siguen funcionando).
        if (packet.timestamp === '0') {
          socket.write('ACK\r\n');
          lastSentCommands.delete(deviceId);
          flushCommands(socket, deviceId);
          continue;
        }

        // ── PASO 8: Escritura no bloqueante en MongoDB ────────────────────
        // enqueue() agrega el dato a una cola en memoria (array JS).
        // Un worker (queue.js) drena esa cola cada 2 segundos con insertMany().
        // Esto desacopla la latencia de MongoDB de la latencia de respuesta al ESP32:
        // el ACK se envía en microsegundos; MongoDB puede tardar 50-500ms.
        // Si insertáramos directamente con await Gps.save(), el ESP32 esperaría
        // 500ms antes de recibir el ACK, incrementando el riesgo de timeout del módulo SIM.
        enqueue({
          deviceId,
          lat,
          lon:   lng,                                              // El schema de Gps.js usa 'lon' (no 'lng')
          speed: packet.speed,                                     // km/h desde el GNSS del A7670
          timestamp: new Date(Number(packet.timestamp) || now),   // Fallback a now si timestamp es inválido
        });

        // ── PASO 9: Push en tiempo real al frontend ───────────────────────
        // io.to() envía solo al room del device, no a toda la flota.
        // El cliente se une a device:${deviceId} en el handshake (server.js).
        if (io) {
          io.to(`device:${deviceId}`).emit('gps:update', {
            deviceId,
            lat,
            lon:   lng,
            speed: packet.speed,   // km/h real del GNSS — 0 solo cuando la moto está quieta
            timestamp: new Date(Number(packet.timestamp) || now).toISOString(),
          });
        }

        // ── PASO 9b: Monitor de geocerca — fire-and-forget ───────────────
        // Evalúa si el device tiene geocerca activa y si este GPS frame está
        // dentro o fuera del radio. Con histéresis de 2 puntos para evitar
        // falsos positivos por drift de GPS. Si confirma salida: envía
        // CMD|PARK_MODE_OFF + emite 'geofence:exit' por socket.
        checkGeofence(deviceId, lat, lng, io, (dId, cmd) => {
          const q = commandQueues.get(dId);
          if (q) q.push(cmd);
        }).catch((err) => log('error', 'geofence.check.error', { deviceId, err: err.message }));

        // ── PASO 9c: Monitor de riesgo ARI — fire-and-forget ─────────────
        // Verifica si la moto entró/salió de zona de alto riesgo y actúa
        // automáticamente (ajuste de sensibilidad MPU6050 + push al frontend).
        // Se pasa un callback en vez de importar sendCommand directamente para
        // evitar dependencia circular: tcpServer ↔ riskMonitor.
        // .catch() asegura que un error aquí NO interrumpa el ACK al ESP32.
        checkRiskZone(deviceId, lat, lng, io, (dId, cmd) => {
          const q = commandQueues.get(dId);
          if (q) q.push(cmd);
        }).catch((err) => log('error', 'risk.check.error', { deviceId, err: err.message }));

        // ── PASO 10: Confirmación al device ──────────────────────────────
        // ACK\r\n indica al ESP32 que el paquete fue recibido y procesado.
        // El ESP32 espera este ACK antes de apagar el módulo de radio para
        // ahorrar batería. Sin el ACK, el ESP32 reintentaría (lógica en firmware).
        socket.write('ACK\r\n');
        lastSentCommands.delete(deviceId);
        log('info', 'tcp.packet.accepted', { deviceId, lat, lng });

        // ── PASO 11: Despacho de comandos pendientes ──────────────────────
        // Después del ACK, enviamos el próximo comando en la cola (si existe).
        // El device lee la respuesta después del ACK como un comando a ejecutar.
        // Esta secuencia (ACK → CMD en la misma respuesta) funciona porque el
        // ESP32 lee hasta \n en un loop después de enviar su paquete.
        flushCommands(socket, deviceId);
      }
    });

    // ── EVENTO: timeout de inactividad ───────────────────────────────────────
    // Se dispara si no llegan datos en INACTIVITY_TIMEOUT_MS.
    // socket.destroy() cierra inmediatamente sin esperar datos pendientes,
    // lo que a su vez dispara el evento 'close' para limpiar connectedDevices.
    socket.on('timeout', () => {
      log('warn', 'tcp.timeout', { remote, deviceId });
      socket.destroy();
    });

    // ── EVENTO: conexión cerrada ─────────────────────────────────────────────
    // Se dispara en cualquier caso de cierre: timeout, error, FIN del cliente,
    // o destroy() explícito. Es el lugar correcto para limpiar recursos.
    // NO limpiar commandQueues aquí: si el device se reconecta pronto,
    // los comandos pendientes deben persistir para ser entregados.
    socket.on('close', () => {
      if (deviceId) {
        connectedDevices.delete(deviceId);

        // Si hay un comando enviado pero no confirmado (el device no respondió
        // antes del cierre), reinsertar al frente de la cola para reintento.
        // Esto cubre el caso de socket zombie: flushCommands hizo shift()+write()
        // pero el socket moría silenciosamente antes de que el device leyera el CMD.
        const unconfirmed = lastSentCommands.get(deviceId);
        if (unconfirmed) {
          const q = commandQueues.get(deviceId);
          if (q) {
            q.unshift(unconfirmed);
            log('warn', 'tcp.cmd.requeued', { deviceId, cmd: unconfirmed });
          }
          lastSentCommands.delete(deviceId);
        }
      }
      log('info', 'tcp.disconnect', { remote, deviceId });
    });

    // ── EVENTO: error de socket ──────────────────────────────────────────────
    // En Node.js, los errores de EventEmitter sin listener lanzan una excepción
    // que puede crashear el proceso. Este listener previene ese comportamiento.
    // El evento 'close' SIEMPRE se dispara después de 'error', así que la
    // limpieza de recursos se centraliza en el handler de 'close'.
    socket.on('error', (err) => {
      // 'close' fires after 'error'; cleanup happens there
      log('error', 'tcp.socket.error', { remote, message: err.message });
    });
  };
}

// ─── SERVIDORES TCP Y TLS ─────────────────────────────────────────────────────

/**
 * @brief Crea el servidor TCP plano (puerto 9000). Sigue activo como fallback de rollback.
 *
 * @param {import('socket.io').Server} io
 * @returns {import('net').Server}
 */
function createTcpServer(io) {
  const server = net.createServer(_makeSocketHandler(io));
  // EADDRINUSE si otro proceso ya tiene el puerto.
  server.on('error', (err) => {
    log('error', 'tcp.server.error', { message: err.message });
  });
  return server;
}

/**
 * @brief Crea el servidor TLS (puerto 9001). Cifra el canal; mismo handler que TCP.
 *
 * PROPÓSITO:
 *   Canal paralelo al TCP plano. El firmware con TCP_USE_TLS=1 se conecta aquí.
 *   tls.TLSSocket extiende net.Socket — el handler es 100% compatible.
 *   Si los certificados no existen, retorna null y loguea el motivo sin crashear.
 *
 * ROLLBACK:
 *   Para revertir: flashear firmware con TCP_USE_TLS=0. El puerto 9000 nunca se toca.
 *
 * @param {import('socket.io').Server} io
 * @returns {import('tls').Server | null} — null si los certificados no están disponibles.
 */
function createTlsServer(io) {
  let key, cert;
  try {
    key  = fs.readFileSync(TLS_KEY_PATH);
    cert = fs.readFileSync(TLS_CERT_PATH);
  } catch (err) {
    log('error', 'tls.server.cert_missing', {
      err:  err.message,
      hint: 'Ejecuta: node scripts/gen-tls-cert.js y copia certs/ al servidor',
    });
    return null;
  }
  // minVersion: 'TLSv1' — acepta cualquier versión TLS que el A7670 negocie.
  // El firmware configura sslversion=0 (all); sin este flag Node.js 20 rechaza TLS < 1.2.
  const server = tls.createServer({ key, cert, minVersion: 'TLSv1' }, _makeSocketHandler(io));
  server.on('error', (err) => {
    log('error', 'tls.server.error', { message: err.message });
  });
  // Loguear conexiones TCP crudas (antes del handshake TLS) y errores de handshake.
  // Sin esto, si el A7670 conecta pero falla el handshake SSL, no aparece nada en los logs.
  server.on('connection', (socket) => {
    log('info', 'tls.raw_tcp_connect', { remote: `${socket.remoteAddress}:${socket.remotePort}` });
  });
  server.on('tlsClientError', (err, socket) => {
    log('error', 'tls.handshake_error', { message: err.message, remote: socket?.remoteAddress });
  });
  return server;
}

// ─── API PÚBLICA DEL MÓDULO ───────────────────────────────────────────────────

/**
 * @brief Encola un comando para un device y lo envía de inmediato si está conectado.
 *
 * PROPÓSITO:
 *   Permite que deviceController.js (una ruta REST) envíe un comando al ESP32
 *   sin conocer el socket TCP. sendCommand() abstrae el protocolo TCP y la
 *   gestión de conexiones detrás de una interfaz simple: deviceId + acción.
 *
 * FLUJO LÓGICO:
 *   1. Verificar que el deviceId tiene una cola de comandos (está registrado).
 *      Si no, el device nunca se ha conectado a este servidor → return false.
 *   2. Agregar el comando al final de la cola FIFO.
 *   3. Si el socket está disponible y no fue destruido, llamar flushCommands()
 *      para entrega inmediata.
 *   4. Retornar true si el comando fue entregado de inmediato, false si quedó encolado.
 *
 * DEPENDENCIAS:
 *   - commandQueues: Map<deviceId, string[]>
 *   - connectedDevices: Map<deviceId, Socket>
 *   - flushCommands(): despacha el primer comando de la cola
 *
 * POSIBLES MEJORAS (senior):
 *   - Retornar un objeto { queued: true, position: n } con la posición en la cola.
 *   - Agregar TTL a cada comando: si el device no se conecta en X minutos,
 *     descartar el comando (irrelevante para ARM si la moto ya fue recuperada).
 *   - Persistir la cola en Redis para sobrevivir reinicios del servidor.
 *
 * @param {string} deviceId — Identificador del device destino.
 * @param {string} action — Comando del protocolo Argus (ARM, DISARM, ENGINE_CUT, etc.).
 * @returns {boolean} — true si el socket estaba activo y el comando fue enviado inmediatamente;
 *   false si el device estaba offline y el comando quedó encolado para la próxima reconexión.
 * @throws No lanza excepciones; errores de socket son silenciados por el handler 'error'.
 */
function sendCommand(deviceId, action) {
  // Si el deviceId no tiene cola, significa que nunca se conectó en esta sesión del servidor.
  // No podemos ni encolar porque no sabemos si el device existe.
  // deviceController.js interpretará false como "device desconocido u offline".
  if (!commandQueues.has(deviceId)) return false;

  // Agregar el comando al final de la cola FIFO para este device.
  // Si hay comandos anteriores pendientes, se entregarán en orden.
  commandQueues.get(deviceId).push(action);

  // Intento de entrega inmediata: si el socket existe y no fue destruido,
  // enviamos sin esperar al próximo paquete del device.
  // socket.destroyed es true si el socket fue cerrado (timeout, error, FIN).
  // Sin este check, socket.write() sobre un socket destruido lanzaría un error.
  const socket = connectedDevices.get(deviceId);
  if (socket && !socket.destroyed) flushCommands(socket, deviceId);

  // Retorna true en ambos casos (device online o offline) porque el comando
  // está en la cola. El caller distingue online/offline por si el socket existía.
  // ARQUITECTURA ⚠️: el return value no distingue "encolado" de "enviado inmediato".
  //   CÓMO LO HARÍA UN SENIOR: return { sent: boolean, queued: boolean }
  //   IMPACTO ACTUAL: deviceController.js responde 200 cuando se entregó y
  //   202 cuando quedó encolado, pero esa lógica está en el controller, no aquí.
  return true;
}

/**
 * @brief Levanta el servidor TCP escuchando en TCP_PORT en todas las interfaces.
 *
 * PROPÓSITO:
 *   Función de arranque que se llama desde server.js. Separa la creación
 *   (createTcpServer) del inicio de la escucha (.listen()) para facilitar tests.
 *
 * FLUJO LÓGICO:
 *   1. Crear el servidor con createTcpServer(io).
 *   2. Llamar server.listen() en TCP_PORT en '0.0.0.0'.
 *   3. Registrar en el log que el servidor está activo.
 *   4. Retornar el servidor (permite cerrarlo desde tests o desde un graceful shutdown).
 *
 * DEPENDENCIAS:
 *   - createTcpServer(): fábrica del servidor
 *   - TCP_PORT: constante del módulo
 *   - log: logger estructurado
 *
 * POSIBLES MEJORAS (senior):
 *   - Implementar graceful shutdown: server.close() + dreno de la cola antes
 *     de llamar process.exit() al recibir SIGTERM.
 *
 * @param {import('socket.io').Server} io — Instancia de Socket.io del servidor HTTP.
 * @returns {import('net').Server} — El servidor TCP activo.
 */
function startTcpServer(io) {
  // Guardar referencia global para que deviceController.js pueda emitir
  // eventos WebSocket sin necesidad de importar server.js (evita ciclo circular).
  ioRef = io;

  const server = createTcpServer(io);

  // '0.0.0.0' hace que el servidor escuche en TODAS las interfaces de red.
  // Sin esto, solo escucharía en localhost y el ESP32 no podría conectarse
  // desde internet (la IP pública de GCP no sería accesible).
  server.listen(TCP_PORT, '0.0.0.0', () => {
    log('info', 'tcp.server.start', { port: TCP_PORT });
  });

  return server;
}

/**
 * @brief Levanta el servidor TLS escuchando en TCP_TLS_PORT en todas las interfaces.
 *
 * PROPÓSITO:
 *   Canal cifrado paralelo al TCP plano. Se llama desde server.js DESPUÉS de
 *   startTcpServer(), así el servidor arrancha aunque los certificados falten.
 *
 * FLUJO:
 *   1. createTlsServer() — carga cert/key. Si fallan, retorna null y se loguea.
 *   2. server.listen() en TCP_TLS_PORT ('0.0.0.0').
 *   3. Retorna el servidor TLS (o null si los certs no estaban disponibles).
 *
 * ROLLBACK:
 *   Eliminar la llamada a startTlsServer() en server.js o no poner los .pem en
 *   certs/ — el servidor TCP plano en 9000 sigue corriendo sin ningún cambio.
 *
 * @param {import('socket.io').Server} io
 * @returns {import('tls').Server | null}
 */
function startTlsServer(io) {
  ioRef = io; // idempotente si startTcpServer() ya la seteó

  const server = createTlsServer(io);
  if (!server) {
    log('warn', 'tls.server.skipped', { reason: 'certificados no disponibles — solo TCP plano activo' });
    return null;
  }

  server.listen(TCP_TLS_PORT, '0.0.0.0', () => {
    log('info', 'tls.server.start', { port: TCP_TLS_PORT });
  });

  return server;
}

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
/**
 * @brief Retorna la instancia de Socket.io guardada al arrancar el servidor TCP.
 *
 * PROPÓSITO:
 *   Permite que deviceController.js emita eventos 'alert:new' cuando envía
 *   un comando (ARM, ENGINE_CUT, etc.) sin importar server.js directamente.
 *   Importar server.js desde un controller crearía una dependencia circular:
 *   server.js → routes → controller → server.js.
 *
 * @returns {import('socket.io').Server | null} — null antes de llamar startTcpServer().
 */
function getIo() {
  return ioRef;
}

// connectedDevices se exporta para que deviceController.js pueda verificar
// si un device está actualmente conectado (para responder 200 vs 202 en /status).
module.exports = { startTcpServer, startTlsServer, sendCommand, connectedDevices, getIo };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/tcpServer.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo es la "puerta de entrada" del sistema para el hardware de la
   moto. El ESP32 abre una conexión TCP (como una llamada telefónica permanente)
   y cada 30 segundos envía un mensaje con su posición GPS. Este módulo recibe
   ese mensaje, verifica que el dispositivo sea legítimo (whitelist + firma
   criptográfica), verifica que no esté enviando demasiado rápido (rate limit),
   guarda la posición en una cola de memoria, la envía al teléfono del usuario
   en tiempo real, y responde "ACK" al dispositivo para confirmar la recepción.
   Si el operador envió un comando (ARM, DISARM, etc.) mientras el dispositivo
   estaba conectado o reconecta después, este módulo se lo entrega en ese mismo
   canal de respuesta.

   PSEUDOCÓDIGO:
   Al llegar nueva conexión TCP:
     → configurar timeout e keepalive
     → inicializar buffer y contadores

   Al llegar datos:
     → acumular en buffer
     → por cada línea completa:
         → parsear frame (ARGUS|id|ts|lat|lng|sig)
         → verificar whitelist (isAllowed)
         → verificar firma CRC32 (verifySignature)
         → verificar rate limit (lastSeen)
         → registrar device en connectedDevices
         → validar rangos de coordenadas
         → enqueue(dato) para MongoDB
         → io.emit('gps:update', ...) al frontend
         → socket.write('ACK\r\n') al ESP32
         → flushCommands() si hay comandos pendientes

   Al desconectarse:
     → eliminar de connectedDevices
     → mantener commandQueues (comandos pendientes sobreviven)

   DIAGRAMA MENTAL:
   ESP32 → [TCP stream] → buffer → líneas → parsePacket()
                                              ↓
                                   isAllowed() + verifySignature()
                                              ↓
                                   rate limit (lastSeen Map)
                                              ↓
                              enqueue() ← dato válido → io.emit()
                                              ↓
                                         ACK + CMD

   VARIABLES CRÍTICAS:
   - connectedDevices: si se corrompe, los comandos no llegan al hardware
   - commandQueues: si se corrompe, comandos del operador se pierden
   - lastSeen: si se corrompe, el rate limiting falla y MongoDB puede saturarse
   - buffer: si no se limita en tamaño, un atacante puede agotar la RAM

   RIESGOS DE SEGURIDAD:
   - El canal TCP no está cifrado (sin TLS): las coordenadas GPS viajan en texto plano
   - El secreto TCP_SECRET viaja como variable de entorno; si se filtra, cualquiera puede forjar paquetes
   - El buffer no tiene límite de tamaño máximo: ataque de memory exhaustion
   - io.emit() hace broadcast a todos los clientes WebSocket sin autenticación
   - MAX_FAILED_AUTH=3 es por conexión, no por IP; un atacante puede abrir nuevas conexiones indefinidamente

   RIESGOS DE CONCURRENCIA:
   - Node.js es single-threaded, así que no hay race conditions reales entre eventos.
   - Sin embargo, si en el futuro se usa cluster o worker_threads, los Maps
     (connectedDevices, commandQueues, lastSeen) serían locales a cada proceso y
     los comandos REST irían al proceso equivocado. Necesitaría Redis como store compartido.
   - socket.write() es asíncrono bajo el capó pero el callback de 'data' es síncrono;
     si escribir al socket es lento (backpressure), podría bloquear el event loop.

   ═══════════════════════════════════════════════════════════ */
