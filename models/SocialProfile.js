'use strict';
const { getPool } = require('../config/postgres');

// Caracteres permitidos: a-z, 0-9, guión bajo. 3-30 chars. Sin guión al inicio/fin.
const USERNAME_RE = /^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$|^[a-z0-9]{1,30}$/;

function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

function generateBase(email) {
  const prefix = email.split('@')[0];
  const clean = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  return clean || 'user';
}

/** Retorna el perfil de un usuario por su userId, o null si no existe. */
async function findByUserId(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM social_profiles WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Retorna el perfil público por username (case-insensitive). */
async function findByUsername(username) {
  const { rows } = await getPool().query(
    `SELECT sp.*, u.email, u.role
     FROM social_profiles sp
     JOIN users u ON u.id = sp.user_id
     WHERE LOWER(sp.username) = LOWER($1)`,
    [username],
  );
  return rows[0] ?? null;
}

/**
 * Crea un perfil social para un usuario.
 * Si el username base tiene conflicto (error 23505), agrega sufijo numérico.
 * Retorna el perfil creado.
 */
async function create(userId, emailOrBase) {
  const base = emailOrBase.includes('@')
    ? generateBase(emailOrBase)
    : emailOrBase.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 28);

  let candidate = base;
  let suffix = 2;
  let attempts = 0;

  while (attempts < 20) {
    try {
      const { rows } = await getPool().query(
        `INSERT INTO social_profiles (user_id, username)
         VALUES ($1, $2) RETURNING *`,
        [userId, candidate],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // Username ya tomado — agregar sufijo
        candidate = base.slice(0, 25) + '_' + suffix;
        suffix++;
        attempts++;
      } else {
        throw err;
      }
    }
  }
  throw new Error('No se pudo generar un username único para este usuario');
}

/** Actualiza display_name, bio, city, is_public. Ignora campos undefined. */
async function update(userId, { displayName, bio, city, isPublic }) {
  const { rows } = await getPool().query(
    `UPDATE social_profiles
     SET
       display_name = COALESCE($2, display_name),
       bio          = COALESCE($3, bio),
       city         = COALESCE($4, city),
       is_public    = COALESCE($5, is_public),
       updated_at   = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, displayName ?? null, bio ?? null, city ?? null, isPublic ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Cambia el username de un usuario.
 * - Valida formato.
 * - Verifica disponibilidad (case-insensitive).
 * - Registra el username anterior en username_history.
 * - Aplica un cooldown: mínimo 30 días entre cambios (comprobado en username_history).
 *
 * Retorna { ok: true, profile } o { ok: false, reason: string }.
 */
async function changeUsername(userId, newUsername) {
  if (!isValidUsername(newUsername)) {
    return { ok: false, reason: 'Formato de usuario inválido. Solo letras minúsculas, números y guión bajo (3–30 caracteres).' };
  }

  const lower = newUsername.toLowerCase();
  const pool = getPool();

  // Verificar cooldown: último cambio en los últimos 30 días
  const { rows: history } = await pool.query(
    `SELECT changed_at FROM username_history
     WHERE user_id = $1
     ORDER BY changed_at DESC LIMIT 1`,
    [userId],
  );
  if (history.length > 0) {
    const daysSince = (Date.now() - new Date(history[0].changed_at).getTime()) / 86_400_000;
    if (daysSince < 30) {
      const daysLeft = Math.ceil(30 - daysSince);
      return { ok: false, reason: `Debes esperar ${daysLeft} día(s) para cambiar el usuario nuevamente.` };
    }
  }

  // Verificar disponibilidad
  const { rows: existing } = await pool.query(
    `SELECT user_id FROM social_profiles WHERE LOWER(username) = $1`,
    [lower],
  );
  if (existing.length > 0 && existing[0].user_id !== userId) {
    return { ok: false, reason: 'Ese nombre de usuario ya está en uso.' };
  }
  if (existing.length > 0 && existing[0].user_id === userId) {
    return { ok: false, reason: 'Ya usas ese nombre de usuario.' };
  }

  // Guardar username anterior en historial, luego actualizar
  const current = await findByUserId(userId);
  if (current) {
    await pool.query(
      `INSERT INTO username_history (user_id, username) VALUES ($1, $2)`,
      [userId, current.username],
    );
  }

  const { rows } = await pool.query(
    `UPDATE social_profiles SET username = $2, updated_at = NOW()
     WHERE user_id = $1 RETURNING *`,
    [userId, lower],
  );
  return { ok: true, profile: rows[0] };
}

/**
 * Verifica si un username está disponible.
 * excludeUserId: no cuenta si el dueño es el propio usuario (para edición sin cambio real).
 */
async function isUsernameAvailable(username, excludeUserId = null) {
  if (!isValidUsername(username)) return false;
  const { rows } = await getPool().query(
    `SELECT user_id FROM social_profiles WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  if (rows.length === 0) return true;
  return excludeUserId ? rows[0].user_id === excludeUserId : false;
}

/**
 * Crea el perfil si no existe para el usuario.
 * Seguro de llamar en cada request — hace SELECT primero.
 */
async function upsert(userId, email) {
  const existing = await findByUserId(userId);
  if (existing) return existing;
  return create(userId, email);
}

module.exports = {
  findByUserId,
  findByUsername,
  create,
  update,
  changeUsername,
  isUsernameAvailable,
  upsert,
  isValidUsername,
};
