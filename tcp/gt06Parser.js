/**
 * @fileoverview Parser binario puro del protocolo GT06 (GPS OEM chino, Concox y clones).
 *
 * Este módulo no tiene efectos secundarios: no escribe a BD, no emite socket.io,
 * no llama a servicios externos. Solo convierte bytes crudos en estructuras JavaScript.
 * Separarlo del servidor permite testear la lógica de parsing de forma completamente
 * aislada sin levantar TCP ni MongoDB.
 *
 * Protocolo GT06 — estructura de frame:
 *   78 78 | LEN | PROTO | DATA(N) | SN(2) | CRC(2) | 0D 0A
 *   - LEN cubre: PROTO(1) + DATA(N) + SN(2) + CRC(2) = N + 5
 *   - CRC-ITU cubre desde el byte LEN hasta el último byte de SN inclusive
 *   - N = LEN - 5 (bytes de información pura, sin proto/SN/CRC)
 *
 * @module tcp/gt06Parser
 *
 * VARIABLES CRÍTICAS:
 *   - CRC_TABLE: tabla CRC-ITU de 256 entradas, extraída del Apéndice A del spec GT06.
 *     Si se altera un solo valor, todos los CRC calculados serán inválidos.
 *   - El byte LEN incluye proto + SN + CRC (5 bytes fijos): N = LEN - 5.
 *     Confundir LEN como solo la longitud del payload DATA es un error frecuente.
 *
 * RIESGOS:
 *   - Buffer fuera de límites si LEN está mal formado. parseFrames() verifica
 *     que el buffer sea suficientemente largo antes de leer.
 *   - La firma de JavaScript >> vs >>> para desplazamiento de bits:
 *     usar >>> (unsigned right shift) en crcBuffer para evitar extensión de signo.
 */

'use strict';

// ─── CRC-ITU TABLE (GT06 spec Apéndice A) ───────────────────────────────────
// 256 entradas uint16. Init fcs=0xFFFF, resultado = ~fcs & 0xFFFF.
// Cubre desde el byte Length hasta el último byte del Serial Number, inclusive.
const CRC_TABLE = [
  0x0000, 0x1189, 0x2312, 0x329B, 0x4624, 0x57AD, 0x6536, 0x74BF,
  0x8C48, 0x9DC1, 0xAF5A, 0xBED3, 0xCA6C, 0xDBE5, 0xE97E, 0xF8F7,
  0x1081, 0x0108, 0x3393, 0x221A, 0x56A5, 0x472C, 0x75B7, 0x643E,
  0x9CC9, 0x8D40, 0xBFDB, 0xAE52, 0xDAED, 0xCB64, 0xF9FF, 0xE876,
  0x2102, 0x308B, 0x0210, 0x1399, 0x6726, 0x76AF, 0x4434, 0x55BD,
  0xAD4A, 0xBCC3, 0x8E58, 0x9FD1, 0xEB6E, 0xFAE7, 0xC87C, 0xD9F5,
  0x3183, 0x200A, 0x1291, 0x0318, 0x77A7, 0x662E, 0x54B5, 0x453C,
  0xBDCB, 0xAC42, 0x9ED9, 0x8F50, 0xFBEF, 0xEA66, 0xD8FD, 0xC974,
  0x4204, 0x538D, 0x6116, 0x709F, 0x0420, 0x15A9, 0x2732, 0x36BB,
  0xCE4C, 0xDFC5, 0xED5E, 0xFCD7, 0x8868, 0x99E1, 0xAB7A, 0xBAF3,
  0x5285, 0x430C, 0x7197, 0x601E, 0x14A1, 0x0528, 0x37B3, 0x263A,
  0xDECD, 0xCF44, 0xFDDF, 0xEC56, 0x98E9, 0x8960, 0xBBFB, 0xAA72,
  0x6306, 0x728F, 0x4014, 0x519D, 0x2522, 0x34AB, 0x0630, 0x17B9,
  0xEF4E, 0xFEC7, 0xCC5C, 0xDDD5, 0xA96A, 0xB8E3, 0x8A78, 0x9BF1,
  0x7387, 0x620E, 0x5095, 0x411C, 0x35A3, 0x242A, 0x16B1, 0x0738,
  0xFFCF, 0xEE46, 0xDCDD, 0xCD54, 0xB9EB, 0xA862, 0x9AF9, 0x8B70,
  0x8408, 0x9581, 0xA71A, 0xB693, 0xC22C, 0xD3A5, 0xE13E, 0xF0B7,
  0x0840, 0x19C9, 0x2B52, 0x3ADB, 0x4E64, 0x5FED, 0x6D76, 0x7CFF,
  0x9489, 0x8500, 0xB79B, 0xA612, 0xD2AD, 0xC324, 0xF1BF, 0xE036,
  0x18C1, 0x0948, 0x3BD3, 0x2A5A, 0x5EE5, 0x4F6C, 0x7DF7, 0x6C7E,
  0xA50A, 0xB483, 0x8618, 0x9791, 0xE32E, 0xF2A7, 0xC03C, 0xD1B5,
  0x2942, 0x38CB, 0x0A50, 0x1BD9, 0x6F66, 0x7EEF, 0x4C74, 0x5DFD,
  0xB58B, 0xA402, 0x9699, 0x8710, 0xF3AF, 0xE226, 0xD0BD, 0xC134,
  0x39C3, 0x284A, 0x1AD1, 0x0B58, 0x7FE7, 0x6E6E, 0x5CF5, 0x4D7C,
  0xC60C, 0xD785, 0xE51E, 0xF497, 0x8028, 0x91A1, 0xA33A, 0xB2B3,
  0x4A44, 0x5BCD, 0x6956, 0x78DF, 0x0C60, 0x1DE9, 0x2F72, 0x3EFB,
  0xD68D, 0xC704, 0xF59F, 0xE416, 0x90A9, 0x8120, 0xB3BB, 0xA232,
  0x5AC5, 0x4B4C, 0x79D7, 0x685E, 0x1CE1, 0x0D68, 0x3FF3, 0x2E7A,
  0xE70E, 0xF687, 0xC41C, 0xD595, 0xA12A, 0xB0A3, 0x8238, 0x93B1,
  0x6B46, 0x7ACF, 0x4854, 0x59DD, 0x2D62, 0x3CEB, 0x0E70, 0x1FF9,
  0xF78F, 0xE606, 0xD49D, 0xC514, 0xB1AB, 0xA022, 0x92B9, 0x8330,
  0x7BC7, 0x6A4E, 0x58D5, 0x495C, 0x3DE3, 0x2C6A, 0x1EF1, 0x0F78,
];

// ─── PROTOCOL NUMBERS ────────────────────────────────────────────────────────
const PROTO_LOGIN           = 0x01;
const PROTO_LOCATION        = 0x12;
const PROTO_HEARTBEAT       = 0x13;
const PROTO_STRING_RESPONSE = 0x15; // Terminal → Servidor: respuesta a comando del servidor
const PROTO_ALARM           = 0x16; // Terminal → Servidor: alarma con GPS fix (Fase 3)
const PROTO_POWER_ALARM     = 0x18; // Terminal → Servidor: alarma de alimentación (puede ser sin GPS fix)
const PROTO_SERVER_COMMAND  = 0x80; // Servidor → Terminal: comando SMS (DYD/HFYD/DWXX)

/**
 * @brief CRC-ITU-T (CRC-16) sobre un Buffer.
 *
 * Implementa el algoritmo del Apéndice A del spec GT06.
 * El >>> (unsigned right shift) es crítico: >> extiende el bit de signo en
 * JavaScript, corrompiendo el resultado cuando fcs >= 0x8000.
 *
 * @param {Buffer} buf
 * @returns {number} uint16 (0x0000..0xFFFF)
 */
function crcBuffer(buf) {
  let fcs = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    fcs = (fcs >>> 8) ^ CRC_TABLE[(fcs ^ buf[i]) & 0xFF];
  }
  return (~fcs) & 0xFFFF;
}

/**
 * @brief Extrae frames GT06 completos de un buffer TCP acumulado.
 *
 * TCP no garantiza que un frame llegue completo en un solo evento 'data'.
 * Este parser acumula bytes y extrae frames completos; los bytes sobrantes
 * se devuelven como 'remaining' para concatenarlos con el próximo 'data'.
 *
 * Ante bytes malformados (start sin stop válido, LEN < 5) avanza byte a byte
 * buscando el próximo marcador 0x78 0x78 en lugar de tirar toda la conexión.
 *
 * @param {Buffer} buf - Buffer acumulado del socket
 * @returns {{
 *   frames: Array<{protocol: number, serial: number, data: Buffer, raw: Buffer, crcOk: boolean}>,
 *   remaining: Buffer
 * }}
 */
function parseFrames(buf) {
  const frames = [];
  let offset = 0;

  while (offset < buf.length) {
    // Necesitamos al menos 2 bytes para revisar el marcador de inicio
    if (offset + 2 > buf.length) break;

    if (buf[offset] !== 0x78 || buf[offset + 1] !== 0x78) {
      offset++;
      continue;
    }

    // Necesitamos al menos 3 bytes para leer el Length
    if (offset + 3 > buf.length) break;

    const lengthByte = buf[offset + 2];

    // Length mínimo válido: PROTO(1) + SN(2) + CRC(2) = 5
    if (lengthByte < 5) {
      offset += 2;
      continue;
    }

    // Frame total: 2(start) + 1(length) + lengthByte(content) + 2(stop)
    const totalBytes = lengthByte + 5;
    if (offset + totalBytes > buf.length) break; // Frame incompleto, esperar más datos

    // Verificar stop bytes 0x0D 0x0A
    const stopAt = offset + totalBytes - 2;
    if (buf[stopAt] !== 0x0D || buf[stopAt + 1] !== 0x0A) {
      // Frame malformado: avanzar para buscar el próximo marcador
      offset += 2;
      continue;
    }

    const raw      = buf.slice(offset, offset + totalBytes);
    const protocol = raw[3];
    const dataLen  = lengthByte - 5; // bytes de DATA pura (sin proto, SN, CRC)
    const data     = raw.slice(4, 4 + dataLen);
    const serial   = raw.readUInt16BE(4 + dataLen);
    const crcExp   = raw.readUInt16BE(4 + dataLen + 2);

    // CRC cubre desde LEN hasta último byte de SN: raw.slice(2, 2 + lengthByte - 1)
    const crcOk = (crcBuffer(raw.slice(2, lengthByte + 1)) === crcExp);

    frames.push({ protocol, serial, data, raw, crcOk });
    offset += totalBytes;
  }

  return { frames, remaining: buf.slice(offset) };
}

/**
 * @brief Validación Luhn para strings de dígitos (IMEI checksum estándar).
 * @param {string} str - 15 dígitos
 * @returns {boolean}
 */
function luhnCheck(str) {
  let sum = 0;
  let dbl = false;
  for (let i = str.length - 1; i >= 0; i--) {
    let d = parseInt(str[i], 10);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * @brief Decodifica el Login Packet (Protocol 0x01).
 *
 * IMEI en BCD: 8 bytes = 16 nibbles, 15 dígitos útiles.
 * GT06 estándar: IMEI left-aligned, padding nibble al final (0x0 o 0xF).
 * J16 y algunos Concox: IMEI right-aligned, padding nibble 0x0 al inicio.
 *
 * Detección del encoding J16: primer nibble = '0', IMEI estándar falla Luhn,
 * IMEI desplazado (nibbles 1-15) pasa Luhn → retorna el desplazado.
 *
 * @param {Buffer} data - Campo DATA del frame (8 bytes)
 * @returns {{ imei: string }} IMEI de 15 dígitos como string
 * @throws {Error} si data tiene menos de 8 bytes
 */
function decodeLogin(data) {
  if (data.length < 8) throw new Error(`Login data too short: ${data.length}`);

  let nibbles = '';
  for (let i = 0; i < 8; i++) {
    nibbles += ((data[i] >> 4) & 0x0F).toString(16);
    nibbles += (data[i] & 0x0F).toString(16);
  }

  const standard = nibbles.slice(0, 15);

  // J16 padding detection: skip the leading 0 nibble if standard parse fails Luhn
  // and the shifted version passes — avoids misreading real IMEIs starting with 0
  if (nibbles[0] === '0' && !luhnCheck(standard)) {
    const shifted = nibbles.slice(1, 16);
    if (luhnCheck(shifted)) return { imei: shifted };
  }

  return { imei: standard };
}

/**
 * @brief Decodifica el Location Data Packet (Protocol 0x12).
 *
 * Conversión de coordenadas GT06 a WGS-84 decimal degrees:
 *   raw = (grados * 60 + minutos) * 30000
 *   → lat_minutes = raw / 30000
 *   → lat_dd = floor(lat_min / 60) + (lat_min % 60) / 60
 *
 * El bit Course/Status Bit3=1 indica Oeste (longitud negativa para Colombia).
 * El bit Bit2=1 indica Norte (latitud positiva para Colombia).
 *
 * @param {Buffer} data - Campo DATA del frame (26 bytes mínimo)
 * @returns {{
 *   datetime: Date, lat: number, lon: number, speed: number, course: number,
 *   satellites: number, hasFix: boolean, isNorth: boolean, isEast: boolean,
 *   mcc: number, mnc: number, lac: number, cellId: number
 * }}
 * @throws {Error} si data tiene menos de 26 bytes
 */
function decodeLocation(data) {
  if (data.length < 26) throw new Error(`Location data too short: ${data.length}`);

  let off = 0;

  // Fecha/hora: cada byte es el valor directo (hex = valor decimal)
  const year  = 2000 + data[off++];
  const month =        data[off++];
  const day   =        data[off++];
  const hour  =        data[off++];
  const min   =        data[off++];
  const sec   =        data[off++];
  const datetime = new Date(Date.UTC(year, month - 1, day, hour, min, sec));

  // GPS Info byte: nibble alto = GPS info length (ignorado en Fase 1), nibble bajo = satélites
  const satellites = data[off++] & 0x0F;

  // Lat/Lon raw uint32 big-endian
  const latRaw = data.readUInt32BE(off); off += 4;
  const lonRaw = data.readUInt32BE(off); off += 4;

  // Speed 1 byte km/h
  const speed = data[off++];

  // Course/Status 2 bytes
  const csB1   = data[off++];
  const csB2   = data[off++];
  const hasFix = !!(csB1 & 0x10); // Bit4 = GPS fix
  const isWest = !!(csB1 & 0x08); // Bit3 = 1 → West
  const isNorth= !!(csB1 & 0x04); // Bit2 = 1 → North
  const course = ((csB1 & 0x03) << 8) | csB2;

  // LBS: MCC(2) + MNC(1) + LAC(2) + CellID(3)
  const mcc    = data.readUInt16BE(off); off += 2;
  const mnc    = data[off++];
  const lac    = data.readUInt16BE(off); off += 2;
  const cellId = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2];

  // Conversión a decimal degrees
  const latMin = latRaw / 30000.0;
  const lonMin = lonRaw / 30000.0;
  const latDd  = Math.floor(latMin / 60) + (latMin % 60) / 60;
  const lonDd  = Math.floor(lonMin / 60) + (lonMin % 60) / 60;

  return {
    datetime,
    lat: isNorth ? latDd : -latDd,
    lon: isWest  ? -lonDd : lonDd,  // Colombia es Oeste → lon negativo
    speed,
    course,
    satellites,
    hasFix,
    isNorth,
    isEast: !isWest,
    mcc,
    mnc,
    lac,
    cellId,
  };
}

/**
 * @brief Decodifica el Heartbeat / Status Packet (Protocol 0x13).
 *
 * @param {Buffer} data - Campo DATA del frame (5 bytes)
 * @returns {{ terminalInfo: number, voltageLevel: number, gsmSignal: number, alarmType: number }}
 * @throws {Error} si data tiene menos de 5 bytes
 */
function decodeHeartbeat(data) {
  if (data.length < 5) throw new Error(`Heartbeat data too short: ${data.length}`);
  return {
    terminalInfo:  data[0],
    voltageLevel:  data[1],
    gsmSignal:     data[2],
    alarmType:     data[3], // byte 1 de ALARM/LANGUAGE
  };
}

/**
 * @brief Decodifica el Alarm Information Packet (Protocol 0x16) y el Power Alarm (0x18).
 *
 * PROPÓSITO:
 *   El J16 emite 0x16 cuando se dispara una alarma con GPS fix. La estructura es
 *   idéntica al Location Packet (0x12) pero con dos bytes adicionales al final:
 *   byte 31 = alarm type y byte 32 = idioma. Para 0x18 (sin GPS fix) la estructura
 *   puede ser más corta; se usa el mismo parser leyendo solo hasta alarm type.
 *
 * ALARM TYPES confirmados en producción (J16 firmware GT06_DK12):
 *   0x00 = movimiento suave (Defense:ON)  — log silencioso, no alertar
 *   0x02 = fuente externa cortada         — push crítico
 *   0x03 = golpe/vibración fuerte         — push alarma
 *
 * ESTRUCTURA DATA (32 bytes para 0x16):
 *   [0-5]   YY MM DD HH MM SS  (datetime)
 *   [6]     GPS info byte (nibble alto = GPS info len, nibble bajo = satélites)
 *   [7-10]  lat uint32 BE (raw / 30000 = minutos → convertir a decimal degrees)
 *   [11-14] lon uint32 BE
 *   [15]    speed km/h
 *   [16-17] course + status flags (bit3 de [16] = isWest, bit2 = isNorth)
 *   [18]    LBS tag (0x09)
 *   [19-20] MCC
 *   [21]    MNC
 *   [22-23] LAC
 *   [24-26] CellID (3 bytes)
 *   [27]    GSM signal
 *   [28-29] flags adicionales
 *   [30]    *** ALARM TYPE ***
 *   [31]    idioma (0x02 = chino)
 *
 * DEPENDENCIAS: ninguna externa (solo Buffer)
 *
 * @param {Buffer} data - Campo DATA del frame (mínimo 31 bytes para leer alarm type)
 * @returns {{
 *   datetime: Date, lat: number, lon: number, speed: number,
 *   hasFix: boolean, alarmType: number
 * }}
 * @throws {Error} si data tiene menos de 31 bytes
 */
function decodeAlarm(data) {
  if (data.length < 31) throw new Error(`Alarm data too short: ${data.length}`);

  const year   = 2000 + data[0];
  const month  = data[1];
  const day    = data[2];
  const hour   = data[3];
  const minute = data[4];
  const second = data[5];
  const datetime = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const latRaw = data.readUInt32BE(7);
  const lonRaw = data.readUInt32BE(11);
  const speed  = data[15];
  const csB1   = data[16];
  const hasFix = !!(csB1 & 0x10);
  const isWest = !!(csB1 & 0x08);
  const isNorth= !!(csB1 & 0x04);

  const latMin = latRaw / 30000.0;
  const lonMin = lonRaw / 30000.0;
  const latDd  = Math.floor(latMin / 60) + (latMin % 60) / 60;
  const lonDd  = Math.floor(lonMin / 60) + (lonMin % 60) / 60;

  const alarmType = data[30];

  return {
    datetime,
    lat:       isNorth ? latDd : -latDd,
    lon:       isWest  ? -lonDd : lonDd,
    speed,
    hasFix,
    alarmType,
  };
}

/**
 * @brief Construye un paquete ACK para Login (0x01) o Heartbeat (0x13).
 *
 * El device GT06 reconecta si no recibe ACK en 5 segundos. Esta función
 * genera el buffer de respuesta exacto según el spec.
 *
 * Formato: 78 78 | 05 | PROTO | SN(2) | CRC(2) | 0D 0A  (10 bytes total)
 *
 * @param {number} protocol - 0x01 (Login) o 0x13 (Heartbeat)
 * @param {number} serial   - serial number del paquete recibido (uint16)
 * @returns {Buffer} 10 bytes listos para socket.write()
 */
function buildAck(protocol, serial) {
  const ack = Buffer.alloc(10);
  ack[0] = 0x78;
  ack[1] = 0x78;
  ack[2] = 0x05; // Length: proto(1) + SN(2) + CRC(2) = 5
  ack[3] = protocol;
  ack.writeUInt16BE(serial & 0xFFFF, 4);
  // CRC cubre raw.slice(2, 6) = [05 PROTO SN0 SN1]
  ack.writeUInt16BE(crcBuffer(ack.slice(2, 6)), 6);
  ack[8] = 0x0D;
  ack[9] = 0x0A;
  return ack;
}

/**
 * @brief Construye un frame de comando del servidor (Protocol 0x80) para enviar
 *        texto SMS-like al terminal GT06.
 *
 * PROPÓSITO:
 *   El servidor usa este frame para enviar comandos como `DYD,000000#`
 *   (cortar motor) o `HFYD,000000#` (restaurar motor). El terminal lo ejecuta
 *   como si fuera un SMS recibido y responde con un frame 0x15 con el resultado.
 *
 * ESTRUCTURA DEL FRAME:
 *   78 78 | LEN | 80 | CMD_LEN | SERVER_FLAG(4) | COMMAND_ASCII(M) | SN(2) | CRC(2) | 0D 0A
 *   - CMD_LEN = 4 (SERVER_FLAG) + M (texto del comando)
 *   - LEN = PROTO(1) + CMD_LEN_byte(1) + SERVER_FLAG(4) + M + SN(2) + CRC(2) = M + 10
 *   - CRC cubre desde LEN hasta último byte de SN (igual que todos los frames GT06)
 *
 * VERIFICACIÓN contra spec Apéndice B (DYD, M=11):
 *   LEN = 11+10 = 21 = 0x15 ✓, CMD_LEN = 11+4 = 15 = 0x0F ✓, total = 26 bytes ✓
 *
 * DEPENDENCIAS:
 *   - crcBuffer(): CRC-ITU sobre el rango LEN→SN
 *
 * @param {string} commandText - Comando ASCII, e.g. 'DYD,000000#'
 * @param {number} serverFlag  - uint32 devuelto sin cambio en la respuesta 0x15 (correlación)
 * @param {number} serial      - uint16, número de serie del frame (SN)
 * @returns {Buffer} Frame completo listo para socket.write()
 */
function buildServerCommand(commandText, serverFlag, serial) {
  const cmd = Buffer.from(commandText, 'ascii');
  const M   = cmd.length;
  // LEN = PROTO(1) + DATA(1+4+M) + SN(2) + CRC(2) = M + 10
  const len = M + 10;
  const buf = Buffer.alloc(M + 15); // total: 2(start) + 1(LEN) + len + 2(stop)

  buf[0] = 0x78;
  buf[1] = 0x78;
  buf[2] = len;
  buf[3] = 0x80;          // Protocol: Server Command
  buf[4] = M + 4;         // CMD_LEN = SERVER_FLAG(4) + command(M)
  buf.writeUInt32BE(serverFlag >>> 0, 5);  // SERVER_FLAG: terminal lo devuelve igual
  cmd.copy(buf, 9);                         // COMMAND_ASCII
  buf.writeUInt16BE(serial & 0xFFFF, 9 + M);
  // CRC: desde LEN (índice 2) hasta último byte de SN (índice 9+M+1), exclusive
  buf.writeUInt16BE(crcBuffer(buf.slice(2, 9 + M + 2)), 9 + M + 2);
  buf[9 + M + 4] = 0x0D;
  buf[9 + M + 5] = 0x0A;
  return buf;
}

/**
 * @brief Decodifica el campo DATA de un frame 0x15 (String Response) enviado por el terminal.
 *
 * PROPÓSITO:
 *   El terminal responde con 0x15 después de recibir un 0x80 del servidor.
 *   El campo `text` contiene el resultado del comando, e.g.:
 *   - `DYD=Success!`     → motor cortado exitosamente
 *   - `DYD=Speed Limit`  → rechazado (velocidad > 20 km/h)
 *   - `HFYD=Success!`    → motor restaurado
 *   - `HFYD=Fail!`       → falla al restaurar
 *
 * ESTRUCTURA DATA del frame 0x15:
 *   CMD_LEN(1) | SERVER_FLAG(4) | response_text(CMD_LEN-4) | LANGUAGE(2)
 *   El SERVER_FLAG es el mismo que envió el servidor en el 0x80 correspondiente.
 *
 * DEPENDENCIAS: ninguna (solo lectura de Buffer)
 *
 * @param {Buffer} data - Campo DATA del frame (mínimo 7 bytes)
 * @returns {{ serverFlag: number, text: string, language: number }}
 * @throws {Error} si data es demasiado corto o está truncado
 */
function decodeStringResponse(data) {
  if (data.length < 7) throw new Error(`String response too short: ${data.length}`);
  const cmdLen = data[0];
  if (data.length < 1 + cmdLen + 2) throw new Error(`String response truncated: data=${data.length}, expected=${1 + cmdLen + 2}`);
  const serverFlag = data.readUInt32BE(1);
  const textLen    = cmdLen - 4;
  const text       = data.slice(5, 5 + textLen).toString('ascii');
  const language   = data.readUInt16BE(5 + textLen);
  return { serverFlag, text, language };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  PROTO_LOGIN,
  PROTO_LOCATION,
  PROTO_HEARTBEAT,
  PROTO_STRING_RESPONSE,
  PROTO_ALARM,
  PROTO_POWER_ALARM,
  PROTO_SERVER_COMMAND,
  crcBuffer,
  parseFrames,
  decodeLogin,
  decodeLocation,
  decodeHeartbeat,
  decodeAlarm,
  buildAck,
  buildServerCommand,
  decodeStringResponse,
};


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/gt06Parser.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Parser binario puro del protocolo GT06 usado por rastreadores GPS OEM
   chinos. Convierte bytes crudos TCP en objetos JavaScript. No tiene
   efectos secundarios: solo parsea y devuelve datos, sin tocar BD,
   sockets ni servicios externos. Esto permite testear la lógica de
   parsing de forma completamente aislada.

   PSEUDOCÓDIGO:
   parseFrames(buf):
     → busca marcador 78 78 en el buffer
     → lee LEN byte, verifica que el buffer tenga LEN+5 bytes disponibles
     → verifica stop bytes 0D 0A
     → extrae protocol, data, serial, CRC
     → verifica CRC-ITU
     → devuelve { frames[], remaining }

   decodeLogin(data):
     → 8 bytes BCD → 15 dígitos IMEI como string

   decodeLocation(data):
     → 6 bytes datetime + 1 GPS info + 4 lat + 4 lon + 1 speed + 2 course
       + 2 MCC + 1 MNC + 2 LAC + 3 CellID
     → coordenadas en decimal degrees WGS-84

   DIAGRAMA MENTAL:
   TCP socket bytes → [parseFrames] → Frame[]
                                          ↓
   frame.protocol = 0x01 → [decodeLogin]    → { imei }
   frame.protocol = 0x12 → [decodeLocation] → { lat, lon, speed, ... }
   frame.protocol = 0x13 → [decodeHeartbeat] → { voltageLevel, gsmSignal, ... }
   ↓
   [buildAck(0x01/0x13, serial)] → Buffer → socket.write()

   VARIABLES CRÍTICAS:
   - CRC_TABLE: 256 uint16, del spec Apéndice A. Error en cualquier entrada
     → CRC inválido para todo el protocolo.
   - LEN byte: incluye proto+SN+CRC (5 bytes fijos). N = LEN - 5.
   - Fórmula lat/lon: raw = (grados*60+minutos)*30000. Invertir correctamente.

   DEUDA TÉCNICA:
   - El Alarm Packet (0x16) no está implementado (Fase 3).
   - No se parsea el GPS info length del nibble alto del byte GPS Info.

   ═══════════════════════════════════════════════════════════ */
