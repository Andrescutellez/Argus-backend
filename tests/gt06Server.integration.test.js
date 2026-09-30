/**
 * Integration test para tcp/gt06Server.js
 *
 * Simula una conexión TCP completa Login → Location → Heartbeat sin hardware físico.
 * Mockea deviceAuth.isAllowed y queue.enqueue para no requerir PostgreSQL ni MongoDB.
 *
 * Usa node:test (Node.js 18+). Sin dependencias externas.
 * Ejecutar con: node --test tests/gt06Server.integration.test.js
 *
 * Nota: parchea require.cache antes de cargar gt06Server para inyectar los mocks.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net    = require('net');
const path   = require('path');

// Puerto de test — debe setearse ANTES de cargar gt06Server (el módulo lee el env en el top level)
const TEST_PORT = 19002;
process.env.GT06_PORT = String(TEST_PORT);

// ─── SETUP DE MOCKS (debe hacerse ANTES de require gt06Server) ────────────────

// Contadores de llamadas para verificar en los asserts
const mockState = {
  enqueueCalls: [],
  isAllowedImei: null,
  isAllowedReturn: true,
  deviceStateCalls: [],
};

// Mock de deviceAuth
const deviceAuthPath = require.resolve('../tcp/deviceAuth');
require.cache[deviceAuthPath] = {
  id: deviceAuthPath,
  filename: deviceAuthPath,
  loaded: true,
  exports: {
    isAllowed: async (imei) => {
      mockState.isAllowedImei = imei;
      return mockState.isAllowedReturn;
    },
    verifySignature: () => true,
  },
};

// Mock de queue
const queuePath = require.resolve('../tcp/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueue: (data) => { mockState.enqueueCalls.push(data); },
    startWorker: () => {},
  },
};

// Mock de DeviceState — captura llamadas a findOneAndUpdate sin conectar a MongoDB
const deviceStatePath = require.resolve('../models/DeviceState');
require.cache[deviceStatePath] = {
  id: deviceStatePath,
  filename: deviceStatePath,
  loaded: true,
  exports: {
    findOneAndUpdate: (filter, update, options) => {
      mockState.deviceStateCalls.push({ filter, update, options });
      return Promise.resolve(null);
    },
  },
};

// Ahora cargar el servidor con los mocks aplicados
const { startGt06Server, gt06ConnectedDevices, sendGt06Command } = require('../tcp/gt06Server');
const {
  buildAck, PROTO_LOGIN, PROTO_HEARTBEAT, PROTO_SERVER_COMMAND,
} = require('../tcp/gt06Parser');

// ─── PAQUETES DE REFERENCIA ──────────────────────────────────────────────────

// Login J16 real: IMEI 867689067010506, BCD J16-style [08 67 68 90 67 01 05 06], SN=0002, CRC=E8C0
// El J16 prepone nibble 0x0 de padding (IMEI right-aligned); el parser lo detecta via Luhn.
const LOGIN_PKT_OK = Buffer.from('78780D01' + '0867689067010506' + '0002' + 'E8C0' + '0D0A', 'hex');

// Location: 78 78 1F 12 ...
const LOCATION_PKT = Buffer.from(
  '78781F12' +
  '0B081D112E10' +
  'CF' +
  '027AC7EB' +
  '0C465849' +
  '00' +
  '148F' +
  '01CC' + '00' + '287D' + '001FB8' +
  '0003' +
  '8081' +
  '0D0A',
  'hex'
);

// Heartbeat: 78 78 0A 13 44 01 04 00 01 0005 0845 0D0A
const HEARTBEAT_PKT = Buffer.from('78780A134401040001' + '0005' + '0845' + '0D0A', 'hex');

// DYD=Success! respuesta del device (frame 0x15, CRC válido del Apéndice B del spec GT06)
// 78 78 18 15 10 00 01 A9 58 44 59 44 3D 53 75 63 63 65 73 73 21 00 02 00 18 91 77 0D 0A
const DYD_SUCCESS_RESP_PKT = Buffer.from(
  '7878 18 15 10 0001A958 4459443D5375636365737321 0002 0018 9177 0D0A'.replace(/\s/g, ''), 'hex'
);

// ─── SERVIDOR Y UTILIDADES ───────────────────────────────────────────────────

let server;
const mockIo = {
  to: () => ({ emit: () => {} }),
};

/** Conecta un socket al servidor de test y retorna una Promise que resuelve cuando está conectado */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(TEST_PORT, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Lee exactamente `expectedBytes` del socket con timeout.
 * El device puede enviar múltiples ACKs juntos o en chunks separados.
 */
function readBytes(socket, expectedBytes, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      reject(new Error(`Timeout esperando ${expectedBytes} bytes. Recibidos: ${buf.length}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= expectedBytes) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(buf.slice(0, expectedBytes));
      }
    };
    socket.on('data', onData);
  });
}

/** Espera N ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── SETUP / TEARDOWN ────────────────────────────────────────────────────────

before(async () => {
  server = startGt06Server(mockIo);
  // Esperar a que el servidor esté escuchando
  await new Promise((resolve) => server.once('listening', resolve));
});

after(() => {
  server.close();
});

beforeEach(() => {
  mockState.enqueueCalls = [];
  mockState.isAllowedImei = null;
  mockState.isAllowedReturn = true;
  mockState.deviceStateCalls = [];
});

// ─── TESTS ───────────────────────────────────────────────────────────────────

describe('GT06 Server — flujo completo', () => {

  test('Login con IMEI válido → responde ACK correcto', async () => {
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);
    const response = await readBytes(socket, 10); // ACK = 10 bytes

    const expectedAck = buildAck(PROTO_LOGIN, 0x0002);
    assert.deepStrictEqual(response, expectedAck);

    // isAllowed fue llamado con el IMEI correcto (J16 real)
    assert.strictEqual(mockState.isAllowedImei, '867689067010506');

    socket.destroy();
  });

  test('Login con IMEI no registrado → no responde ACK (no destruye en el primer intento)', async () => {
    mockState.isAllowedReturn = false;
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);

    // No debe llegar ACK — timeout esperado
    let gotAck = false;
    await new Promise((resolve) => {
      socket.once('data', () => { gotAck = true; resolve(); });
      setTimeout(resolve, 400);
    });

    assert.strictEqual(gotAck, false, 'No debe enviar ACK si IMEI no está registrado');
    socket.destroy();
  });

  test('Login rechazado 3x → cierra la conexión (MAX_FAILED_AUTH)', async () => {
    mockState.isAllowedReturn = false;
    const socket = await connect();

    // Enviar 3 logins con IMEI no registrado consecutivos
    for (let i = 0; i < 3; i++) {
      socket.write(LOGIN_PKT_OK);
      await sleep(150); // dar tiempo al async isAllowed
    }

    // Después del 3er intento la conexión debe cerrarse
    await new Promise((resolve) => {
      if (socket.destroyed) { resolve(); return; }
      socket.once('close', resolve);
      setTimeout(resolve, 1000);
    });

    assert.strictEqual(socket.destroyed, true);
  });

  test('Login + Location → enqueue llamado con lat/lon correctos', async () => {
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10); // ACK login

    // Esperar que el login async se procese
    await sleep(100);

    socket.write(LOCATION_PKT);
    await sleep(200); // dar tiempo a que se procese

    assert.strictEqual(mockState.enqueueCalls.length, 1);
    const point = mockState.enqueueCalls[0];

    // IMEI J16 real
    assert.strictEqual(point.deviceId, '867689067010506');

    // Lat ≈ 23.07° Norte
    assert.ok(point.lat > 23.0 && point.lat < 23.2, `lat=${point.lat}`);
    assert.ok(point.lat > 0, 'lat debe ser positiva (Norte)');

    // Lon ≈ 114.41° Este (valor real calculado del paquete del spec)
    assert.ok(point.lon > 114.0 && point.lon < 115.0, `lon=${point.lon}`);
    assert.ok(point.lon > 0, 'lon debe ser positiva (Este)');

    // Speed = 0
    assert.strictEqual(point.speed, 0);

    // Timestamp es Date válido
    assert.ok(point.timestamp instanceof Date);

    socket.destroy();
  });

  test('Location sin Login previo → NO llama a enqueue', async () => {
    const socket = await connect();

    // Enviar Location directamente sin hacer Login
    socket.write(LOCATION_PKT);
    await sleep(200);

    assert.strictEqual(mockState.enqueueCalls.length, 0);

    socket.destroy();
  });

  test('Login + Heartbeat → responde ACK de heartbeat', async () => {
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10); // ACK login
    await sleep(100);

    socket.write(HEARTBEAT_PKT);
    const hbAck = await readBytes(socket, 10);

    const expectedHbAck = buildAck(PROTO_HEARTBEAT, 0x0005);
    assert.deepStrictEqual(hbAck, expectedHbAck);

    socket.destroy();
  });

  test('Heartbeat sin Login → NO responde ACK', async () => {
    const socket = await connect();

    socket.write(HEARTBEAT_PKT);

    // No debe llegar respuesta — timeout esperado
    let gotData = false;
    const p = new Promise((resolve) => {
      socket.once('data', () => { gotData = true; resolve(); });
      setTimeout(resolve, 300);
    });
    await p;

    assert.strictEqual(gotData, false, 'No debe responder a heartbeat sin login');
    socket.destroy();
  });

  test('Frame con CRC corrupto → no llama a enqueue', async () => {
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10);
    await sleep(100);

    // Corromper CRC del Location
    const corrupted = Buffer.from(LOCATION_PKT);
    corrupted[corrupted.length - 4] ^= 0xFF; // alterar primer byte de CRC

    socket.write(corrupted);
    await sleep(200);

    assert.strictEqual(mockState.enqueueCalls.length, 0);

    socket.destroy();
  });

  test('Buffer overflow (> MAX_BUFFER_BYTES) → conexión cerrada', async () => {
    const socket = await connect();

    // Enviar 2048 bytes sin framing válido
    socket.write(Buffer.alloc(2048, 0xAA));

    await new Promise((resolve) => {
      socket.once('close', resolve);
      setTimeout(resolve, 2000);
    });

    assert.strictEqual(socket.destroyed, true);
  });

  test('Desconexión limpia el estado de gt06ConnectedDevices', async () => {
    const sizeBefore = gt06ConnectedDevices.size;
    const socket = await connect();
    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10);
    await sleep(100);

    // Debe haber una entrada más en el Map (la clave es el socket del servidor, no del cliente)
    assert.ok(gt06ConnectedDevices.size > sizeBefore, 'El Map debe crecer tras conectar');

    socket.destroy();
    await sleep(200);

    // El Map debe volver a su tamaño anterior tras desconectar
    assert.strictEqual(gt06ConnectedDevices.size, sizeBefore);
  });
});

describe('GT06 Server — comandos Fase 2', () => {

  test('sendGt06Command con IMEI desconocido → retorna false', () => {
    const result = sendGt06Command('000000000000000', 'ENGINE_CUT');
    assert.strictEqual(result, false, 'IMEI que nunca conectó debe retornar false');
  });

  test('ARM es lógico — sendGt06Command retorna true sin enviar frame al device', async () => {
    const socket = await connect();
    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10);
    await sleep(100);

    const result = sendGt06Command('867689067010506', 'ARM');
    assert.strictEqual(result, true);

    // ARM no tiene frame GT06 equivalente; no debe llegar ningún byte al device
    let gotData = false;
    await new Promise((resolve) => {
      socket.once('data', () => { gotData = true; resolve(); });
      setTimeout(resolve, 300);
    });
    assert.strictEqual(gotData, false, 'ARM no debe enviar frame binario al device');

    socket.destroy();
  });

  test('ENGINE_CUT: login → comando → 0x80 enviado → respuesta 0x15 → DeviceState motorCut=true', async () => {
    const socket = await connect();
    socket.write(LOGIN_PKT_OK);
    await readBytes(socket, 10); // ACK login
    await sleep(100);            // esperar que el login async complete (gt06ImeiSockets set)

    const sent = sendGt06Command('867689067010506', 'ENGINE_CUT');
    assert.strictEqual(sent, true);

    // El servidor escribe un frame 0x80 al device.
    // DYD,000000# = 11 chars → LEN = 11+10 = 21 → frame total = 11+15 = 26 bytes
    const cmdFrame = await readBytes(socket, 26);

    assert.strictEqual(cmdFrame[0], 0x78,                 'start byte 1');
    assert.strictEqual(cmdFrame[1], 0x78,                 'start byte 2');
    assert.strictEqual(cmdFrame[2], 11 + 10,              'LEN = M + 10 = 21');
    assert.strictEqual(cmdFrame[3], PROTO_SERVER_COMMAND, 'protocol = 0x80');
    assert.strictEqual(cmdFrame[4], 11 + 4,               'CMD_LEN = M + 4 = 15');
    assert.strictEqual(cmdFrame[24], 0x0D,                'end byte 1');
    assert.strictEqual(cmdFrame[25], 0x0A,                'end byte 2');
    assert.strictEqual(cmdFrame.slice(9, 20).toString('ascii'), 'DYD,000000#', 'command text');

    // Device responde DYD=Success! (frame 0x15 con CRC válido del spec)
    socket.write(DYD_SUCCESS_RESP_PKT);
    await sleep(100);

    // El handler debe haber llamado DeviceState.findOneAndUpdate con motorCut: true
    assert.strictEqual(mockState.deviceStateCalls.length, 1, 'findOneAndUpdate debe ser llamado una vez');
    assert.deepStrictEqual(
      mockState.deviceStateCalls[0].filter,
      { deviceId: '867689067010506' },
      'filter por deviceId',
    );
    assert.strictEqual(mockState.deviceStateCalls[0].update.motorCut, true, 'motorCut debe ser true');

    socket.destroy();
  });

  test('ENGINE_CUT encolado — se entrega automáticamente en la próxima reconexión', async () => {
    // Primera conexión: solo para registrar el IMEI en gt06CommandQueues
    const s1 = await connect();
    s1.write(LOGIN_PKT_OK);
    await readBytes(s1, 10);
    await sleep(100);
    s1.destroy();
    await sleep(100); // esperar que el 'close' limpie gt06OnlineImeis e gt06ImeiSockets

    // Encolar el comando mientras el device está offline
    const queued = sendGt06Command('867689067010506', 'ENGINE_CUT');
    assert.strictEqual(queued, true, 'debe aceptar el comando aunque el device esté offline');

    // Segunda conexión: el servidor envía ACK (10 bytes) + 0x80 frame (26 bytes) en el mismo
    // handler del login — ambos llegan juntos, leer los 36 bytes de una sola vez.
    const s2 = await connect();
    s2.write(LOGIN_PKT_OK);

    const all = await readBytes(s2, 36);
    const cmdFrame = all.slice(10, 36); // los primeros 10 son el ACK del login

    assert.strictEqual(cmdFrame[3], PROTO_SERVER_COMMAND, 'protocol = 0x80');
    assert.strictEqual(cmdFrame.slice(9, 20).toString('ascii'), 'DYD,000000#', 'command text');

    s2.destroy();
  });
});
