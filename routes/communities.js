'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const c = require('../controllers/communityController');

const router = Router();
router.use(authenticate);

// ── Rutas FIJAS primero (deben ir antes de /:communityId para no ser capturadas) ──
router.get   ('/mine',          c.getMyCommunities);
router.get   ('/explore',       c.getPublicCommunities);
router.get   ('/feed',          c.getMyFeed);
router.post  ('/join/:token',   c.useInvitation);         // /join/:token antes de /:id/...

// Preferencias de privacidad — antes de /:communityId
router.get   ('/privacy/prefs', c.getPrivacyPrefs);
router.patch ('/privacy/prefs', c.updatePrivacyPrefs);

// ── Comunidades CRUD ─────────────────────────────────────────────────────────
router.post  ('/',              c.createCommunity);
router.get   ('/:communityId',  c.getCommunity);
router.patch ('/:communityId',  c.updateCommunity);
router.delete('/:communityId',  c.deleteCommunity);

// ── Membresía ────────────────────────────────────────────────────────────────
router.post  ('/:communityId/join',                        c.joinCommunity);
router.post  ('/:communityId/members',                     c.addMember);
router.delete('/:communityId/leave',                       c.leaveCommunity);
router.get   ('/:communityId/members',                     c.listMembers);
router.patch ('/:communityId/members/:targetUserId/role',  c.updateMemberRole);
router.delete('/:communityId/members/:targetUserId',       c.removeMember);

// ── Invitaciones ─────────────────────────────────────────────────────────────
router.post  ('/:communityId/invitations',               c.createInvitation);
router.get   ('/:communityId/invitations',               c.listInvitations);
router.delete('/:communityId/invitations/:invitationId', c.revokeInvitation);

// ── Posts / Feed ─────────────────────────────────────────────────────────────
router.post  ('/:communityId/posts',         c.createPost);
router.get   ('/:communityId/posts',         c.getCommunityFeed);
router.delete('/:communityId/posts/:postId', c.deletePost);

// ── Configuración de comunidad ───────────────────────────────────────────────
router.patch ('/:communityId/settings', c.updateCommunitySettings);

module.exports = router;
