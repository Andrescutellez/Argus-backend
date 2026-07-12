'use strict';
const { getPool } = require('../config/postgres');

async function add(communityId, userId, role = 'MEMBER') {
  const { rows } = await getPool().query(
    `INSERT INTO community_members (community_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (community_id, user_id) DO UPDATE SET status='ACTIVE', role=$3
     RETURNING *`,
    [communityId, userId, role],
  );
  return rows[0];
}

async function remove(communityId, userId) {
  await getPool().query(
    `DELETE FROM community_members WHERE community_id=$1 AND user_id=$2`,
    [communityId, userId],
  );
}

async function getRole(communityId, userId) {
  const { rows } = await getPool().query(
    `SELECT role, status FROM community_members WHERE community_id=$1 AND user_id=$2`,
    [communityId, userId],
  );
  return rows[0] ?? null;
}

async function listMembers(communityId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await getPool().query(
    `SELECT cm.user_id, cm.role, cm.joined_at, SPLIT_PART(u.email, '@', 1) AS display_name
     FROM community_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.community_id = $1 AND cm.status = 'ACTIVE'
     ORDER BY cm.joined_at
     LIMIT $2 OFFSET $3`,
    [communityId, limit, offset],
  );
  return rows;
}

async function getCommunityIdsByUser(userId) {
  const { rows } = await getPool().query(
    `SELECT community_id FROM community_members WHERE user_id=$1 AND status='ACTIVE'`,
    [userId],
  );
  return rows.map(r => r.community_id);
}

/** Returns FCM tokens of all active members in a community (excluding a given userId). */
async function getFcmTokensOfCommunity(communityId, excludeUserId = null) {
  const { rows } = await getPool().query(
    `SELECT u.fcm_token
     FROM community_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.community_id = $1
       AND cm.status = 'ACTIVE'
       AND ($2::uuid IS NULL OR cm.user_id <> $2)
       AND u.fcm_token IS NOT NULL`,
    [communityId, excludeUserId],
  );
  return rows.map(r => r.fcm_token);
}

async function updateRole(communityId, userId, role) {
  const { rows } = await getPool().query(
    `UPDATE community_members SET role=$3 WHERE community_id=$1 AND user_id=$2 RETURNING *`,
    [communityId, userId, role],
  );
  return rows[0] ?? null;
}

module.exports = { add, remove, getRole, listMembers, getCommunityIdsByUser, getFcmTokensOfCommunity, updateRole };
