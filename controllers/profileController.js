'use strict';
const SocialProfile = require('../models/SocialProfile');
const User          = require('../models/User');

/**
 * GET /api/profile/me
 * Retorna el perfil social completo del usuario autenticado.
 * Si el usuario aún no tiene perfil (usuarios pre-migración), lo crea on-demand.
 */
const getMe = async (req, res) => {
  try {
    let profile = await SocialProfile.upsert(req.user.sub, req.user.email);
    return res.json(profile);
  } catch (err) {
    console.error('[Profile] getMe error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * PATCH /api/profile/me
 * Actualiza display_name, bio, city, isPublic.
 * Cada campo es opcional — solo se actualiza si se envía.
 * Body: { displayName?, bio?, city?, isPublic? }
 */
const updateMe = async (req, res) => {
  const { displayName, bio, city, isPublic } = req.body ?? {};

  // Validaciones básicas de longitud (null = borrar campo, undefined = no enviar)
  if (typeof displayName === 'string' && displayName.trim().length > 80) {
    return res.status(400).json({ message: 'El nombre visible debe tener máximo 80 caracteres.' });
  }
  if (typeof bio === 'string' && bio.length > 300) {
    return res.status(400).json({ message: 'La biografía debe tener máximo 300 caracteres.' });
  }
  if (typeof city === 'string' && city.trim().length > 100) {
    return res.status(400).json({ message: 'La ciudad debe tener máximo 100 caracteres.' });
  }
  if (isPublic !== undefined && isPublic !== null && typeof isPublic !== 'boolean') {
    return res.status(400).json({ message: 'isPublic debe ser boolean.' });
  }

  try {
    // Asegurar que el perfil existe antes de actualizar
    await SocialProfile.upsert(req.user.sub, req.user.email);

    const profile = await SocialProfile.update(req.user.sub, {
      displayName: displayName?.trim() ?? undefined,
      bio:         bio?.trim()         ?? undefined,
      city:        city?.trim()        ?? undefined,
      isPublic,
    });

    if (!profile) return res.status(404).json({ message: 'Perfil no encontrado' });
    return res.json(profile);
  } catch (err) {
    console.error('[Profile] updateMe error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * PATCH /api/profile/me/username
 * Cambia el username. Aplica cooldown de 30 días y registra historial.
 * Body: { username: string }
 */
const changeUsername = async (req, res) => {
  const { username } = req.body ?? {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ message: 'username requerido.' });
  }

  try {
    await SocialProfile.upsert(req.user.sub, req.user.email);
    const result = await SocialProfile.changeUsername(req.user.sub, username.trim().toLowerCase());

    if (!result.ok) return res.status(409).json({ message: result.reason });
    return res.json(result.profile);
  } catch (err) {
    console.error('[Profile] changeUsername error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * GET /api/profile/check/:username
 * Verifica disponibilidad de un username.
 * El propio usuario puede re-consultar el suyo sin que cuente como "tomado".
 * Response: { available: boolean, valid: boolean }
 */
const checkUsername = async (req, res) => {
  const { username } = req.params;
  const { isValidUsername, isUsernameAvailable } = SocialProfile;

  const valid = isValidUsername(username);
  if (!valid) {
    return res.json({ available: false, valid: false });
  }

  try {
    const available = await isUsernameAvailable(username, req.user.sub);
    return res.json({ available, valid: true });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * GET /api/profile/:username
 * Perfil público de un usuario por su username.
 * Si el perfil es privado, solo el propio usuario puede verlo.
 */
const getPublic = async (req, res) => {
  try {
    const profile = await SocialProfile.findByUsername(req.params.username);
    if (!profile) return res.status(404).json({ message: 'Usuario no encontrado' });

    // Perfil privado: solo visible para el propio dueño
    if (!profile.is_public && profile.user_id !== req.user.sub) {
      return res.status(403).json({ message: 'Este perfil es privado' });
    }

    // No exponer datos internos en el endpoint público
    const { password_hash, ...safe } = profile;
    return res.json(safe);
  } catch (err) {
    console.error('[Profile] getPublic error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * GET /api/profile/search?q=texto
 * Busca perfiles públicos por username o display_name.
 * Solo retorna perfiles públicos y activos.
 * El propio usuario queda excluido de los resultados.
 * Query param: q (mínimo 2 caracteres).
 */
const searchProfiles = async (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (q.length < 2) {
    return res.json([]);
  }

  try {
    const results = await SocialProfile.search(q, req.user.sub, 10);
    return res.json(results);
  } catch (err) {
    console.error('[Profile] search error:', err.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { getMe, updateMe, changeUsername, checkUsername, getPublic, searchProfiles };
