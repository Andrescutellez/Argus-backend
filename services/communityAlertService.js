'use strict';

/**
 * Cuando el ESP32 dispara STATE_ALERT, notifica a todas las comunidades a las
 * que pertenece el dueño del dispositivo, respetando las preferencias de
 * privacidad del usuario (theft_location_visibility).
 */

const { getPool }             = require('../config/postgres');
const { getAdmin }            = require('../config/firebase');
const CommunityMember         = require('../models/CommunityMember');
const Community               = require('../models/Community');
const CommunityPost           = require('../models/CommunityPost');
const { getIo }               = require('../services/socketService');

/**
 * @param {string}      deviceId  ID del dispositivo que disparó la alarma
 * @param {number|null} lat       Latitud al momento de la alarma
 * @param {number|null} lon       Longitud al momento de la alarma
 */
async function notifyCommunities(deviceId, lat, lon) {
  try {
    // 1. Obtener dueño + preferencias de privacidad
    const { rows: ownerRows } = await getPool().query(
      `SELECT u.id, SPLIT_PART(u.email, '@', 1) AS full_name, u.share_theft_with_communities, u.theft_location_visibility
       FROM users u
       JOIN motos m ON m.owner_id = u.id
       WHERE m.device_id = $1`,
      [deviceId],
    );
    const owner = ownerRows[0];
    if (!owner || !owner.share_theft_with_communities) return;

    // 2. Resolver coordenadas según preferencia de visibilidad
    const visib = owner.theft_location_visibility;
    const postLat = visib === 'none' ? null : lat;
    const postLon = visib === 'none' ? null : lon;

    // 3. Obtener todas las comunidades del usuario
    const communityIds = await CommunityMember.getCommunityIdsByUser(owner.id);
    if (!communityIds.length) return;

    // 4. Para cada comunidad que tenga alert_on_theft=true
    for (const communityId of communityIds) {
      const community = await Community.getById(communityId);
      if (!community?.alert_on_theft) continue;

      // 5. Crear post automático de tipo THEFT_ALERT
      const content = `🚨 Alerta de robo — ${owner.full_name} reporta que su moto está siendo movida sin autorización.`;
      const post = await CommunityPost.create({
        communityId,
        authorId: owner.id,
        type: 'THEFT_ALERT',
        content,
        lat: postLat,
        lng: visib === 'none' ? null : lon,
        incidentId: null,
      });

      // 6. Emitir en tiempo real al room de la comunidad
      getIo()?.to(`community:${communityId}`).emit('community:theft_alert', {
        ...post,
        deviceId,
        visib,
      });

      // 7. FCM multicast a los miembros offline (excluye al propio dueño)
      const fcmTokens = await CommunityMember.getFcmTokensOfCommunity(communityId, owner.id);
      if (fcmTokens.length) {
        await sendCommunityPush(fcmTokens, owner.full_name, community.name, visib !== 'none');
      }
    }
  } catch (err) {
    console.error('[CommunityAlert] Error notificando comunidades:', err.message);
  }
}

async function sendCommunityPush(tokens, ownerName, communityName, hasLocation) {
  const admin = getAdmin();
  if (!admin || !tokens.length) return;

  const body = hasLocation
    ? `${ownerName} está reportando un robo — ver ubicación en la comunidad`
    : `${ownerName} está reportando un robo en tu comunidad`;

  const message = {
    notification: { title: `🚨 Alerta en ${communityName}`, body },
    data: { type: 'COMMUNITY_THEFT_ALERT', communityName },
    android: {
      priority: 'high',
      notification: { channelId: 'argus_alarm', priority: 'high' },
    },
    apns: { payload: { aps: { sound: 'default', badge: 1, contentAvailable: true } } },
  };

  // sendEachForMulticast acepta hasta 500 tokens por lote
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  for (const chunk of chunks) {
    await admin.messaging().sendEachForMulticast({ ...message, tokens: chunk }).catch(e =>
      console.error('[CommunityAlert] FCM multicast error:', e.message),
    );
  }
}

module.exports = { notifyCommunities };
