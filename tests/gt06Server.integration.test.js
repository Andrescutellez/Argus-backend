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

// Ahora cargar el servidor con los mocks aplicados
const { startGt06Server, gt06ConnectedDevices } = require('../tcp/gt06Server');
const { buildAck, PROTO_LOGIN, PROTO_HEARTBEAT } = require('../tcp/gt06Parser');

// ─── PAQUETES DE REFERENCIA ──────────────────────────────────────────────────

// Login: 78 78 0D 01 | IMEI[8] | SN(2) | CRC(2) | 0D 0A
// IMEI BCD "035341353215036" → [03 53 41 35 32 15 03 62], SN=0x0002, CRC=0x2D06
const LOGIN_PKT    = Buffer.from('78780D010353413532150362000220D060D0A'.replace(/\s|[^0-9A-Fa-f]/g, ''), 'hex');

// Reconstruir LOGIN_PKT correctamente con CRC real
// Login: 78 78 0D 01 03534135321503620002 2D06 0D0A
const LOGIN_PKT_OK = Buffer.from('78780D010353413532150362' + '0002' + '2D06' + '0D0A', 'hex');

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
});

// ─── TESTS ───────────────────────────────────────────────────────────────────

describe('GT06 Server — flujo completo', () => {

  test('Login con IMEI válido → responde ACK correcto', async () => {
    const socket = await connect();

    socket.write(LOGIN_PKT_OK);
    const response = await readBytes(socket, 10); // ACK = 10 bytes

    const expectedAck = buildAck(PROTO_LOGIN, 0x0002);
    assert.deepStrictEqual(response, expectedAck);

    // isAllowed fue llamado con el IMEI correcto
    assert.strictEqual(mockState.isAllowedImei, '035341353215036');

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

    // IMEI
    assert.strictEqual(point.deviceId, '035341353215036');

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
