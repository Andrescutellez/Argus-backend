'use strict';
const { getPool } = require('../config/postgres');
const crypto = require('crypto');

async function create(communityId, createdBy, { expiresAt = null, maxUses = null } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const { rows } = await getPool().query(
    `INSERT INTO community_invitations (community_id, token, created_by, expires_at, max_uses)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [communityId, token, createdBy, expiresAt, maxUses],
  );
  return rows[0];
}

async function getByToken(token) {
  const { rows } = await getPool().query(
    `SELECT i.*, c.name AS community_name, c.privacy
     FROM community_invitations i
     JOIN communities c ON c.id = i.community_id
     WHERE i.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

/** Validates and increments use_count atomically. Returns invitation or null if invalid. */
async function consume(token) {
  const { rows } = await getPool().query(
    `UPDATE community_invitations
     SET use_count = use_count + 1
     WHERE token = $1
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR use_count < max_uses)
     RETURNING *`,
    [token],
  );
  return rows[0] ?? null;
}

async function listByCommunity(communityId) {
  const { rows } = await getPool().query(
    `SELECT * FROM community_invitations WHERE community_id=$1 ORDER BY created_at DESC`,
    [communityId],
  );
  return rows;
}

async function revoke(id) {
  await getPool().query(
    `UPDATE community_invitations SET expires_at = NOW() WHERE id=$1`, [id],
  );
}

module.exports = { create, getByToken, consume, listByCommunity, revoke };
