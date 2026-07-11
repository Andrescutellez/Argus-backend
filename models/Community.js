'use strict';
const { getPool } = require('../config/postgres');

async function create({ name, description, type, privacy, ownerId }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO communities (name, description, type, privacy, owner_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description || null, type || 'CLUB', privacy || 'PRIVADA', ownerId],
    );
    const c = rows[0];
    await client.query(
      `INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'OWNER')`,
      [c.id, ownerId],
    );
    await client.query(
      `INSERT INTO community_settings (community_id) VALUES ($1)`, [c.id],
    );
    await client.query('COMMIT');
    return c;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getById(id) {
  const { rows } = await getPool().query(
    `SELECT c.*, cs.alert_on_theft, cs.alert_on_risk_zone, cs.allow_sightings
     FROM communities c
     LEFT JOIN community_settings cs ON cs.community_id = c.id
     WHERE c.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function getPublic({ limit = 20, offset = 0, search = '' }) {
  const { rows } = await getPool().query(
    `SELECT c.*, cm_count.cnt AS member_count
     FROM communities c
     LEFT JOIN (SELECT community_id, COUNT(*) cnt FROM community_members WHERE status='ACTIVE' GROUP BY community_id) cm_count
       ON cm_count.community_id = c.id
     WHERE c.privacy = 'PUBLICA'
       AND ($3 = '' OR c.name ILIKE '%' || $3 || '%')
     ORDER BY c.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, search],
  );
  return rows;
}

async function getByMember(userId) {
  const { rows } = await getPool().query(
    `SELECT c.*, cm.role, cm.joined_at
     FROM communities c
     JOIN community_members cm ON cm.community_id = c.id
     WHERE cm.user_id = $1 AND cm.status = 'ACTIVE'
     ORDER BY cm.joined_at DESC`,
    [userId],
  );
  return rows;
}

async function update(id, { name, description, type, privacy, imageUrl }) {
  const fields = [];
  const vals   = [];
  let n = 1;
  if (name        !== undefined) { fields.push(`name=$${n++}`);        vals.push(name); }
  if (description !== undefined) { fields.push(`description=$${n++}`); vals.push(description); }
  if (type        !== undefined) { fields.push(`type=$${n++}`);        vals.push(type); }
  if (privacy     !== undefined) { fields.push(`privacy=$${n++}`);     vals.push(privacy); }
  if (imageUrl    !== undefined) { fields.push(`image_url=$${n++}`);   vals.push(imageUrl); }
  if (!fields.length) return null;
  vals.push(id);
  const { rows } = await getPool().query(
    `UPDATE communities SET ${fields.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

async function updateSettings(id, { alertOnTheft, alertOnRiskZone, allowSightings }) {
  const fields = [];
  const vals   = [];
  let n = 1;
  if (alertOnTheft    !== undefined) { fields.push(`alert_on_theft=$${n++}`);     vals.push(alertOnTheft); }
  if (alertOnRiskZone !== undefined) { fields.push(`alert_on_risk_zone=$${n++}`); vals.push(alertOnRiskZone); }
  if (allowSightings  !== undefined) { fields.push(`allow_sightings=$${n++}`);    vals.push(allowSightings); }
  if (!fields.length) return null;
  vals.push(id);
  const { rows } = await getPool().query(
    `UPDATE community_settings SET ${fields.join(',')} WHERE community_id=$${n} RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

async function remove(id) {
  await getPool().query('DELETE FROM communities WHERE id=$1', [id]);
}

async function incrementMemberCount(id, delta) {
  await getPool().query(
    'UPDATE communities SET member_count = GREATEST(0, member_count + $1) WHERE id=$2',
    [delta, id],
  );
}

module.exports = { create, getById, getPublic, getByMember, update, updateSettings, remove, incrementMemberCount };
