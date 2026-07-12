'use strict';

const Community           = require('../models/Community');
const CommunityMember     = require('../models/CommunityMember');
const CommunityInvitation = require('../models/CommunityInvitation');
const CommunityPost       = require('../models/CommunityPost');
const { getPool }         = require('../config/postgres');
const { getIo }           = require('../services/socketService');

// ─── Helper ────────────────────────────────────────────────────────────────────

/** Verifica que el usuario sea OWNER o ADMIN de la comunidad. */
async function assertAdmin(communityId, userId, res) {
  const m = await CommunityMember.getRole(communityId, userId);
  if (!m || !['OWNER', 'ADMIN'].includes(m.role)) {
    res.status(403).json({ message: 'Solo administradores pueden realizar esta acción' });
    return false;
  }
  return true;
}

/** Verifica que el usuario sea miembro activo. */
async function assertMember(communityId, userId, res) {
  const m = await CommunityMember.getRole(communityId, userId);
  if (!m || m.status !== 'ACTIVE') {
    res.status(403).json({ message: 'No eres miembro de esta comunidad' });
    return false;
  }
  return true;
}

// ─── Comunidades ───────────────────────────────────────────────────────────────

const createCommunity = async (req, res) => {
  const { name, description, type, privacy } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ message: 'Nombre requerido' });
  const community = await Community.create({
    name: name.trim(), description, type, privacy, ownerId: req.user.sub,
  });
  return res.status(201).json(community);
};

const getMyCommunities = async (req, res) => {
  const communities = await Community.getByMember(req.user.sub);
  return res.json(communities);
};

const getPublicCommunities = async (req, res) => {
  const { limit = 20, offset = 0, search = '' } = req.query;
  const communities = await Community.getPublic({ limit: +limit, offset: +offset, search });
  return res.json(communities);
};

const getCommunity = async (req, res) => {
  const community = await Community.getById(req.params.communityId);
  if (!community) return res.status(404).json({ message: 'Comunidad no encontrada' });

  // Rol del usuario actual en la comunidad (null si no es miembro)
  const membership = await CommunityMember.getRole(community.id, req.user.sub);

  // Para comunidades privadas exige membresía activa
  if (community.privacy === 'PRIVADA') {
    if (!membership || membership.status !== 'ACTIVE') {
      return res.status(403).json({ message: 'Comunidad privada' });
    }
  }

  const members = await CommunityMember.listMembers(community.id, { limit: 10 });
  return res.json({
    ...community,
    members,
    role: membership?.status === 'ACTIVE' ? membership.role : null,
  });
};

const updateCommunity = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const updated = await Community.update(communityId, req.body ?? {});
  return updated ? res.json(updated) : res.status(404).json({ message: 'Comunidad no encontrada' });
};

const deleteCommunity = async (req, res) => {
  const { communityId } = req.params;
  const community = await Community.getById(communityId);
  if (!community) return res.status(404).json({ message: 'Comunidad no encontrada' });
  if (community.owner_id !== req.user.sub) {
    return res.status(403).json({ message: 'Solo el propietario puede eliminar la comunidad' });
  }
  await Community.remove(communityId);
  return res.json({ message: 'Comunidad eliminada' });
};

// ─── Membresía ─────────────────────────────────────────────────────────────────

const joinCommunity = async (req, res) => {
  const { communityId } = req.params;
  const community = await Community.getById(communityId);
  if (!community) return res.status(404).json({ message: 'Comunidad no encontrada' });

  // Comunidades privadas solo se pueden unir via invitación
  if (community.privacy === 'PRIVADA') {
    return res.status(403).json({ message: 'Comunidad privada — usa un enlace de invitación' });
  }

  const existing = await CommunityMember.getRole(communityId, req.user.sub);
  if (existing?.status === 'ACTIVE') {
    return res.status(409).json({ message: 'Ya eres miembro' });
  }

  await CommunityMember.add(communityId, req.user.sub);
  await Community.incrementMemberCount(communityId, 1);
  return res.status(201).json({ message: 'Te uniste a la comunidad' });
};

const leaveCommunity = async (req, res) => {
  const { communityId } = req.params;
  const community = await Community.getById(communityId);
  if (!community) return res.status(404).json({ message: 'Comunidad no encontrada' });
  if (community.owner_id === req.user.sub) {
    return res.status(400).json({ message: 'El propietario no puede abandonar — transfiere o elimina la comunidad' });
  }
  await CommunityMember.remove(communityId, req.user.sub);
  await Community.incrementMemberCount(communityId, -1);
  return res.json({ message: 'Saliste de la comunidad' });
};

const listMembers = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertMember(communityId, req.user.sub, res)) return;
  const members = await CommunityMember.listMembers(communityId, {
    limit: +(req.query.limit ?? 50),
    offset: +(req.query.offset ?? 0),
  });
  return res.json(members);
};

const updateMemberRole = async (req, res) => {
  const { communityId, targetUserId } = req.params;
  const { role } = req.body ?? {};
  if (!['ADMIN', 'MEMBER'].includes(role)) {
    return res.status(400).json({ message: 'Rol inválido. Use ADMIN o MEMBER' });
  }
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const updated = await CommunityMember.updateRole(communityId, targetUserId, role);
  return updated ? res.json(updated) : res.status(404).json({ message: 'Miembro no encontrado' });
};

const removeMember = async (req, res) => {
  const { communityId, targetUserId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const community = await Community.getById(communityId);
  if (community?.owner_id === targetUserId) {
    return res.status(400).json({ message: 'No puedes expulsar al propietario' });
  }
  await CommunityMember.remove(communityId, targetUserId);
  await Community.incrementMemberCount(communityId, -1);
  return res.json({ message: 'Miembro eliminado' });
};

// ─── Invitaciones ──────────────────────────────────────────────────────────────

const createInvitation = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const { expiresAt, maxUses } = req.body ?? {};
  const invitation = await CommunityInvitation.create(communityId, req.user.sub, { expiresAt, maxUses });
  return res.status(201).json(invitation);
};

const useInvitation = async (req, res) => {
  const { token } = req.params;
  const invitation = await CommunityInvitation.consume(token);
  if (!invitation) {
    return res.status(410).json({ message: 'Invitación inválida, expirada o sin usos disponibles' });
  }

  const existing = await CommunityMember.getRole(invitation.community_id, req.user.sub);
  if (existing?.status === 'ACTIVE') {
    return res.status(409).json({ message: 'Ya eres miembro de esta comunidad' });
  }

  await CommunityMember.add(invitation.community_id, req.user.sub);
  await Community.incrementMemberCount(invitation.community_id, 1);
  return res.status(201).json({ message: 'Te uniste a la comunidad', communityId: invitation.community_id });
};

const listInvitations = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const invitations = await CommunityInvitation.listByCommunity(communityId);
  return res.json(invitations);
};

const revokeInvitation = async (req, res) => {
  const { communityId, invitationId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  await CommunityInvitation.revoke(invitationId);
  return res.json({ message: 'Invitación revocada' });
};

// ─── Posts / Feed ──────────────────────────────────────────────────────────────

const createPost = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertMember(communityId, req.user.sub, res)) return;
  const { type, content, mediaUrl, lat, lng } = req.body ?? {};
  if (!content?.trim()) return res.status(400).json({ message: 'Contenido requerido' });

  const post = await CommunityPost.create({
    communityId, authorId: req.user.sub,
    type, content: content.trim(), mediaUrl, lat, lng,
  });

  // Notifica en tiempo real a los miembros del room
  getIo()?.to(`community:${communityId}`).emit('community:post', post);

  return res.status(201).json(post);
};

const getCommunityFeed = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertMember(communityId, req.user.sub, res)) return;
  const posts = await CommunityPost.listByCommunity(communityId, {
    limit: +(req.query.limit ?? 30),
    before: req.query.before ?? null,
  });
  return res.json(posts);
};

const getMyFeed = async (req, res) => {
  const posts = await CommunityPost.feedForUser(req.user.sub, {
    limit: +(req.query.limit ?? 40),
    before: req.query.before ?? null,
  });
  return res.json(posts);
};

const deletePost = async (req, res) => {
  const { communityId, postId } = req.params;
  const post = await CommunityPost.getById(postId);
  if (!post) return res.status(404).json({ message: 'Post no encontrado' });

  const isAuthor = post.author_id === req.user.sub;
  const isAdmin  = await CommunityMember.getRole(communityId, req.user.sub)
    .then(m => ['OWNER', 'ADMIN'].includes(m?.role));

  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ message: 'Sin permisos para eliminar este post' });
  }
  await CommunityPost.remove(postId);
  return res.json({ message: 'Post eliminado' });
};

// ─── Preferencias de privacidad ────────────────────────────────────────────────

const getPrivacyPrefs = async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT share_theft_with_communities, theft_location_visibility FROM users WHERE id=$1`,
    [req.user.sub],
  );
  return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: 'Usuario no encontrado' });
};

const updatePrivacyPrefs = async (req, res) => {
  const { shareTheftWithCommunities, theftLocationVisibility } = req.body ?? {};
  const valid = ['none', 'last_known', 'realtime'];
  if (theftLocationVisibility !== undefined && !valid.includes(theftLocationVisibility)) {
    return res.status(400).json({ message: 'theftLocationVisibility debe ser: none | last_known | realtime' });
  }

  const fields = [];
  const vals   = [];
  let n = 1;
  if (shareTheftWithCommunities !== undefined) {
    fields.push(`share_theft_with_communities=$${n++}`);
    vals.push(!!shareTheftWithCommunities);
  }
  if (theftLocationVisibility !== undefined) {
    fields.push(`theft_location_visibility=$${n++}`);
    vals.push(theftLocationVisibility);
  }
  if (!fields.length) return res.status(400).json({ message: 'Sin campos para actualizar' });

  vals.push(req.user.sub);
  const { rows } = await getPool().query(
    `UPDATE users SET ${fields.join(',')} WHERE id=$${n}
     RETURNING share_theft_with_communities, theft_location_visibility`,
    vals,
  );
  return res.json(rows[0]);
};

// ─── Configuración de comunidad ────────────────────────────────────────────────

const updateCommunitySettings = async (req, res) => {
  const { communityId } = req.params;
  if (!await assertAdmin(communityId, req.user.sub, res)) return;
  const { alertOnTheft, alertOnRiskZone, allowSightings } = req.body ?? {};
  const settings = await Community.updateSettings(communityId, { alertOnTheft, alertOnRiskZone, allowSightings });
  return settings ? res.json(settings) : res.status(404).json({ message: 'Comunidad no encontrada' });
};

module.exports = {
  createCommunity, getMyCommunities, getPublicCommunities, getCommunity,
  updateCommunity, deleteCommunity,
  joinCommunity, leaveCommunity, listMembers, updateMemberRole, removeMember,
  createInvitation, useInvitation, listInvitations, revokeInvitation,
  createPost, getCommunityFeed, getMyFeed, deletePost,
  getPrivacyPrefs, updatePrivacyPrefs, updateCommunitySettings,
};
