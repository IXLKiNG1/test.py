'use strict';

const INVITE_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i;

function normalizeGid(value) {
  let raw = String(value || '').trim();
  if (!raw) throw new Error('أدخل GID للمجموعة.');
  raw = raw.replace(/\s+/g, '');
  if (raw.includes('@g.us')) return raw.endsWith('@g.us') ? raw : `${raw.split('@')[0]}@g.us`;
  if (/^[0-9A-Za-z:_-]+$/.test(raw)) return `${raw}@g.us`;
  throw new Error('صيغة GID غير صحيحة. مثال: 120363012345678901@g.us');
}

function extractInviteCode(value) {
  const raw = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return raw;
  const match = raw.match(INVITE_RE);
  if (!match) throw new Error('رابط الدعوة أو رمز الدعوة غير صالح. استخدم https://chat.whatsapp.com/... أو ألصق رمز الدعوة نفسه.');
  return match[1];
}

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value._serialized || value.$1 || value.serialized || value.id || '').trim();
}

function ownerOf(owner) {
  if (!owner) return null;
  const id = idOf(owner);
  return id || String(owner);
}

function participantCount(chat) {
  if (Array.isArray(chat?.participants)) return chat.participants.length;
  return Number(chat?.participantsCount || chat?.participantCount || chat?.memberCount || chat?.size || 0) || 0;
}
function adminCount(chat) {
  if (!Array.isArray(chat?.participants)) return Number(chat?.adminsCount || chat?.adminCount || 0) || 0;
  return chat.participants.filter(p => p?.isAdmin || p?.isSuperAdmin || ['admin','superadmin'].includes(String(p?.role || '').toLowerCase())).length;
}

function normalizeGroupInfo(info, fallbackGid = null) {
  const id = idOf(info?.id || info?.gid || fallbackGid);
  const gid = id.endsWith('@g.us') ? id : (fallbackGid || id);
  return {
    gid,
    name: String(info?.name || info?.subject || info?.title || 'مجموعة بدون اسم').trim(),
    description: String(info?.description || info?.desc || '').trim(),
    owner: ownerOf(info?.owner || info?.ownerJid),
    participantsCount: participantCount(info),
    adminsCount: adminCount(info),
    inviteCode: info?.inviteCode || info?.code || null,
    createdAt: info?.createdAt ? new Date(info.createdAt).toISOString?.() || info.createdAt : null,
    isGroup: info?.isGroup !== false,
    source: info?.source || 'chat'
  };
}

async function analyzeGid(client, gid) {
  const normalized = normalizeGid(gid);
  const chat = await client.getChatById(normalized);
  if (!chat || chat.isGroup !== true) throw new Error('المعرف موجود لكنه ليس مجموعة WhatsApp.');
  let inviteCode = null;
  if (typeof chat.getInviteCode === 'function') {
    try { inviteCode = await chat.getInviteCode(); } catch { inviteCode = null; }
  }
  return normalizeGroupInfo({ ...chat, inviteCode }, normalized);
}

async function analyzeInvite(client, urlOrCode) {
  const raw = String(urlOrCode || '').trim();
  const code = raw.includes('chat.whatsapp.com') ? extractInviteCode(raw) : raw.replace(/^.*invite\/?/i, '').trim();
  if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('رمز الدعوة غير صالح.');
  if (typeof client.getInviteInfo !== 'function') throw new Error('هذا الإصدار من WhatsApp لا يوفر تحليل معلومات الدعوة عبر الجلسة الحالية.');
  const info = await client.getInviteInfo(code);
  const result = normalizeGroupInfo({ ...(info || {}), inviteCode: code, source: 'invite' });
  return result;
}

function isGroupId(value) { return String(value || '').trim().endsWith('@g.us'); }
function formatGroupAnalysis(info) {
  const rows = [
    `اسم المجموعة: ${info?.name || 'غير متاح'}`,
    `GID: ${info?.gid || 'غير متاح'}`,
    `الأعضاء: ${Number(info?.participantsCount || 0) || 'غير متاح'}`,
    `المالك: ${info?.owner || 'غير متاح'}`,
    `الوصف: ${info?.description || 'لا يوجد وصف متاح'}`
  ];
  if (info?.inviteCode) rows.push(`Invite Code: ${info.inviteCode}`);
  return rows.join('\n');
}

module.exports = { normalizeGid, extractInviteCode, analyzeGid, analyzeInvite, normalizeGroupInfo, isGroupId, formatGroupAnalysis };
