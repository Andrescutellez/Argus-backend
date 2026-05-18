/**
 * @fileoverview Middleware de autenticación y autorización JWT para la API Argus.
 *
 * PROPÓSITO:
 *   Tres middlewares reutilizables que protegen los endpoints REST:
 *   1. authenticate  — verifica el JWT y adjunta req.user a cada request.
 *   2. requireRole   — fábrica de middleware que restringe por rol.
 *   3. canAccessDevice — restringe a dispositivos que el usuario posee
 *                        (ADMIN y SUPER_ADMIN bypasean la restricción).
 *
 * FLUJO DE AUTENTICACIÓN:
 *   Request → authenticate → req.user = { id, email, role, deviceIds }
 *          → requireRole('ADMIN') → ¿role === 'ADMIN'? → next() o 403
 *          → canAccessDevice → ¿deviceId en deviceIds? → next() o 403
 *
 * PAYLOAD DEL JWT:
 *   { sub: userId, email, role, deviceIds: ['ARGUS-XXXX', ...] }
 *   El sub sigue la convención RFC 7519 — identifica el sujeto del token.
 *
 * VARIABLES CRÍTICAS:
 *   JWT_SECRET: si cambia, TODOS los tokens existentes se invalidan.
 *   JWT se firma con HS256 (HMAC-SHA256). Para mayor seguridad en producción,
 *   considerar RS256 con par de llaves pública/privada.
 *
 * @module middleware/auth
 */

'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

/**
 * @brief Verifica el Bearer token JWT del header Authorization.
 *
 * FLUJO:
 *   1. Extraer token de 'Authorization: Bearer <token>'.
 *   2. Verificar firma y expiración con jwt.verify().
 *   3. Adjuntar payload decodificado como req.user.
 *   4. Llamar next(). Si falla cualquier paso → 401.
 *
 * ERRORES MANEJADOS:
 *   - Header ausente o malformado → 401
 *   - Token expirado (jwt.TokenExpiredError) → 401
 *   - Firma inválida (jwt.JsonWebTokenError) → 401
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token requerido' });
  }

  const token = header.slice(7);
  try {
    // jwt.verify lanza si el token está expirado, la firma es inválida, o
    // el issuer/audience no coincide. No necesitamos manejar subcasos.
    req.user = jwt.verify(token, SECRET);
    return next();
  } catch {
    return res.status(401).json({ message: 'Token inválido o expirado' });
  }
};

/**
 * @brief Fábrica de middleware que restringe el acceso por roles.
 *
 * PROPÓSITO:
 *   Permite declarar en la ruta qué roles tienen acceso:
 *     router.patch('/:id/ack', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), handler)
 *
 * @param {...string} roles  Roles permitidos. Si el usuario no tiene ninguno → 403.
 * @returns {import('express').RequestHandler}
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ message: 'Permisos insuficientes' });
  }
  return next();
};

/**
 * @brief Verifica que el usuario tenga acceso al dispositivo del parámetro de ruta.
 *
 * PROPÓSITO:
 *   Un USER solo puede ver y controlar sus propios dispositivos.
 *   ADMIN y SUPER_ADMIN tienen acceso a todos los dispositivos de la flota.
 *
 * DEPENDENCIA DE RUTA:
 *   Requiere que la ruta tenga el parámetro ':deviceId', p.ej.:
 *     GET /api/device/:deviceId/status
 *
 * BYPASS DE ADMIN:
 *   Si role === 'ADMIN' o 'SUPER_ADMIN', se llama next() sin verificar deviceIds.
 *   Esto es intencional: los operadores de monitoreo ven toda la flota.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const canAccessDevice = (req, res, next) => {
  const { role, deviceIds } = req.user;

  // ADMIN y SUPER_ADMIN tienen visibilidad de toda la flota
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return next();

  const { deviceId } = req.params;
  if (!deviceIds?.includes(deviceId)) {
    return res.status(403).json({ message: 'Sin acceso a este dispositivo' });
  }
  return next();
};

module.exports = { authenticate, requireRole, canAccessDevice };
