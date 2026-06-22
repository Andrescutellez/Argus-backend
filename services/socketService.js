/**
 * @fileoverview Singleton de Socket.io para acceso desde controllers REST.
 *
 * PROPÓSITO:
 *   El servidor http + io se crea en server.js, pero los controllers necesitan
 *   emitir eventos sin importar server.js (dependencia circular). Este módulo
 *   actúa como puente: server.js llama setIo(io) al arrancar, y cualquier
 *   controller llama getIo() cuando necesita emitir.
 *
 * PATRÓN:
 *   Module-level singleton — la instancia vive en el scope del módulo de Node,
 *   que es un singleton por proceso. Seguro en un servidor single-process.
 *
 * @module services/socketService
 */

'use strict';

let _io = null;

/**
 * @brief Registra la instancia de Socket.io. Llamar una sola vez desde server.js.
 * @param {import('socket.io').Server} io
 */
function setIo(io) {
  _io = io;
}

/**
 * @brief Retorna la instancia activa de Socket.io, o null antes de setIo().
 * @returns {import('socket.io').Server|null}
 */
function getIo() {
  return _io;
}

module.exports = { setIo, getIo };
