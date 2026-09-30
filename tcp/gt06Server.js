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
const { log }       = require('./logger');
const { isAllowed } = require('./deviceAuth');
const { enqueue }   = require('./queue');
const {
  PROTO_LOGIN, PROTO_LOCATION, PROTO_HEARTBEAT,
  parseFrames, decodeLogin, decodeLocation, decodeHeartbeat, buildAck,
} = require('./gt06Parser');

// ─── CONSTANTES DE CONFIGURACIÓN ─────────────────────────────────────────────

const GT06_PORT       = parseInt(process.env.GT06_PORT || '9002', 10);
const INACTIVITY_MS   = 600_000; // 10 minutos — el device envía heartbeat cada ~3 min
const MAX_BUFFER_BYTES= 1024;    // protección contra memory exhaustion por clientes maliciosos
const MAX_FAILED_AUTH = 3;       // intentos de login con IMEI no registrado antes de cerrar
const RATE_LIMIT_MS   = 3_000;   // intervalo mínimo entre ubicaciones aceptadas

// ─── ESTADO COMPARTIDO ───────────────────────────────────────────────────────

/** @type {Map<net.Socket, {imei: string|null, loginOk: boolean, failedAttempts: number, lastLocationMs: number, buf: Buffer}>} */
const gt06ConnectedDevices = new Map();

/**
 * IMEIs de dispositivos GT06 actualmente autenticados y conectados.
 * Keyed by IMEI (string) → true. Se usa en deviceController para reportar connected=true.
 * @type {Map<string, true>}
 */
const gt06OnlineImeis = new Map();

/** @type {import('socket.io').Server|null} */
let _io = null;

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
    if (ctx.imei) gt06OnlineImeis.delete(ctx.imei);
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
        log('info', 'gt06.login.ok', { remote, imei });

        // Responder ACK — el device entra en loop de reconexión si no recibe esto en 5s
        try {
          socket.write(buildAck(PROTO_LOGIN, frame.serial));
        } catch (err) {
          log('error', 'gt06.ack.write.error', { remote, imei, message: err.message });
        }
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

    default: {
      // No responder, no cerrar — el device puede enviar protocolos no implementados
      log('info', 'gt06.proto.unsupported', {
        remote,
        imei:     ctx.imei,
        protocol: `0x${frame.protocol.toString(16).padStart(2, '0')}`,
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
module.exports = { startGt06Server, gt06ConnectedDevices, gt06OnlineImeis };


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

   DEUDA TÉCNICA:
   - Fase 2: exponer gt06ConnectedDevices en deviceController para mostrar
     estado 'connected' en el panel.
   - Fase 2: cola de comandos GT06 (DYD/HFYD para corte de motor).
   - Fase 3: Alarm Packet 0x16 → push FCM.

   ═══════════════════════════════════════════════════════════ */
