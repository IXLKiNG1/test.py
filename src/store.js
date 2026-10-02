"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const APP_VERSION = '6.5.2';
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const DEFAULT_SETTINGS = {
  timezone: 'Asia/Muscat', scheduleEnabled: false, scheduleMode: 'weekly', scheduleDay: 5, scheduleTime: '17:30', scheduleDate: '', scheduledGroupsEnabled: true, scheduleTargets: [],
  preText: 'chat BOT', postText: '', sendOrder: 'target-first', sendTimeoutMs: 30000, sendDelayMs: 700, retryAttempts: 2, retryDelayMs: 1600, maxImageSizeMB: 20,
  autoStartSession: true, browserHeadless: true, interactionEnabled: true, groupAssistantEnabled: true, interactionIgnoreOwn: true, interactionScope: 'all', interactionChatIds: [], maxActionsPerMinute: 20,
  interactionCooldownCapSec: 86400, interactionQuietEnabled: false, interactionQuietStart: '23:00', interactionQuietEnd: '07:00',
  backgroundMode: 'aurora', backgroundImage: '', backgroundOpacity: .22,
  backgroundSettings: { speed: 1, density: 1, glow: .6, intensity: 1, interactive: true, trail: true }
};
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function safeSessionId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'main'; }
function getPaths(id) { const sid = safeSessionId(id), dir = path.join(SESSIONS_DIR, sid); return { id: sid, dir, json: path.join(dir, 'session.json'), auth: path.join(dir, 'auth'), media: path.join(dir, 'media'), images: path.join(dir, 'media'), backgrounds: path.join(dir, 'backgrounds'), logFile: path.join(dir, 'activity.log') }; }
function defaults(id, name) { return { id: safeSessionId(id), name: String(name || 'جلسة جديدة').slice(0, 80), setupComplete: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), settings: clone(DEFAULT_SETTINGS), recipients: [], groups: [], cycle: { round: 1, roundStartedAt: new Date().toISOString(), imageOrder: [], currentIndex: 0, delivery: {}, manualGuard: {} }, interaction: { enabled: true, rules: seedRules(), recent: [] }, stats: { sentMessages: 0, sentImages: 0, sentFiles: 0, confirmedAcks: 0, uncertainSends: 0, failedSends: 0, successfulRuns: 0, failedRuns: 0, interactionActions: 0, interactionErrors: 0 }, automation: { enabled: true, tasks: [], recent: [] }, logs: [], lastRun: null, lastBackup: null, scheduleState: { lastRunKey: '' } }; }
function seedRules() { return [
  { id: crypto.randomUUID(), name: 'ترحيب', enabled: true, priority: 30, when: { type: 'message', match: 'contains', value: 'السلام عليكم' }, then: { reply: 'وعليكم السلام {{sender}} 👋' }, scope: 'all', chatIds: [], cooldownSec: 45 },
  { id: crypto.randomUUID(), name: 'تحية', enabled: true, priority: 25, when: { type: 'message', match: 'contains', value: 'مرحبا' }, then: { reply: 'أهلًا {{sender}} ✨' }, scope: 'all', chatIds: [], cooldownSec: 45 },
  { id: crypto.randomUUID(), name: 'مساعدة البوت', enabled: true, priority: 20, when: { type: 'message', match: 'exact', value: '!help' }, then: { reply: 'الأوامر: !help — !gid — !group id\nيمكنك أيضًا استخدام قواعد التفاعل من لوحة التحكم.' }, scope: 'all', chatIds: [], cooldownSec: 30 }
]; }
function ensureDir(id) { const p = getPaths(id); for (const k of ['dir', 'media', 'backgrounds', 'auth']) fs.mkdirSync(p[k], { recursive: true }); return p; }
function saveSession(s) { const id = safeSessionId(s.id), p = ensureDir(id); const out = { ...s, id, updatedAt: new Date().toISOString() }; const tmp = p.json + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8'); fs.renameSync(tmp, p.json); return out; }
function loadSession(id) { const sid = safeSessionId(id), p = ensureDir(sid); if (!fs.existsSync(p.json)) return saveSession(defaults(sid, sid === 'main' ? 'الجلسة الرئيسية' : 'جلسة جديدة')); try { const s = JSON.parse(fs.readFileSync(p.json, 'utf8')); return normalizeSession(s, sid); } catch { const bad = p.json + '.broken-' + Date.now(); try { fs.renameSync(p.json, bad); } catch {} return saveSession(defaults(sid, 'جلسة مستعادة')); } }
function normalizeSession(s, sid) {
  const d = defaults(sid, s.name);
  s.id = sid; s.name = String(s.name || d.name).slice(0, 80);
  s.settings = { ...clone(DEFAULT_SETTINGS), ...(s.settings || {}), backgroundSettings: { ...clone(DEFAULT_SETTINGS.backgroundSettings), ...(s.settings?.backgroundSettings || {}) } };
  s.settings.scheduleDay = toInt(s.settings.scheduleDay, 5, 0, 6);
  s.settings.sendTimeoutMs = toInt(s.settings.sendTimeoutMs, 30000, 5000, 120000);
  s.settings.sendDelayMs = toInt(s.settings.sendDelayMs, 700, 0, 60000);
  s.settings.retryAttempts = toInt(s.settings.retryAttempts, 2, 1, 4);
  s.settings.retryDelayMs = toInt(s.settings.retryDelayMs, 1600, 250, 120000);
  s.settings.maxImageSizeMB = toInt(s.settings.maxImageSizeMB, 20, 1, 50);
  s.settings.maxActionsPerMinute = toInt(s.settings.maxActionsPerMinute, 20, 1, 1000);
  s.settings.browserHeadless = s.settings.browserHeadless !== false;
  s.settings.autoStartSession = s.settings.autoStartSession !== false;
  s.settings.interactionEnabled = s.settings.interactionEnabled !== false;
  s.settings.groupAssistantEnabled = s.settings.groupAssistantEnabled !== false;
  s.settings.interactionIgnoreOwn = s.settings.interactionIgnoreOwn !== false;
  s.settings.scheduledGroupsEnabled = s.settings.scheduledGroupsEnabled !== false;
  s.recipients = Array.isArray(s.recipients) ? s.recipients.map(normalizeRecipient) : []; s.groups = Array.isArray(s.groups) ? s.groups.map(normalizeStoredGroup) : []; s.settings.scheduleTargets = Array.isArray(s.settings.scheduleTargets) ? s.settings.scheduleTargets.filter(Boolean).map(String) : [];
  s.cycle = { ...d.cycle, ...(s.cycle || {}), delivery: s.cycle?.delivery || {}, manualGuard: s.cycle?.manualGuard || {} };
  s.interaction = { ...d.interaction, ...(s.interaction || {}), rules: Array.isArray(s.interaction?.rules) ? s.interaction.rules : seedRules(), recent: Array.isArray(s.interaction?.recent) ? s.interaction.recent : [] };
  s.stats = { ...d.stats, ...(s.stats || {}) }; s.automation = { ...d.automation, ...(s.automation || {}) }; s.logs = Array.isArray(s.logs) ? s.logs.slice(-400) : [];
  s.scheduleState = { ...d.scheduleState, ...(s.scheduleState || {}) }; return s;
}
function listSessionIds() { const ids = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).filter(Boolean); if (!ids.length) { saveSession(defaults('main', 'الجلسة الرئيسية')); ids.push('main'); } return ids.sort(); }
function activeSessionId() { const f = path.join(DATA_DIR, 'active-session'); try { return safeSessionId(fs.readFileSync(f, 'utf8').trim()) || listSessionIds()[0]; } catch { return listSessionIds()[0]; } }
function setActiveSession(id) { const sid = safeSessionId(id); if (!listSessionIds().includes(sid)) throw new Error('الجلسة غير موجودة.'); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'active-session'), sid, 'utf8'); return loadSession(sid); }
function createSession(name) { const id = 's-' + crypto.randomUUID(); saveSession(defaults(id, name)); setActiveSession(id); return loadSession(id); }
function renameSession(id, name) { const s = loadSession(id); s.name = String(name || '').trim().slice(0, 80) || s.name; return saveSession(s); }
function deleteSession(id) { const sid = safeSessionId(id); if (listSessionIds().length <= 1) throw new Error('لا يمكن حذف آخر جلسة.'); const was = activeSessionId() === sid; fs.rmSync(getPaths(sid).dir, { recursive: true, force: true }); if (was) setActiveSession(listSessionIds()[0]); return { activeSessionId: activeSessionId() }; }
function toInt(v, d, min = -Infinity, max = Infinity) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : d; }

function normalizeRecipient(r) {
  const x = r || {};
  const phone = String(x.phone || x.digits || '').replace(/\D/g, '');
  return {
    id: x.id || crypto.randomUUID(),
    name: String(x.name || 'مستلم').slice(0, 80),
    phone,
    digits: phone,
    country: String(x.country || '').toUpperCase(),
    callingCode: String(x.callingCode || ''),
    international: String(x.international || x.formatted || phone),
    national: String(x.national || ''),
    formatted: String(x.formatted || x.international || phone),
    enabled: x.enabled !== false
  };
}
function normalizeStoredGroup(g) {
  return normalizeGroup(g || {});
}

function normalizeGroup(g) { return { id: g.id || crypto.randomUUID(), name: String(g.name || 'مجموعة').slice(0, 120), gid: String(g.gid || '').trim().toLowerCase(), inviteCode: g.inviteCode || '', description: String(g.description || '').slice(0, 1000), owner: String(g.owner || '').slice(0, 150), participantsCount: Number.isFinite(Number(g.participantsCount)) ? Number(g.participantsCount) : null, discoveredAt: g.discoveredAt || new Date().toISOString(), updatedAt: new Date().toISOString(), enabled: g.enabled !== false }; }
module.exports = { ROOT, DATA_DIR, SESSIONS_DIR, APP_VERSION, DEFAULT_SETTINGS, clone, safeSessionId, getPaths, saveSession, loadSession, listSessionIds, activeSessionId, setActiveSession, createSession, renameSession, deleteSession, toInt, normalizeGroup, normalizeRecipient, ensureDir };
