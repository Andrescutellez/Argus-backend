/**
 * Unit tests para tcp/gt06Parser.js
 *
 * Usa el módulo nativo node:test (Node.js 18+). Sin dependencias externas.
 * Ejecutar con: node --test tests/gt06Parser.test.js
 *
 * Los paquetes de referencia son del spec GT06 Apéndice B (bóveda Argus).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  crcBuffer,
  parseFrames,
  decodeLogin,
  decodeLocation,
  decodeHeartbeat,
  buildAck,
  buildServerCommand,
  decodeStringResponse,
  PROTO_LOGIN,
  PROTO_LOCATION,
  PROTO_HEARTBEAT,
  PROTO_STRING_RESPONSE,
  PROTO_SERVER_COMMAND,
} = require('../tcp/gt06Parser');

// ─── PAQUETES DE REFERENCIA (spec GT06 Apéndice B) ───────────────────────────

// IMEI estándar GT06: 490154203237518, BCD [49 01 54 20 32 37 51 8F], SN=0002, CRC=2AC3
// Primer nibble = '4' → no activa detección J16; IMEI Luhn-válido.
const LOGIN_PKT    = Buffer.from('78780D01' + '490154203237518F' + '0002' + '2AC3' + '0D0A', 'hex');
const LOGIN_ACK    = Buffer.from('787805010002' + 'EB47' + '0D0A', 'hex');

// IMEI J16 real: 867689067010506, J16-BCD [08 67 68 90 67 01 05 06], SN=0002, CRC=E8C0
// El J16 prepone un nibble 0x0 de padding (IMEI right-aligned en 16 nibbles).
const LOGIN_PKT_J16 = Buffer.from('78780D01' + '0867689067010506' + '0002' + 'E8C0' + '0D0A', 'hex');

// 78 78 1F 12 | 0B 08 1D 11 2E 10 | CF | 02 7A C7 EB | 0C 46 58 49 | 00 | 14 8F | 01 CC | 00 | 28 7D | 00 1F B8 | 00 03 | 80 81 | 0D 0A
const LOCATION_PKT = Buffer.from(
  '78781F12' +
  '0B081D112E10' +  // datetime: 2011-08-29 17:46:16
  'CF' +            // GPS info: 15 satellites
  '027AC7EB' +      // lat raw = 0x027AC7EB
  '0C465849' +      // lon raw = 0x0C465849
  '00' +            // speed = 0
  '148F' +          // course/status: fix, east, north, heading=143
  '01CC' +          // MCC = 460
  '00' +            // MNC = 0
  '287D' +          // LAC = 10365
  '001FB8' +        // CellID = 8120
  '0003' +          // SN = 3
  '8081' +          // CRC
  '0D0A',
  'hex'
);

// 78 78 0A 13 | 44 01 04 00 01 | 00 05 | 08 45 | 0D 0A
const HEARTBEAT_PKT = Buffer.from('78780A134401040001' + '0005' + '0845' + '0D0A', 'hex');
const HEARTBEAT_ACK = Buffer.from('787805130005' + 'AFD5' + '0D0A', 'hex');

// ─── TESTS CRC ───────────────────────────────────────────────────────────────

describe('crcBuffer', () => {
  test('Login ACK CRC: [05 01 00 02] → 0xEB47', () => {
    const input = Buffer.from([0x05, 0x01, 0x00, 0x02]);
    assert.strictEqual(crcBuffer(input), 0xEB47);
  });

  test('Heartbeat ACK CRC: [05 13 00 05] → 0xAFD5', () => {
    const input = Buffer.from([0x05, 0x13, 0x00, 0x05]);
    assert.strictEqual(crcBuffer(input), 0xAFD5);
  });

  test('Buffer vacío → 0 (negado 0xFFFF)', () => {
    // (~0xFFFF) & 0xFFFF = 0x0000
    assert.strictEqual(crcBuffer(Buffer.alloc(0)), 0x0000);
  });

  test('Login CRC input válido', () => {
    // LOGIN_PKT raw.slice(2, 14) = LEN(1) + PROTO(1) + IMEI(8) + SN(2) = 12 bytes
    const input = LOGIN_PKT.slice(2, 14);
    const expected = LOGIN_PKT.readUInt16BE(14);
    assert.strictEqual(crcBuffer(input), expected);
  });

  test('Location CRC input válido', () => {
    const len = LOCATION_PKT[2];
    const input = LOCATION_PKT.slice(2, len + 1);
    const crcOffset = 2 + len - 1;
    const expected = LOCATION_PKT.readUInt16BE(crcOffset);
    assert.strictEqual(crcBuffer(input), expected);
  });

  test('Heartbeat CRC input válido', () => {
    const len = HEARTBEAT_PKT[2];
    const input = HEARTBEAT_PKT.slice(2, len + 1);
    const crcOffset = 2 + len - 1;
    const expected = HEARTBEAT_PKT.readUInt16BE(crcOffset);
    assert.strictEqual(crcBuffer(input), expected);
  });
});

// ─── TESTS parseFrames ────────────────────────────────────────────────────────

describe('parseFrames', () => {
  test('Login PKT completo → 1 frame, crcOk=true', () => {
    const { frames, remaining } = parseFrames(LOGIN_PKT);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].protocol, PROTO_LOGIN);
    assert.strictEqual(frames[0].serial, 0x0002);
    assert.strictEqual(frames[0].crcOk, true);
    assert.strictEqual(remaining.length, 0);
  });

  test('Location PKT completo → 1 frame, crcOk=true', () => {
    const { frames } = parseFrames(LOCATION_PKT);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].protocol, PROTO_LOCATION);
    assert.strictEqual(frames[0].crcOk, true);
  });

  test('Heartbeat PKT completo → 1 frame, crcOk=true', () => {
    const { frames } = parseFrames(HEARTBEAT_PKT);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].protocol, PROTO_HEARTBEAT);
    assert.strictEqual(frames[0].serial, 0x0005);
    assert.strictEqual(frames[0].crcOk, true);
  });

  test('Buffer con dos frames consecutivos → 2 frames', () => {
    const combined = Buffer.concat([LOGIN_PKT, HEARTBEAT_PKT]);
    const { frames, remaining } = parseFrames(combined);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].protocol, PROTO_LOGIN);
    assert.strictEqual(frames[1].protocol, PROTO_HEARTBEAT);
    assert.strictEqual(remaining.length, 0);
  });

  test('Frame incompleto → 0 frames, remaining = todo el buffer', () => {
    // Truncar el paquete a la mitad
    const truncated = LOGIN_PKT.slice(0, 8);
    const { frames, remaining } = parseFrames(truncated);
    assert.strictEqual(frames.length, 0);
    assert.deepStrictEqual(remaining, truncated);
  });

  test('Buffer vacío → 0 frames, remaining vacío', () => {
    const { frames, remaining } = parseFrames(Buffer.alloc(0));
    assert.strictEqual(frames.length, 0);
    assert.strictEqual(remaining.length, 0);
  });

  test('CRC corrupto → crcOk=false (frame sigue presente)', () => {
    const corrupted = Buffer.from(LOGIN_PKT);
    corrupted[14] ^= 0xFF; // corromper byte CRC
    const { frames } = parseFrames(corrupted);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].crcOk, false);
  });

  test('LEN < 5 (malformado) → se descarta, 0 frames', () => {
    // Construir frame con LEN = 3 (inválido)
    const bad = Buffer.from([0x78, 0x78, 0x03, 0x01, 0x00, 0x00, 0x0D, 0x0A]);
    const { frames } = parseFrames(bad);
    assert.strictEqual(frames.length, 0);
  });

  test('Stop bytes incorrectos → se descarta', () => {
    const badStop = Buffer.from(LOGIN_PKT);
    badStop[badStop.length - 1] = 0x00; // alterar 0x0A
    const { frames } = parseFrames(badStop);
    assert.strictEqual(frames.length, 0);
  });

  test('Frame completo + bytes sueltos al final → remaining correcto', () => {
    const extra = Buffer.from([0x78, 0x78]); // inicio de otro frame
    const combined = Buffer.concat([LOGIN_PKT, extra]);
    const { frames, remaining } = parseFrames(combined);
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual(remaining, extra);
  });

  test('Data field correcto (IMEI bytes sin SN/CRC)', () => {
    const { frames } = parseFrames(LOGIN_PKT);
    // dataLen = 0x0D - 5 = 8 (IMEI BCD 8 bytes)
    assert.strictEqual(frames[0].data.length, 8);
    // IMEI 490154203237518 → bytes [49 01 54 20 32 37 51 8F]
    assert.strictEqual(frames[0].data[0], 0x49);
    assert.strictEqual(frames[0].data[7], 0x8F);
  });
});

// ─── TESTS decodeLogin ────────────────────────────────────────────────────────

describe('decodeLogin', () => {
  test('IMEI estándar GT06: bytes [49 01 54 20 32 37 51 8F] → "490154203237518"', () => {
    const data = Buffer.from([0x49, 0x01, 0x54, 0x20, 0x32, 0x37, 0x51, 0x8F]);
    const { imei } = decodeLogin(data);
    assert.strictEqual(imei, '490154203237518');
  });

  test('IMEI J16: bytes [08 67 68 90 67 01 05 06] → "867689067010506" (padding nibble inicial)', () => {
    // El J16 right-alinea el IMEI: primer nibble = 0 (padding), IMEI en nibbles 1-15.
    const data = Buffer.from([0x08, 0x67, 0x68, 0x90, 0x67, 0x01, 0x05, 0x06]);
    const { imei } = decodeLogin(data);
    assert.strictEqual(imei, '867689067010506');
  });

  test('IMEI tiene exactamente 15 dígitos', () => {
    const data = Buffer.from([0x86, 0x51, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23]);
    const { imei } = decodeLogin(data);
    assert.strictEqual(imei.length, 15);
  });

  test('IMEI es solo dígitos (0-9)', () => {
    const data = Buffer.from([0x49, 0x01, 0x54, 0x20, 0x32, 0x37, 0x51, 0x8F]);
    const { imei } = decodeLogin(data);
    assert.match(imei, /^\d{15}$/);
  });

  test('Buffer menor a 8 bytes → lanza error', () => {
    assert.throws(() => decodeLogin(Buffer.from([0x01, 0x02])), /too short/);
  });

  test('Usa data del frame LOGIN_PKT (estándar)', () => {
    const { frames } = parseFrames(LOGIN_PKT);
    const { imei } = decodeLogin(frames[0].data);
    assert.strictEqual(imei, '490154203237518');
  });

  test('Usa data del frame LOGIN_PKT_J16', () => {
    const { frames } = parseFrames(LOGIN_PKT_J16);
    const { imei } = decodeLogin(frames[0].data);
    assert.strictEqual(imei, '867689067010506');
  });
});

// ─── TESTS decodeLocation ────────────────────────────────────────────────────

describe('decodeLocation', () => {
  let loc;

  test('Decodifica correctamente el paquete del spec', () => {
    const { frames } = parseFrames(LOCATION_PKT);
    loc = decodeLocation(frames[0].data);

    // Datetime: 2011-08-29 17:46:16 UTC
    assert.strictEqual(loc.datetime.getUTCFullYear(), 2011);
    assert.strictEqual(loc.datetime.getUTCMonth(), 7); // 0-indexed
    assert.strictEqual(loc.datetime.getUTCDate(), 29);
    assert.strictEqual(loc.datetime.getUTCHours(), 17);
    assert.strictEqual(loc.datetime.getUTCMinutes(), 46);
    assert.strictEqual(loc.datetime.getUTCSeconds(), 16);

    // GPS meta
    assert.strictEqual(loc.satellites, 15);
    assert.strictEqual(loc.hasFix, true);
    assert.strictEqual(loc.isNorth, true);  // North
    assert.strictEqual(loc.isEast, true);   // East (China, lon positivo)

    // Speed
    assert.strictEqual(loc.speed, 0);

    // Heading
    assert.strictEqual(loc.course, 143);

    // LBS
    assert.strictEqual(loc.mcc, 460);
    assert.strictEqual(loc.mnc, 0);
    assert.strictEqual(loc.lac, 10365);
    assert.strictEqual(loc.cellId, 8120);
  });

  test('Latitud en rango razonable (China del spec: ~23°N)', () => {
    const { frames } = parseFrames(LOCATION_PKT);
    loc = decodeLocation(frames[0].data);
    assert.ok(loc.lat > 23.0 && loc.lat < 23.2, `lat=${loc.lat} fuera de rango`);
    assert.ok(loc.lat > 0, 'lat debe ser positiva (Norte)');
  });

  test('Longitud en rango razonable (China del spec: ~114°E)', () => {
    const { frames } = parseFrames(LOCATION_PKT);
    loc = decodeLocation(frames[0].data);
    assert.ok(loc.lon > 114.0 && loc.lon < 115.0, `lon=${loc.lon} fuera de rango`);
    assert.ok(loc.lon > 0, 'lon debe ser positiva (Este)');
  });

  test('Colombia (Oeste, Norte): lon debe ser negativa', () => {
    // Construir data con isWest=true (Bit3=1) → Colombia
    const data = Buffer.alloc(26);
    data[0] = 24; data[1] = 1; data[2] = 15; data[3] = 10; data[4] = 30; data[5] = 0; // datetime
    data[6] = 0xCB; // 11 satélites
    data.writeUInt32BE(0x027AC7EB, 7);  // lat (mismos valores del spec)
    data.writeUInt32BE(0x0C465849, 11); // lon
    data[15] = 50;  // speed
    data[16] = 0x1C; // isWest=1(Bit3), isNorth=1(Bit2), hasFix=1(Bit4) → 0001 1100
    data[17] = 0x00; // heading
    data.writeUInt16BE(406, 18); // MCC Colombia
    data[20] = 2;   // MNC Movistar
    data.writeUInt16BE(0x1000, 21);
    data[23] = 0; data[24] = 0; data[25] = 1; // cellId

    const loc = decodeLocation(data);
    assert.ok(loc.lon < 0, 'Colombia es Oeste → lon negativo');
    assert.ok(loc.lat > 0, 'Norte → lat positiva');
  });

  test('Buffer menor a 26 bytes → lanza error', () => {
    assert.throws(() => decodeLocation(Buffer.alloc(10)), /too short/);
  });
});

// ─── TESTS decodeHeartbeat ────────────────────────────────────────────────────

describe('decodeHeartbeat', () => {
  test('Decodifica correctamente el paquete del spec', () => {
    const { frames } = parseFrames(HEARTBEAT_PKT);
    const hb = decodeHeartbeat(frames[0].data);

    // Spec: 44 01 04 00 01
    assert.strictEqual(hb.terminalInfo,  0x44);
    assert.strictEqual(hb.voltageLevel,  0x01);
    assert.strictEqual(hb.gsmSignal,     0x04);
    assert.strictEqual(hb.alarmType,     0x00);
  });

  test('Buffer menor a 5 bytes → lanza error', () => {
    assert.throws(() => decodeHeartbeat(Buffer.from([0x44, 0x01])), /too short/);
  });
});

// ─── TESTS buildAck ──────────────────────────────────────────────────────────

describe('buildAck', () => {
  test('Login ACK exacto: buildAck(0x01, 2) → spec bytes', () => {
    const ack = buildAck(PROTO_LOGIN, 0x0002);
    assert.deepStrictEqual(ack, LOGIN_ACK);
  });

  test('Heartbeat ACK exacto: buildAck(0x13, 5) → spec bytes', () => {
    const ack = buildAck(PROTO_HEARTBEAT, 0x0005);
    assert.deepStrictEqual(ack, HEARTBEAT_ACK);
  });

  test('ACK tiene exactamente 10 bytes', () => {
    assert.strictEqual(buildAck(PROTO_LOGIN, 1).length, 10);
    assert.strictEqual(buildAck(PROTO_HEARTBEAT, 1).length, 10);
  });

  test('ACK empieza con 78 78', () => {
    const ack = buildAck(PROTO_LOGIN, 1);
    assert.strictEqual(ack[0], 0x78);
    assert.strictEqual(ack[1], 0x78);
  });

  test('ACK termina con 0D 0A', () => {
    const ack = buildAck(PROTO_LOGIN, 1);
    assert.strictEqual(ack[8], 0x0D);
    assert.strictEqual(ack[9], 0x0A);
  });

  test('ACK length byte es 0x05', () => {
    const ack = buildAck(PROTO_HEARTBEAT, 100);
    assert.strictEqual(ack[2], 0x05);
  });

  test('ACK preserva el serial number del frame recibido', () => {
    const serial = 0x1234;
    const ack = buildAck(PROTO_LOGIN, serial);
    assert.strictEqual(ack.readUInt16BE(4), serial);
  });

  test('CRC del ACK es correcto (auto-verificación)', () => {
    const ack = buildAck(PROTO_LOGIN, 0x0002);
    const crcInput = ack.slice(2, 6); // [05 01 00 02]
    const crc = crcBuffer(crcInput);
    const crcInPacket = ack.readUInt16BE(6);
    assert.strictEqual(crc, crcInPacket);
  });
});

// ─── PAQUETES DE REFERENCIA — COMANDOS (spec GT06 Apéndice B) ─────────────────
// DYD server→device: 78 78 15 80 0F 00 01 A9 58 44 59 44 2C 30 30 30 30 30 30 23 00 A0 DC F1 0D 0A
const DYD_CMD_PKT = Buffer.from('787815800F0001A95844594 42C30303030303023 00A0DCF10D0A'.replace(/\s/g, ''), 'hex');
// DYD device→server response: 78 78 18 15 10 00 01 A9 58 44 59 44 3D 53 75 63 63 65 73 73 21 00 02 00 18 91 77 0D 0A
const DYD_RESP_PKT = Buffer.from('7878181510 0001A958 4459443D53756363657373210002 0018 9177 0D0A'.replace(/\s/g, ''), 'hex');
// HFYD server→device: 78 78 16 80 10 00 01 A9 63 48 46 59 44 2C 30 30 30 30 30 30 23 00 A0 7B DC 0D 0A
const HFYD_CMD_PKT = Buffer.from('787816801000 01A963 484659442C303030303030 2300A07BDC0D0A'.replace(/\s/g, ''), 'hex');
// HFYD device→server response: 78 78 19 15 11 00 01 A9 63 48 46 59 44 3D 53 75 63 63 65 73 73 21 00 02 00 1E F8 93 0D 0A
const HFYD_RESP_PKT = Buffer.from('78781915110001A963484659443D5375636365737321000200 1EF8930D0A'.replace(/\s/g, ''), 'hex');

// ─── TESTS buildServerCommand ─────────────────────────────────────────────────

describe('buildServerCommand', () => {
  test('DYD exacto: serverFlag=0x0001A958, serial=0x00A0 → spec bytes', () => {
    const frame = buildServerCommand('DYD,000000#', 0x0001A958, 0x00A0);
    assert.deepStrictEqual(frame, DYD_CMD_PKT);
  });

  test('HFYD exacto: serverFlag=0x0001A963, serial=0x00A0 → spec bytes', () => {
    const frame = buildServerCommand('HFYD,000000#', 0x0001A963, 0x00A0);
    assert.deepStrictEqual(frame, HFYD_CMD_PKT);
  });

  test('Frame empieza con 78 78', () => {
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    assert.strictEqual(frame[0], 0x78);
    assert.strictEqual(frame[1], 0x78);
  });

  test('Frame termina con 0D 0A', () => {
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    assert.strictEqual(frame[frame.length - 2], 0x0D);
    assert.strictEqual(frame[frame.length - 1], 0x0A);
  });

  test('Protocol byte = 0x80', () => {
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    assert.strictEqual(frame[3], PROTO_SERVER_COMMAND);
  });

  test('LEN correcto: M=11 → LEN=21', () => {
    // 'DYD,000000#' = 11 chars → LEN = 11+10 = 21
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    assert.strictEqual(frame[2], 21);
  });

  test('LEN correcto: M=12 → LEN=22', () => {
    // 'HFYD,000000#' = 12 chars → LEN = 12+10 = 22
    const frame = buildServerCommand('HFYD,000000#', 1, 1);
    assert.strictEqual(frame[2], 22);
  });

  test('CMD_LEN correcto: DYD → 4+11=15', () => {
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    assert.strictEqual(frame[4], 15);
  });

  test('SERVER_FLAG se escribe correctamente en big-endian', () => {
    const frame = buildServerCommand('DYD,000000#', 0xDEADBEEF, 1);
    assert.strictEqual(frame.readUInt32BE(5), 0xDEADBEEF);
  });

  test('COMMAND_ASCII correcto (DYD,000000#)', () => {
    const frame = buildServerCommand('DYD,000000#', 1, 1);
    const text = frame.slice(9, 9 + 11).toString('ascii');
    assert.strictEqual(text, 'DYD,000000#');
  });

  test('CRC se auto-verifica: parseFrames puede parsear el frame generado', () => {
    const frame = buildServerCommand('DYD,000000#', 0x0001A958, 0x00A0);
    const { frames } = parseFrames(frame);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].crcOk, true);
    assert.strictEqual(frames[0].protocol, PROTO_SERVER_COMMAND);
  });

  test('Total bytes: DYD (M=11) → 26 bytes', () => {
    assert.strictEqual(buildServerCommand('DYD,000000#', 1, 1).length, 26);
  });

  test('Total bytes: HFYD (M=12) → 27 bytes', () => {
    assert.strictEqual(buildServerCommand('HFYD,000000#', 1, 1).length, 27);
  });
});

// ─── TESTS decodeStringResponse ───────────────────────────────────────────────

describe('decodeStringResponse', () => {
  test('DYD=Success!: serverFlag=0x0001A958, text correcto, language=2', () => {
    const { frames } = parseFrames(DYD_RESP_PKT);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].protocol, PROTO_STRING_RESPONSE);
    assert.strictEqual(frames[0].crcOk, true);

    const resp = decodeStringResponse(frames[0].data);
    assert.strictEqual(resp.serverFlag, 0x0001A958);
    assert.strictEqual(resp.text, 'DYD=Success!');
    assert.strictEqual(resp.language, 2); // Inglés
  });

  test('HFYD=Success!: serverFlag=0x0001A963, text correcto', () => {
    const { frames } = parseFrames(HFYD_RESP_PKT);
    const resp = decodeStringResponse(frames[0].data);
    assert.strictEqual(resp.serverFlag, 0x0001A963);
    assert.strictEqual(resp.text, 'HFYD=Success!');
  });

  test('Buffer menor a 7 bytes → lanza error', () => {
    assert.throws(() => decodeStringResponse(Buffer.from([0x10, 0x00, 0x01])), /too short/);
  });

  test('Buffer truncado (data.length < 1 + cmdLen + 2) → lanza error', () => {
    // cmdLen = 16 → necesita 1+16+2 = 19 bytes; pasar solo 10
    const bad = Buffer.alloc(10);
    bad[0] = 16; // cmdLen
    assert.throws(() => decodeStringResponse(bad), /truncated/);
  });
});
