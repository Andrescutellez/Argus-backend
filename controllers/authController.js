/**
 * @fileoverview Controlador REST para registro, login y perfil de usuario.
 *
 * PROPÓSITO:
 *   Gestionar el ciclo de vida de autenticación: crear cuentas (register),
 *   verificar credenciales y emitir JWT (login), y retornar el perfil del
 *   usuario autenticado (me).
 *
 * FLUJO DE REGISTRO:
 *   1. Validar email y contraseña presentes.
 *   2. Verificar que el email no esté registrado.
 *   3. Hashear la contraseña con bcrypt (cost 12).
 *   4. Crear el usuario en PostgreSQL.
 *   5. Si se pasa deviceId, asociarlo al usuario.
 *   6. Emitir JWT con payload { sub, email, role, deviceIds }.
 *
 * FLUJO DE LOGIN:
 *   1. Buscar usuario por email.
 *   2. Comparar contraseña con bcrypt.compare().
 *   3. Cargar deviceIds del usuario.
 *   4. Emitir JWT.
 *
 * VARIABLES CRÍTICAS:
 *   JWT_SECRET: clave para firmar tokens — NUNCA hardcodear, leer de process.env.
 *   JWT_EXPIRES_IN: expiración del token (default '7d').
 *   BCRYPT_ROUNDS: factor de costo de bcrypt. 12 = ~300ms en hardware moderno.
 *     Menor = más rápido pero menos seguro. Mayor = lento para el usuario.
 *
 * @module controllers/authController
 */

'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');

const BCRYPT_ROUNDS = 12;
const SECRET        = process.env.JWT_SECRET;
const EXPIRES_IN    = process.env.JWT_EXPIRES_IN || '7d';

/**
 * @brief Genera un JWT firmado con el payload del usuario.
 *
 * PAYLOAD INCLUIDO:
 *   sub:       UUID del usuario (identificador único, convención RFC 7519)
 *   email:     correo electrónico
 *   role:      'USER' | 'ADMIN' | 'SUPER_ADMIN'
 *   deviceIds: array de deviceIds que el usuario posee
 *
 * IMPORTANTE: El payload NO incluye password_hash. Nunca incluir datos
 *   sensibles en el JWT — el token es base64url, no cifrado.
 *
 * @param {object} user       Fila de la tabla users.
 * @param {string[]} deviceIds  Array de device IDs del usuario.
 * @returns {string} JWT firmado.
 */
function signToken(user, deviceIds) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, deviceIds },
    SECRET,
    { expiresIn: EXPIRES_IN },
  );
}

/**
 * @brief Registra un nuevo usuario y emite un JWT.
 *
 * FLUJO:
 *   1. Validar email y password en el body.
 *   2. Verificar unicidad del email (409 si ya existe).
 *   3. Hashear password con bcrypt.
 *   4. Crear usuario en PostgreSQL.
 *   5. Si viene deviceId en el body, asociarlo.
 *   6. Emitir JWT y retornar 201.
 *
 * @param {import('express').Request}  req
 *   Body: { email, password, deviceId?, role? }
 *   role: solo se usa si el creador es SUPER_ADMIN (por implementar).
 *   Por ahora todos los registros crean USER por defecto.
 * @param {import('express').Response} res
 *   201: { token, user: { id, email, role } }
 *   409: email ya registrado
 *   400: datos faltantes
 * @returns {Promise<void>}
 */
const register = async (req, res) => {
  const { email, password, deviceId } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email y contraseña requeridos' });
  }

  // Verificar si el email ya existe antes de hashear (evita trabajo inútil)
  const existing = await User.findByEmail(email);
  if (existing) {
    return res.status(409).json({ message: 'El email ya está registrado' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.createUser({ email, passwordHash });

    // Asociar dispositivo si se proporcionó en el registro
    if (deviceId) await User.addDevice(user.id, deviceId);

    const deviceIds = deviceId ? [deviceId] : [];
    const token = signToken(user, deviceIds);

    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role, deviceIds },
    });
  } catch (err) {
    console.error('[AUTH] register error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Autentica un usuario existente y emite un JWT.
 *
 * FLUJO:
 *   1. Validar email y password presentes.
 *   2. Buscar usuario por email (404 con mensaje genérico para no filtrar existencia).
 *   3. Comparar password con bcrypt.compare() — operación lenta intencional.
 *   4. Cargar deviceIds del usuario desde user_devices.
 *   5. Emitir JWT.
 *
 * NOTA DE SEGURIDAD:
 *   El mensaje de error es genérico ('Credenciales inválidas') tanto para
 *   "email no existe" como para "contraseña incorrecta". Revelar cuál falló
 *   facilita la enumeración de usuarios.
 *
 * @param {import('express').Request}  req
 *   Body: { email, password }
 * @param {import('express').Response} res
 *   200: { token, user: { id, email, role, deviceIds } }
 *   401: credenciales inválidas
 * @returns {Promise<void>}
 */
const login = async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email y contraseña requeridos' });
  }

  try {
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const deviceIds = await User.getDevices(user.id);
    const token = signToken(user, deviceIds);

    return res.status(200).json({
      token,
      user: { id: user.id, email: user.email, role: user.role, deviceIds },
    });
  } catch (err) {
    console.error('[AUTH] login error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * @brief Retorna el perfil del usuario autenticado.
 *
 * PROPÓSITO:
 *   Los frontends llaman este endpoint al arrancar para validar que el token
 *   almacenado sigue siendo válido y obtener los datos frescos del usuario
 *   (p.ej. si el rol cambió desde que se emitió el token).
 *
 * DEPENDENCIA:
 *   Requiere el middleware authenticate() antes en la cadena.
 *   req.user viene del payload del JWT.
 *
 * @param {import('express').Request}  req  req.user = { sub, email, role, deviceIds }
 * @param {import('express').Response} res
 *   200: { id, email, role, deviceIds }
 * @returns {Promise<void>}
 */
const me = async (req, res) => {
  try {
    // Recargamos desde BD para reflejar cambios de rol o dispositivos
    // que ocurrieron después de emitir el token actual.
    const user = await User.findById(req.user.sub);
    if (!user) return res.status(401).json({ message: 'Usuario no encontrado' });

    const deviceIds = await User.getDevices(user.id);

    return res.status(200).json({
      id: user.id,
      email: user.email,
      role: user.role,
      deviceIds,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { register, login, me };
