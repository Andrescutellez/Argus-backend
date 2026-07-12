'use strict';
const { getPool } = require('../config/postgres');

async function create({ communityId, authorId, type = 'GENERAL', content, mediaUrl = null, lat = null, lng = null, incidentId = null }) {
  const { rows } = await getPool().query(
    `INSERT INTO community_posts (community_id, author_id, type, content, media_url, lat, lng, incident_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [communityId, authorId, type, content, mediaUrl, lat, lng, incidentId],
  );
  return rows[0];
}

async function listByCommunity(communityId, { limit = 30, before = null } = {}) {
  const { rows } = await getPool().query(
    `SELECT p.*,
       COALESCE(sp.display_name, sp.username, SPLIT_PART(u.email, '@', 1)) AS author_name,
       sp.username  AS author_username,
       sp.avatar_url AS author_avatar
     FROM community_posts p
     JOIN users u ON u.id = p.author_id
     LEFT JOIN social_profiles sp ON sp.user_id = u.id
     WHERE p.community_id = $1
       AND ($2::timestamptz IS NULL OR p.created_at < $2)
     ORDER BY p.created_at DESC
     LIMIT $3`,
    [communityId, before, limit],
  );
  return rows;
}

/** Feed multi-comunidad: posts de todas las comunidades a las que pertenece el usuario. */
async function feedForUser(userId, { limit = 40, before = null } = {}) {
  const { rows } = await getPool().query(
    `SELECT p.*, c.name AS community_name,
       COALESCE(sp.display_name, sp.username, SPLIT_PART(u.email, '@', 1)) AS author_name,
       sp.username   AS author_username,
       sp.avatar_url AS author_avatar
     FROM community_posts p
     JOIN communities c ON c.id = p.community_id
     JOIN users u ON u.id = p.author_id
     LEFT JOIN social_profiles sp ON sp.user_id = u.id
     WHERE p.community_id IN (
       SELECT community_id FROM community_members WHERE user_id=$1 AND status='ACTIVE'
     )
     AND ($2::timestamptz IS NULL OR p.created_at < $2)
     ORDER BY p.created_at DESC
     LIMIT $3`,
    [userId, before, limit],
  );
  return rows;
}

async function getById(id) {
  const { rows } = await getPool().query(
    `SELECT p.*,
       COALESCE(sp.display_name, sp.username, SPLIT_PART(u.email, '@', 1)) AS author_name,
       sp.username   AS author_username,
       sp.avatar_url AS author_avatar
     FROM community_posts p
     JOIN users u ON u.id = p.author_id
     LEFT JOIN social_profiles sp ON sp.user_id = u.id
     WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function remove(id) {
  await getPool().query('DELETE FROM community_posts WHERE id=$1', [id]);
}

module.exports = { create, listByCommunity, feedForUser, getById, remove };
