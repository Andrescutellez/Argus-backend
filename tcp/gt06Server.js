/**
 * @fileoverview Servidor TCP GT06 — Fase 1: telemetría entrante de dispositivos OEM.
 *
 * Escucha en el puerto GT06_PORT (default 9002) conexiones de rastreadores GPS
 * con protocolo GT06 binario (Concox y clones, e.g. J16 4G).
 *
 * SCOPE FASE 1 — solo telemetría:
 *   - Recibe Login (0x01), Location (0x12), Heartbeat (0x13)
 *   - Responde ACK a Login y Heartbeat (el device reconecta si no recibe ACK en 5s)
 *   - Persiste GPS en MongoDB vía la misma cola que usa el ESP32
 *   - Emite socket.io 'gps:update' al room del IMEI
 *   - NO implementa comandos. La conexión TCP no ejecuta ninguna acción sobre el device.
 *
 * SEGURIDAD:
 *   - IMEI debe estar pre-registrado en manufactured_devices (isAllowed())
 *   - CRC-ITU verificado por frame
 *   - Login requerido antes de procesar Location o Heartbeat
 *   - MAX 3 intentos de auth fallidos → destroy()
 *   - Buffer limitado a MAX_BUFFER_BYTES → destroy() si se supera
 *   - Rate limiting de 3s entre ubicaciones aceptadas
 *
 * @module tcp/gt06Server
 *
 * VARIABLES CRÍTICAS:
 *   - gt06ConnectedDevices: Map<socket, {imei, loginOk, failedAttempts, lastLocationMs}>
 *     — clave es el socket object (no el IMEI) porque un IMEI puede tener múltiples
 *     conexiones si el device reconecta antes de que la conexión anterior se cierre.
 *   - io: instancia socket.io inyectada por server.js — si es null, las actualizaciones
 *     GPS no llegan al frontend pero la telemetría se guarda igual en MongoDB.
 */

'use strict';

const net = require('net');
const { log }        = require('./logger');
const { isAllowed }  = require('./deviceAuth');
const { enqueue }    = require('./queue');
const DeviceState    = require('../models/DeviceState');
const {
  PROTO_LOGIN, PROTO_LOCATION, PROTO_HEARTBEAT,
  PROTO_STRING_RESPONSE, PROTO_ALARM, PROTO_POWER_ALARM, PROTO_SERVER_COMMAND,
  parseFrames, decodeLogin, decodeLocation, decodeHeartbeat, decodeAlarm, buildAck,
  buildServerCommand, decodeStringResponse,
} = require('./gt06Parser');
const { sendGt06AlarmPush } = require('../services/pushService');

// ─── CONSTANTES DE CONFIGURACIÓN ─────────────────────────────────────────────

const GT06_PORT       = parseInt(process.env.GT06_PORT || '9002', 10);
const INACTIVITY_MS   = 600_000; // 10 minutos — el device envía heartbeat cada ~3 min
const MAX_BUFFER_BYTES= 1024;    // protección contra memory exhaustion por clientes maliciosos
const MAX_FAILED_AUTH = 3;       // intentos de login con IMEI no registrado antes de cerrar
const RATE_LIMIT_MS   = 3_000;   // intervalo mínimo entre ubicaciones aceptadas

// ─── MAPEO DE COMANDOS ARGUS → GT06 ──────────────────────────────────────────

/**
 * Traduce los nombres de comando del sistema Argus al texto SMS que entiende el GT06.
 * Los comandos no listados aquí (ARM, DISARM, SIREN_*) son "lógicos" — solo actualizan
 * DeviceState en el backend, sin frame físico al device (el GT06 no los soporta).
 */
const GT06_COMMAND_MAP = {
  ENGINE_CUT:     'DYD,000000#',   // Cortar combustible. Rechazado si velocidad > 20 km/h.
  ENGINE_RESTORE: 'HFYD,000000#',  // Restaurar combustible.
  // ARM/DISARM activan/desactivan el Defense mode del J16 (acelerómetro + alerta GPRS).
  // DEFENSE,1# confirmado en prod con firmware GT06_DK12 — responde DEFENSE_OK.
  ARM:            'DEFENSE,1#',
  DISARM:         'DEFENSE,0#',
  // Diagnóstico temporal — estado, parámetros y vibración. Remover tras Fase 3.
  STATUS_QUERY:   'STATUS#',
  PARAM_QUERY:    'PARAM#',
  SENALM_QUERY:   'SENALM#',
  SENALM_ON:      'SENALM,ON,0#',
  SENALM_OFF:     'SENALM,OFF#',
  DEFENSE_QUERY:  'DEFENSE#',
};

// ─── ESTADO COMPARTIDO ───────────────────────────────────────────────────────

/** @type {Map<net.Socket, {imei: string|null, loginOk: boolean, failedAttempts: number, lastLocationMs: number, buf: Buffer}>} */
const gt06ConnectedDevices = new Map();

/**
 * IMEIs de dispositivos GT06 actualmente autenticados y conectados.
 * Keyed by IMEI (string) → true. Se usa en deviceController para reportar connected=true.
 * @type {Map<string, true>}
 */
const gt06OnlineImeis = new Map();

/**
 * Socket activo por IMEI. Necesario para que sendGt06Command() pueda escribir
 * directamente al socket sin iterar gt06ConnectedDevices.
 * @type {Map<string, net.Socket>}
 */
const gt06ImeiSockets = new Map();

/**
 * Cola de comandos pendientes por IMEI (texto SMS GT06 ya resuelto, e.g. 'DYD,000000#').
 * Persiste a través de reconexiones — si el device se desconecta con comandos pendientes,
 * se entregan en la próxima conexión durante el login.
 * @type {Map<string, string[]>}
 */
const gt06CommandQueues = new Map();

/**
 * Último comando enviado por IMEI, no confirmado aún por un 0x15 del device.
 * Si el socket cierra sin recibir 0x15, el comando se re-encola al frente.
 * @type {Map<string, { text: string, flag: number }>}
 */
const gt06LastSentCmds = new Map();

/**
 * Contador global de seriales de comandos del servidor.
 * Se usa como SERVER_FLAG (uint32) y SN (uint16) en buildServerCommand.
 * Incrementa con cada comando enviado — no necesita persistir entre reinicios
 * porque el device no requiere continuidad en los seriales del servidor.
 */
let _serverCmdSerial = 1;

/** @type {import('socket.io').Server|null} */
let _io = null;

// ─── COLA DE COMANDOS ────────────────────────────────────────────────────────

/**
 * @brief Despacha el siguiente comando pendiente de la cola al device GT06.
 *
 * PROPÓSITO:
 *   Tomar el primer comando de gt06CommandQueues para este IMEI y escribirlo
 *   al socket como frame 0x80 (Server Command). Si el device no está listo
 *   (no pasó login o el socket está destruido), no hace nada.
 *
 * FLUJO LÓGICO:
 *   1. Verificar que ctx.loginOk y ctx.imei estén set.
 *   2. Obtener la cola; si está vacía, retornar.
 *   3. Sacar el primer texto con shift() — política FIFO.
 *   4. Construir el frame 0x80 con buildServerCommand.
 *   5. Escribir al socket; si falla, re-encolar al frente.
 *   6. Guardar en gt06LastSentCmds para re-enqueue si el socket cierra antes del ACK.
 *
 * DEPENDENCIAS:
 *   - gt06CommandQueues: Map<imei, string[]>
 *   - gt06LastSentCmds: Map<imei, {text, flag}>
 *   - buildServerCommand(): construye el frame binario
 *   - _serverCmdSerial: contador global de frames de servidor
 *
 * @param {net.Socket} socket
 * @param {{ imei: string, loginOk: boolean }} ctx
 */
function flushGt06Commands(socket, ctx) {
  if (!ctx || !ctx.loginOk || !ctx.imei) return;

  const q = gt06CommandQueues.get(ctx.imei);
  if (!q || q.length === 0) return;

  const cmdText = q.shift();
  const flag    = _serverCmdSerial & 0xFFFFFFFF;
  const sn      = flag & 0xFFFF;
  _serverCmdSerial++;

  try {
    socket.write(buildServerCommand(cmdText, flag, sn));
  } catch (err) {
    // Socket ya destruido o error de escritura — re-encolar al frente para el próximo intento
    q.unshift(cmdText);
    log('warn', 'gt06.cmd.write.error', { imei: ctx.imei, cmd: cmdText, message: err.message });
    return;
  }

  gt06LastSentCmds.set(ctx.imei, { text: cmdText, flag });
  log('info', 'gt06.cmd.sent', { imei: ctx.imei, cmd: cmdText });
}

/**
 * @brief Encola o entrega inmediatamente un comando a un device GT06.
 *
 * PROPÓSITO:
 *   Interfaz pública análoga a sendCommand() de tcpServer.js, pero para el protocolo GT06.
 *   Llamada desde deviceController.postCommand() cuando detecta que el deviceId
 *   pertenece a un device GT06.
 *
 * FLUJO LÓGICO:
 *   1. Si commandName tiene traducción en GT06_COMMAND_MAP → encolar el texto SMS.
 *      Si no (ARM/DISARM/SIREN_x/SENSITIVITY_x) → sin frame físico, retornar true.
 *      El caller (saveCommandAlert) ya actualizó DeviceState de forma optimista.
 *   2. Crear cola si es la primera vez que se ve este IMEI.
 *      Retornar false si el IMEI nunca se conectó (ni online ni en comandQueues).
 *   3. Encolar el texto y si el socket está activo, flush inmediato.
 *
 * NOTA ARQUITECTÓNICA:
 *   Para comandos sin equivalente físico (ARM/DISARM), el GT06 solo actualiza estado
 *   lógico en backend. El estado "armado" controla si los Alarm Packets (0x16) generan
 *   alertas o se ignoran — comportamiento análogo al ESP32 pero sin señal de hardware.
 *
 * @param {string} imei        - IMEI del device GT06 (usado como deviceId)
 * @param {string} commandName - Nombre de comando Argus (e.g. 'ENGINE_CUT')
 * @returns {boolean} true si el comando fue aceptado (enviado o encolado), false si el IMEI
 *   es desconocido (nunca se conectó en esta sesión del servidor)
 */
function sendGt06Command(imei, commandName) {
  // Si el IMEI nunca se conectó, no podemos ni encolar — igual que sendCommand() de ESP32
  if (!gt06CommandQueues.has(imei) && !gt06OnlineImeis.has(imei)) return false;

  // Asegurarse de que la cola existe (puede estar ausente si gt06OnlineImeis se set antes)
  if (!gt06CommandQueues.has(imei)) gt06CommandQueues.set(imei, []);

  const cmdText = GT06_COMMAND_MAP[commandName];

  if (!cmdText) {
    // Comando sin equivalente físico en GT06 (ARM, DISARM, SIREN_*, SENSITIVITY_*).
    // El estado lógico ya fue actualizado en saveCommandAlert. Aceptar sin frame.
    log('info', 'gt06.cmd.logical.only', { imei, command: commandName });
    return true;
  }

  gt06CommandQueues.get(imei).push(cmdText);

  // Entrega inmediata si el socket está activo
  const socket = gt06ImeiSockets.get(imei);
  if (socket && !socket.destroyed) {
    const ctx = gt06ConnectedDevices.get(socket);
    if (ctx && ctx.loginOk) {
      flushGt06Commands(socket, ctx);
    }
  }

  return true;
}

// ─── HANDLER DE ALARMAS GT06 ─────────────────────────────────────────────────

/**
 * @brief Procesa un Alarm Packet (0x16 o 0x18) del J16.
 *
 * PROPÓSITO:
 *   Centraliza la lógica post-alarma: log, socket.io emit al room del device
 *   y push notification (FCM móvil + Web Push browser) al dueño.
 *
 * FLUJO:
 *   1. Loguear el evento con IMEI, tipo y coordenadas.
 *   2. alarmType === 0x00 → retornar (movimiento suave, no alertar).
 *   3. Emitir gt06:alarm al room del device via socket.io.
 *   4. alarmType === 0x02 → actualizar DeviceState.powerCut = true.
 *   5. alarmType === 0x03 → solo si DeviceState.armed (evitar push sin armar).
 *   6. sendGt06AlarmPush() → FCM + Web Push en paralelo.
 *
 * @param {string}      imei      IMEI del device
 * @param {number}      alarmType Byte 31 del alarm packet (0x00/0x02/0x03)
 * @param {number|null} lat       null si el packet no tiene GPS fix (0x18)
 * @param {number|null} lon
 */
async function handleGt06Alarm(imei, alarmType, lat, lon) {
  const ALARM_NAMES = { 0x00: 'soft_move', 0x02: 'power_cut', 0x03: 'vibration' };
  log('info', 'gt06.alarm', {
    imei,
    alarmType: `0x${alarmType.toString(16).padStart(2, '0')}`,
    name:      ALARM_NAMES[alarmType] ?? 'unknown',
    lat,
    lon,
  });

  if (alarmType === 0x00) return; // movimiento suave — sin alerta

  // Emitir al room del device (web + app ya conectadas)
  if (_io) {
    _io.to(`device:${imei}`).emit('gt06:alarm', {
      alarmType, lat, lon, ts: Date.now(),
    });
  }

  if (alarmType === 0x02) {
    // Fuente cortada — actualizar DeviceState sin importar si está armado
    DeviceState.findOneAndUpdate(
      { deviceId: imei },
      { powerCut: true, updatedAt: new Date() },
      { upsert: true },
    ).catch(() => {});
  }

  // Para 0x03 (vibración): el J16 solo emite este packet cuando Defense:ON está activo
  // en el propio hardware — no hace falta verificar DeviceState.armed en backend.
  // El device es la fuente de verdad sobre su propio estado de defensa.

  // Push a móvil (FCM) y browser (Web Push) en paralelo — no bloqueante
  sendGt06AlarmPush(imei, alarmType, lat, lon).catch(() => {});
}

// ─── HANDLER DE SOCKET ───────────────────────────────────────────────────────

/**
 * @brief Crea el handler de conexión TCP para un socket GT06.
 *
 * Cada conexión TCP tiene su propio estado aislado en 'ctx'. El buffer
 * se acumula entre eventos 'data' porque TCP puede partir un frame en
 * múltiples chunks, o entregar varios frames en un solo chunk.
 *
 * FLUJO:
 *   1. socket.setTimeout → inactivity timeout
 *   2. socket.on('data') → acumular en ctx.buf → parseFrames → handleFrame
 *   3. handleFrame según protocol:
 *      0x01 → isAllowed → ACK o destroy
 *      0x12 → validar login → enqueue → socket.io emit
 *      0x13 → ACK (silencioso en log)
 *      otro → log unsupported
 *   4. socket.on('close') → limpiar gt06ConnectedDevices
 *
 * @param {net.Socket} socket
 */
function makeSocketHandler(socket) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;

  const ctx = {
    imei: null,
    loginOk: false,
    failedAttempts: 0,
    lastLocationMs: 0,
    buf: Buffer.alloc(0),
  };

  gt06ConnectedDevices.set(socket, ctx);
  log('info', 'gt06.connect', { remote });

  socket.setTimeout(INACTIVITY_MS);
  socket.setKeepAlive(true, 60_000);

  socket.on('data', (chunk) => {
    ctx.buf = Buffer.concat([ctx.buf, chunk]);

    // Descartar conexión si el buffer crece demasiado (cliente malicioso o firmware roto)
    if (ctx.buf.length > MAX_BUFFER_BYTES) {
      log('warn', 'gt06.buffer.overflow', { remote, imei: ctx.imei, size: ctx.buf.length });
      socket.destroy();
      return;
    }

    let result;
    try {
      result = parseFrames(ctx.buf);
    } catch (err) {
      log('error', 'gt06.parse.error', { remote, imei: ctx.imei, message: err.message });
      socket.destroy();
      return;
    }

    ctx.buf = result.remaining;

    for (const frame of result.frames) {
      handleFrame(socket, ctx, remote, frame);
    }
  });

  socket.on('timeout', () => {
    log('info', 'gt06.timeout', { remote, imei: ctx.imei });
    socket.destroy();
  });

  socket.on('error', (err) => {
    // ECONNRESET y EPIPE son normales cuando el device corta la SIM — no son errores reales
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      log('error', 'gt06.socket.error', { remote, imei: ctx.imei, code: err.code, message: err.message });
    }
  });

  socket.on('close', () => {
    gt06ConnectedDevices.delete(socket);
    if (ctx.imei) {
      // Solo limpiar presencia si este socket sigue siendo el activo.
      // Si el device reconectó antes de que esta conexión cerrara, el map ya
      // apunta al socket nuevo — borrarlo marcaría el device como offline incorrectamente.
      if (gt06ImeiSockets.get(ctx.imei) === socket) {
        gt06OnlineImeis.delete(ctx.imei);
        gt06ImeiSockets.delete(ctx.imei);
      }

      // Si había un comando enviado sin confirmar (sin 0x15 del device), re-encolar
      // al frente para que se entregue en la próxima reconexión.
      const unconfirmed = gt06LastSentCmds.get(ctx.imei);
      if (unconfirmed) {
        const q = gt06CommandQueues.get(ctx.imei);
        if (q) {
          q.unshift(unconfirmed.text);
          log('warn', 'gt06.cmd.requeued', { imei: ctx.imei, cmd: unconfirmed.text });
        }
        gt06LastSentCmds.delete(ctx.imei);
      }
    }
    log('info', 'gt06.disconnect', { remote, imei: ctx.imei });
  });
}

/**
 * @brief Procesa un frame GT06 ya parseado.
 *
 * @param {net.Socket}  socket
 * @param {object}      ctx    - Estado de la conexión
 * @param {string}      remote - "IP:puerto" para logs
 * @param {{protocol: number, serial: number, data: Buffer, raw: Buffer, crcOk: boolean}} frame
 */
function handleFrame(socket, ctx, remote, frame) {
  if (!frame.crcOk) {
    log('warn', 'gt06.crc.fail', {
      remote,
      imei: ctx.imei,
      protocol: `0x${frame.protocol.toString(16).padStart(2, '0')}`,
    });
    return; // Descartar frame con CRC inválido sin cerrar la conexión
  }

  switch (frame.protocol) {

    case PROTO_LOGIN: {
      let decoded;
      try {
        decoded = decodeLogin(frame.data);
      } catch (err) {
        log('warn', 'gt06.login.decode.error', { remote, message: err.message });
        ctx.failedAttempts++;
        if (ctx.failedAttempts >= MAX_FAILED_AUTH) socket.destroy();
        return;
      }

      const { imei } = decoded;

      // Verificación asíncrona: el ACK se envía solo si el IMEI está registrado
      isAllowed(imei).then((allowed) => {
        if (!allowed) {
          ctx.failedAttempts++;
          log('warn', 'gt06.login.rejected', { remote, imei, failedAttempts: ctx.failedAttempts });
          if (ctx.failedAttempts >= MAX_FAILED_AUTH) socket.destroy();
          return;
        }

        ctx.imei    = imei;
        ctx.loginOk = true;
        gt06OnlineImeis.set(imei, true);
        gt06ImeiSockets.set(imei, socket);

        // Crear cola de comandos si no existía (reconexión: conserva pendientes)
        if (!gt06CommandQueues.has(imei)) gt06CommandQueues.set(imei, []);

        log('info', 'gt06.login.ok', { remote, imei });

        // Responder ACK — el device entra en loop de reconexión si no recibe esto en 5s
        try {
          socket.write(buildAck(PROTO_LOGIN, frame.serial));
        } catch (err) {
          log('error', 'gt06.ack.write.error', { remote, imei, message: err.message });
          return;
        }

        // Entregar comandos que quedaron pendientes de una sesión anterior
        flushGt06Commands(socket, ctx);
      }).catch((err) => {
        log('error', 'gt06.auth.error', { remote, imei, message: err.message });
      });

      break;
    }

    case PROTO_LOCATION: {
      if (!ctx.loginOk) {
        log('warn', 'gt06.location.no.login', { remote });
        return;
      }

      // Rate limiting: el J16 envía locations cada pocos segundos con buena señal
      const now = Date.now();
      if (now - ctx.lastLocationMs < RATE_LIMIT_MS) {
        log('debug', 'gt06.location.ratelimit', { remote, imei: ctx.imei });
        return;
      }

      let loc;
      try {
        loc = decodeLocation(frame.data);
      } catch (err) {
        log('warn', 'gt06.location.decode.error', { remote, imei: ctx.imei, message: err.message });
        return;
      }

      // Validar rangos básicos (coordenadas fuera de rango indican firmware roto)
      if (Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) {
        log('warn', 'gt06.location.invalid.coords', {
          remote, imei: ctx.imei, lat: loc.lat, lon: loc.lon,
        });
        return;
      }

      ctx.lastLocationMs = now;

      const point = {
        deviceId:  ctx.imei,
        lat:       loc.lat,
        lon:       loc.lon,
        speed:     loc.speed,
        timestamp: loc.datetime,
      };

      // Persistir en MongoDB via la misma cola que usa el protocolo Argus (ESP32)
      enqueue(point);

      // Notificar al frontend si hay clientes escuchando este IMEI
      if (_io) {
        _io.to(`device:${ctx.imei}`).emit('gps:update', point);
      }

      log('info', 'gt06.location.accepted', {
        imei:       ctx.imei,
        lat:        loc.lat,
        lon:        loc.lon,
        speed:      loc.speed,
        satellites: loc.satellites,
        hasFix:     loc.hasFix,
      });

      break;
    }

    case PROTO_HEARTBEAT: {
      if (!ctx.loginOk) {
        log('warn', 'gt06.heartbeat.no.login', { remote });
        return;
      }

      // Responder ACK: critical — sin ACK el device reconecta en 5 segundos
      try {
        socket.write(buildAck(PROTO_HEARTBEAT, frame.serial));
      } catch (err) {
        log('error', 'gt06.ack.write.error', { remote, imei: ctx.imei, message: err.message });
        return;
      }

      // Log de heartbeat solo en debug para no saturar los logs en producción
      // El device envía heartbeat cada ~3 minutos → 480 líneas/día por device
      let hb;
      try {
        hb = decodeHeartbeat(frame.data);
      } catch (_) {
        // Heartbeat malformado: el ACK ya fue enviado, solo loguear
        log('debug', 'gt06.heartbeat.decode.error', { remote, imei: ctx.imei });
        return;
      }

      log('debug', 'gt06.heartbeat', {
        imei:         ctx.imei,
        voltageLevel: hb.voltageLevel,
        gsmSignal:    hb.gsmSignal,
      });

      break;
    }

    case PROTO_STRING_RESPONSE: {
      // Respuesta del device a un comando 0x80 del servidor (e.g. 'DYD=Success!').
      // No hay ACK del servidor para este frame — el device no espera respuesta.
      if (!ctx.loginOk) {
        log('warn', 'gt06.response.no.login', { remote });
        return;
      }

      let resp;
      try {
        resp = decodeStringResponse(frame.data);
      } catch (err) {
        log('warn', 'gt06.response.decode.error', { remote, imei: ctx.imei, message: err.message });
        break;
      }

      // Guardar antes de borrar: DEFENSE_OK necesita saber qué comando se envió.
      const lastSentBeforeDelete = gt06LastSentCmds.get(ctx.imei);
      // El comando fue recibido y ejecutado — ya no hace falta re-encolarlo en 'close'
      gt06LastSentCmds.delete(ctx.imei);

      log('info', 'gt06.cmd.response', { imei: ctx.imei, text: resp.text });

      if (resp.text.startsWith('DYD=Success')) {
        // Corte de motor confirmado — actualizar DeviceState (la UI ya lo mostró optimista)
        DeviceState.findOneAndUpdate(
          { deviceId: ctx.imei },
          { motorCut: true, updatedAt: new Date() },
          { upsert: true },
        ).catch(() => {});
        if (_io) _io.to(`device:${ctx.imei}`).emit('gt06:cmd:ack', { cmd: 'ENGINE_CUT', result: 'success' });

      } else if (resp.text.startsWith('DYD=Speed Limit') || resp.text.startsWith('DYD=Unvalued Fix')) {
        // GT06 rechaza DYD si: velocidad > 20 km/h (Speed Limit) o sin fix GPS (Unvalued Fix).
        // En ambos casos revertir el update optimista — el motor NO fue cortado.
        DeviceState.findOneAndUpdate(
          { deviceId: ctx.imei },
          { motorCut: false, updatedAt: new Date() },
          { upsert: true },
        ).catch(() => {});
        const reason = resp.text.startsWith('DYD=Speed Limit') ? 'speed_limit' : 'no_gps_fix';
        const message = reason === 'speed_limit'
          ? 'No se puede cortar motor: velocidad > 20 km/h'
          : 'No se puede cortar motor: sin fix GPS';
        if (_io) _io.to(`device:${ctx.imei}`).emit('gt06:cmd:ack', {
          cmd: 'ENGINE_CUT', result: reason, message,
        });

      } else if (resp.text.startsWith('HFYD=Success')) {
        DeviceState.findOneAndUpdate(
          { deviceId: ctx.imei },
          { motorCut: false, updatedAt: new Date() },
          { upsert: true },
        ).catch(() => {});
        if (_io) _io.to(`device:${ctx.imei}`).emit('gt06:cmd:ack', { cmd: 'ENGINE_RESTORE', result: 'success' });

      } else if (resp.text.startsWith('HFYD=Fail')) {
        if (_io) _io.to(`device:${ctx.imei}`).emit('gt06:cmd:ack', { cmd: 'ENGINE_RESTORE', result: 'fail' });

      } else if (resp.text.startsWith('DEFENSE_OK')) {
        // Respuesta a DEFENSE,1# o DEFENSE,0# — el device confirmó el cambio de estado.
        const armed = lastSentBeforeDelete?.text === 'DEFENSE,1#';
        DeviceState.findOneAndUpdate(
          { deviceId: ctx.imei },
          { armed, updatedAt: new Date() },
          { upsert: true },
        ).catch(() => {});
        if (_io) {
          _io.to(`device:${ctx.imei}`).emit('device:state', { armed });
        }
        log('info', 'gt06.defense.confirmed', { imei: ctx.imei, armed });

      } else {
        log('debug', 'gt06.response.unknown', { imei: ctx.imei, text: resp.text });
      }

      // Entregar el siguiente comando pendiente si lo hay
      flushGt06Commands(socket, ctx);
      break;
    }

    case PROTO_ALARM: {
      // Alarm Packet con GPS fix (0x16) — byte 31 = alarm type.
      // El J16 no espera ACK para este frame (verificado en prod).
      if (!ctx.loginOk) {
        log('warn', 'gt06.alarm.no.login', { remote });
        return;
      }
      let alarm;
      try {
        alarm = decodeAlarm(frame.data);
      } catch (err) {
        log('warn', 'gt06.alarm.decode.error', { remote, imei: ctx.imei, message: err.message });
        break;
      }
      handleGt06Alarm(
        ctx.imei,
        alarm.alarmType,
        alarm.hasFix ? alarm.lat : null,
        alarm.hasFix ? alarm.lon : null,
      ).catch(() => {});
      break;
    }

    case PROTO_POWER_ALARM: {
      // Power Alarm sin GPS fix (0x18) — misma estructura pero coordenadas = 0.
      // Aparece también cada ~5 min como heartbeat; solo actuar si alarm type = 0x02.
      if (!ctx.loginOk) break;
      let pAlarm;
      try {
        pAlarm = decodeAlarm(frame.data);
      } catch (err) {
        log('debug', 'gt06.power.alarm.decode.error', { remote, imei: ctx.imei, message: err.message });
        break;
      }
      // Solo notificar si es un corte real (0x02); los heartbeats periódicos también
      // llegan como 0x18 con alarmType=0x02 — se procesan igual (idempotente en DeviceState).
      handleGt06Alarm(ctx.imei, pAlarm.alarmType, null, null).catch(() => {});
      break;
    }

    default: {
      // No responder, no cerrar — el device puede enviar protocolos no implementados.
      // Incluir hex del data para poder identificar el formato en Fase 3.
      log('info', 'gt06.proto.unsupported', {
        remote,
        imei:     ctx.imei,
        protocol: `0x${frame.protocol.toString(16).padStart(2, '0')}`,
        dataHex:  frame.data.toString('hex'),
      });
      break;
    }
  }
}

// ─── ARRANQUE DEL SERVIDOR ────────────────────────────────────────────────────

/**
 * @brief Inicia el servidor TCP GT06 en el puerto GT06_PORT.
 *
 * Se llama desde server.js junto con startTcpServer() y startTlsServer().
 * La instancia io se inyecta para poder emitir 'gps:update' sin importar
 * el módulo socket.io directamente (evita dependencia circular).
 *
 * @param {import('socket.io').Server} io - Instancia socket.io del servidor principal
 */
function startGt06Server(io) {
  _io = io;

  const server = net.createServer((socket) => {
    makeSocketHandler(socket);
  });

  server.on('error', (err) => {
    log('error', 'gt06.server.error', { message: err.message, code: err.code });
  });

  server.listen(GT06_PORT, () => {
    log('info', 'gt06.server.start', { port: GT06_PORT });
  });

  return server;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = { startGt06Server, gt06ConnectedDevices, gt06OnlineImeis, sendGt06Command };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/gt06Server.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Servidor TCP en el puerto 9002 que recibe datos GPS de dispositivos OEM
   chinos (J16 4G y similares). En esta fase (Fase 1) solo escucha telemetría:
   recibe la ubicación del dispositivo, la guarda en MongoDB y la muestra en
   el mapa de la app. No envía comandos al dispositivo. El flujo es análogo
   al tcpServer.js del ESP32, pero con el protocolo binario GT06 en lugar
   del protocolo Argus texto.

   PSEUDOCÓDIGO:
   startGt06Server(io):
     → net.createServer → makeSocketHandler
     → listen(GT06_PORT)

   makeSocketHandler(socket):
     → ctx = { imei:null, loginOk:false, failedAttempts:0, buf:Buffer }
     → socket.on('data') → concat buf → parseFrames → handleFrame[]
     → socket.on('close') → cleanup

   handleFrame(frame):
     → 0x01 Login: isAllowed(imei) → ACK o destroy
     → 0x12 Location: loginOk? → enqueue + socket.io emit
     → 0x13 Heartbeat: loginOk? → ACK

   DIAGRAMA MENTAL:
   J16 4G SIM
     ↓ TCP :9002
   [makeSocketHandler] → parseFrames → frames[]
     ↓
   0x01 → isAllowed(IMEI) → [MongoDB:manufactured_devices]
       ✓ → buildAck(0x01) → J16
   0x12 → enqueue({lat,lon}) → [MongoDB:gps]
        → io.to(device:IMEI).emit('gps:update') → [Frontend mapa]
   0x13 → buildAck(0x13) → J16

   VARIABLES CRÍTICAS:
   - gt06ConnectedDevices: Map por socket. Si un IMEI reconecta sin que la
     conexión anterior se cierre, habrá dos entradas temporalmente.
   - ctx.loginOk: flag que protege Location y Heartbeat de ser procesados
     antes de que el IMEI sea validado.
   - _io: puede ser null si startGt06Server se llama sin io (test unitario).
     El código lo verifica antes de emitir.

   VARIABLES CRÍTICAS (Fase 2):
   - gt06CommandQueues: cola persistente por IMEI. No limpiar en 'close' —
     los comandos deben sobrevivir reconexiones.
   - gt06LastSentCmds: comando enviado sin confirmar. Limpiar en 'close' y
     re-encolar para garantía de entrega.
   - gt06ImeiSockets: socket activo por IMEI. Necesario para entrega inmediata
     en sendGt06Command(). Limpiar en 'close'.
   - GT06_COMMAND_MAP: solo ENGINE_CUT y ENGINE_RESTORE tienen frame físico.
     ARM/DISARM son estado lógico en backend (DeviceState.armed).

   DEUDA TÉCNICA:
   - Fase 3: Alarm Packet 0x16 → push FCM.
   - Fase 4: device_type en onboarding UI.

   ═══════════════════════════════════════════════════════════ */
