'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.BOT_DATA_ROOT || path.join(ROOT, 'data'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
const APP_VERSION = '6.0.0';
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const BACKGROUND_DEFAULTS = {
  aurora: { color1:'#49e6a1', color2:'#56a8ff', speed:0.62, intensity:0.68, ribbons:4, glow:0.62, contrast:0.62, depth:0.58 },
  grid: { color:'#43c6ff', speed:0.72, density:58, horizon:0.44, glow:0.56, perspective:0.74, scanlines:0.42, pulse:0.48 },
  stars: { color:'#ffffff', density:0.62, twinkle:0.72, drift:0.24, glow:0.55, depth:0.72, shooting:0.18 },
  particles: { color:'#5ff2c2', density:0.58, speed:0.52, links:110, glow:0.62, size:1.0, attraction:0.18 },
  orbits: { color:'#6fb9ff', rings:4, speed:0.38, tilt:0.28, glow:0.72, core:0.72, particles:0.62 },
  waves: { color:'#68e8c0', speed:0.72, waves:5, amplitude:36, glow:0.58, depth:0.64, scanlines:0.28 },
  matrix: { color:'#00ff66', speed:0.92, density:0.82, glow:0.92, trail:0.78, fontSize:16, charset:'cyber', flicker:0.22, scanlines:0.62, head:0.98, grid:0.28 },
  nebula: { color1:'#7f5cff', color2:'#28d7ff', color3:'#ff4fd8', density:0.72, drift:0.34, glow:0.86, scale:1.0, turbulence:0.72, interaction:0.92, pulses:0.78, stars:0.42 },
  meteor: { color:'#d9f4ff', accent:'#79f2ff', speed:1.0, frequency:0.72, trail:0.72, glow:0.88, stars:0.62, curvature:0.62, interaction:0.92, burst:0.82, shake:0.22 }
};

function backgroundDefaults(mode) {
  const key = Object.prototype.hasOwnProperty.call(BACKGROUND_DEFAULTS, mode) ? mode : 'aurora';
  return clone(BACKGROUND_DEFAULTS[key]);
}

const BACKGROUND_LIMITS = {
  speed:[0.01,2.5], intensity:[0,1], ribbons:[2,10], glow:[0,1], contrast:[0,1], depth:[0,1],
  density:[0.05,1], horizon:[0.2,0.8], perspective:[0,1], scanlines:[0,1], pulse:[0,1], twinkle:[0,1], drift:[0,1], shooting:[0,1],
  links:[20,260], size:[0.2,3], attraction:[0,1], rings:[2,9], tilt:[0,1], core:[0,1], particles:[0.05,1], waves:[2,12], amplitude:[4,110],
  trail:[0.05,1], fontSize:[9,32], flicker:[0,1], head:[0,1], grid:[0,1], turbulence:[0,1], scale:[0.35,2.4], interaction:[0,1], pulses:[0,1], stars:[0,1],
  frequency:[0.05,1.5], curvature:[0,1], burst:[0,1], shake:[0,1]
};
function cleanHex(value, fallback) {
  const v=String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v) ? v : fallback;
}
function normalizeBackgroundSettings(mode, input) {
  const key = Object.prototype.hasOwnProperty.call(BACKGROUND_DEFAULTS, mode) ? mode : 'aurora';
  const base = backgroundDefaults(key);
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...base, ...src };
  for (const keyName of Object.keys(base)) {
    if (typeof base[keyName] === 'number') {
      const n=Number(out[keyName]);
      const range=BACKGROUND_LIMITS[keyName];
      const value=Number.isFinite(n)?n:base[keyName];
      out[keyName]=range?Math.max(range[0],Math.min(range[1],value)):value;
    } else if (typeof base[keyName] === 'string') {
      if (/^color|^accent$/i.test(keyName)) out[keyName]=cleanHex(out[keyName],base[keyName]);
      else out[keyName]=String(out[keyName] ?? base[keyName]).slice(0,120);
    }
  }
  if ('charset' in base && !['cyber','binary','ascii','numeric'].includes(String(out.charset))) out.charset=base.charset;
  return out;
}

const DEFAULTS = {
  scheduleEnabled: true,
  timezone: 'Asia/Muscat',
  dayOfWeek: 5,
  hour: 17,
  minute: 30,
  catchUpMinutes: 60,
  retryAttempts: 3,
  retryDelayMs: 2000,
  sendDelayMs: 1000,
  preText: 'chat BOT',
  postText: '',
  maxImageSizeMB: 50,
  browserHeadless: false,
  autoReconnect: true,
  autoStartSession: true,
  interactionEnabled: false,
  interactionScope: 'all',
  interactionChatIds: [],
  interactionIgnoreOwn: true,
  maxActionsPerMinute: 12,
  interactionQuietEnabled: false,
  interactionQuietStart: '22:00',
  interactionQuietEnd: '07:00',
  backgroundMode: 'aurora',
  backgroundImage: null,
  backgroundOpacity: 0.34,
  backgroundSettings: backgroundDefaults('aurora'),
  backgroundProfiles: clone(BACKGROUND_DEFAULTS),
  backgroundAutoSave: true,
  ackObservationMs: 7000,
  uiActionTimeoutMs: 120000,
  interactionCooldownCapSec: 86400,
  sendTimeoutMs: 60000,
  maxInstantPairs: 250,
  instantDuplicateGuard: true,
  instantCountTowardCycle: false,
  sendOrder: 'target-first',
  scheduledGroupsEnabled: true,
  groupAssistantEnabled: true,
  automationEnabled: true
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function normalize(value) { return String(value ?? '').normalize('NFKC').trim(); }
function toInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}
function safeSessionId(value) {
  const original = normalize(value).toLowerCase();
  const base = original.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (base) return base;
  if (!original) return 'default';
  const digest = crypto.createHash('sha1').update(original, 'utf8').digest('hex').slice(0, 10);
  return `session-${digest}`;
}
function validTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}
function atomicWrite(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch {}
    fs.renameSync(tmp, file);
  }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return clone(fallback); }
}

function defaultRule(id, name) {
  return {
    id: id || crypto.randomUUID(),
    name: normalize(name || 'قاعدة جديدة').slice(0, 80),
    enabled: true,
    when: { type: 'message', match: 'contains', value: 'سلام' },
    then: { reply: 'وعليكم السلام 👋', reaction: '' },
    cooldownSec: 30,
    priority: 0,
    scope: 'all',
    chatIds: [],
    createdAt: new Date().toISOString()
  };
}
function normalizeRule(item) {
  const base = defaultRule(item?.id, item?.name);
  const when = item?.when || item?.trigger || {};
  const then = item?.then || item?.action || {};
  return {
    ...base,
    name: normalize(item?.name || base.name).slice(0, 80),
    enabled: item?.enabled !== false,
    when: {
      type: when.type === 'reaction' ? 'reaction' : 'message',
      match: ['any', 'contains', 'exact', 'starts', 'ends', 'regex'].includes(when.match) ? when.match : 'contains',
      value: String(when.value || '').slice(0, 300),
      ignoreCase: when.ignoreCase !== false
    },
    then: {
      reply: String(then.reply ?? then.replyText ?? '').slice(0, 1500),
      reaction: String(then.reaction ?? '').slice(0, 12),
      stopAfter: then.stopAfter !== false
    },
    scope: ['all', 'private', 'groups', 'selected'].includes(item?.scope) ? item.scope : 'all',
    chatIds: Array.isArray(item?.chatIds) ? item.chatIds.map(String).slice(0, 100) : [],
    cooldownSec: toInt(item?.cooldownSec, 30, 0, 604800),
    priority: toInt(item?.priority, 0, -100, 1000),
    createdAt: item?.createdAt || base.createdAt
  };
}
function normalizeRecipient(item) {
  return {
    id: String(item?.id || crypto.randomUUID()),
    name: normalize(item?.name || '').slice(0, 80),
    phone: normalize(item?.phone || '').replace(/^\+/, '').slice(0, 32),
    country: normalize(item?.country || '').slice(0, 4).toUpperCase() || null,
    callingCode: normalize(item?.callingCode || '').slice(0, 8) || null,
    formatted: normalize(item?.formatted || '').slice(0, 64) || null,
    national: normalize(item?.national || '').slice(0, 64) || null,
    enabled: item?.enabled !== false,
    createdAt: item?.createdAt || new Date().toISOString()
  };
}
function normalizeGroup(item) {
  return {
    id: String(item?.id || crypto.randomUUID()),
    name: normalize(item?.name || '').slice(0, 120),
    gid: normalize(item?.gid || item?.chatId || '').slice(0, 180),
    inviteCode: normalize(item?.inviteCode || '').slice(0, 200) || null,
    description: normalize(item?.description || '').slice(0, 1000),
    owner: normalize(item?.owner || '').slice(0, 120) || null,
    participantsCount: Math.max(0, toInt(item?.participantsCount, 0, 0, 100000)),
    adminsCount: Math.max(0, toInt(item?.adminsCount, 0, 0, 100000)),
    discoveredAt: item?.discoveredAt || new Date().toISOString(),
    updatedAt: item?.updatedAt || new Date().toISOString(),
    enabled: item?.enabled !== false
  };
}
function normalizeTask(item) {
  const targets = item?.targets && typeof item.targets === 'object' ? item.targets : {};
  const repeat = item?.repeat && typeof item.repeat === 'object' ? item.repeat : {};
  return {
    id: String(item?.id || crypto.randomUUID()),
    name: normalize(item?.name || 'مهمة جديدة').slice(0, 100),
    enabled: item?.enabled !== false,
    kind: ['text', 'image', 'sequence'].includes(item?.kind) ? item.kind : 'text',
    runAt: item?.runAt ? String(item.runAt) : null,
    timezone: validTimezone(item?.timezone) ? String(item.timezone) : 'Asia/Muscat',
    targets: {
      recipientIds: Array.isArray(targets.recipientIds) ? targets.recipientIds.map(String).slice(0, 100) : [],
      groupIds: Array.isArray(targets.groupIds) ? targets.groupIds.map(String).slice(0, 100) : []
    },
    messageText: String(item?.messageText || '').slice(0, 2000),
    imageId: item?.imageId ? String(item.imageId) : null,
    preText: String(item?.preText || '').slice(0, 1000),
    postText: String(item?.postText || '').slice(0, 1000),
    repeat: {
      kind: ['once', 'daily', 'weekly', 'monthly'].includes(repeat.kind) ? repeat.kind : 'once',
      interval: toInt(repeat.interval, 1, 1, 31)
    },
    lastRunAt: item?.lastRunAt || null,
    lastStatus: item?.lastStatus || null,
    lastError: item?.lastError || null,
    nextRunAt: item?.nextRunAt || item?.runAt || null,
    createdAt: item?.createdAt || new Date().toISOString(),
    updatedAt: item?.updatedAt || new Date().toISOString()
  };
}
function defaultSession(id, name) {
  const now = new Date().toISOString();
  return {
    id,
    name: normalize(name || id).slice(0, 80) || id,
    createdAt: now,
    updatedAt: now,
    setupComplete: false,
    recipients: [],
    groups: [],
    settings: clone(DEFAULTS),
    interaction: { enabled: false, scope: 'all', chatIds: [], ignoreOwnMessages: true, rules: [], recent: [] },
    automation: { enabled: true, tasks: [], recent: [] },
    cycle: { imageOrder: [], currentIndex: 0, round: 1, roundStartedAt: now, delivery: {}, manualGuard: {} },
    schedule: { lastSuccessKey: null, lastAttemptKey: null, lastAttemptAt: null, nextRetryAt: null, lastError: null },
    stats: { sentImages: 0, sentMessages: 0, failedSends: 0, successfulRuns: 0, failedRuns: 0, interactionActions: 0, interactionErrors: 0, confirmedAcks: 0, uncertainSends: 0, skippedDuplicates: 0 },
    lastRun: null,
    lastBackup: null,
    logs: []
  };
}
function normalizeSession(input, id) {
  const base = defaultSession(id, id);
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...base, ...src };
  out.id = id;
  out.name = normalize(src.name || id).slice(0, 80) || id;
  out.settings = { ...base.settings, ...(src.settings || {}) };
  out.settings.timezone = validTimezone(out.settings.timezone) ? out.settings.timezone : 'Asia/Muscat';
  out.settings.scheduleEnabled = toBool(out.settings.scheduleEnabled, true);
  out.settings.dayOfWeek = toInt(out.settings.dayOfWeek, 5, 0, 6);
  out.settings.hour = toInt(out.settings.hour, 17, 0, 23);
  out.settings.minute = toInt(out.settings.minute, 30, 0, 59);
  out.settings.catchUpMinutes = toInt(out.settings.catchUpMinutes, 60, 0, 360);
  out.settings.retryAttempts = toInt(out.settings.retryAttempts, 3, 1, 5);
  out.settings.retryDelayMs = toInt(out.settings.retryDelayMs, 2000, 250, 20000);
  out.settings.sendDelayMs = toInt(out.settings.sendDelayMs, 1000, 0, 15000);
  out.settings.maxImageSizeMB = toInt(out.settings.maxImageSizeMB, 50, 1, 100);
  out.settings.browserHeadless = toBool(out.settings.browserHeadless, false);
  out.settings.autoReconnect = toBool(out.settings.autoReconnect, true);
  out.settings.autoStartSession = toBool(out.settings.autoStartSession, true);
  out.settings.interactionEnabled = toBool(out.settings.interactionEnabled, false);
  out.settings.interactionScope = ['all', 'private', 'groups', 'selected'].includes(out.settings.interactionScope) ? out.settings.interactionScope : 'all';
  out.settings.interactionChatIds = Array.isArray(out.settings.interactionChatIds) ? out.settings.interactionChatIds.map(x => String(x).trim()).filter(Boolean).slice(0, 200) : [];
  out.settings.interactionIgnoreOwn = toBool(out.settings.interactionIgnoreOwn, true);
  out.settings.maxActionsPerMinute = toInt(out.settings.maxActionsPerMinute, 12, 1, 120);
  out.settings.interactionQuietEnabled = toBool(out.settings.interactionQuietEnabled, false);
  out.settings.interactionQuietStart = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(out.settings.interactionQuietStart || '')) ? String(out.settings.interactionQuietStart) : '22:00';
  out.settings.interactionQuietEnd = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(out.settings.interactionQuietEnd || '')) ? String(out.settings.interactionQuietEnd) : '07:00';
  out.settings.backgroundMode = ['aurora','grid','stars','particles','orbits','waves','matrix','nebula','meteor'].includes(out.settings.backgroundMode) ? out.settings.backgroundMode : 'aurora';
  out.settings.backgroundImage = out.settings.backgroundImage && typeof out.settings.backgroundImage === 'string' ? out.settings.backgroundImage : null;
  out.settings.backgroundOpacity = Math.max(0.05, Math.min(0.9, Number.isFinite(Number(out.settings.backgroundOpacity)) ? Number(out.settings.backgroundOpacity) : 0.34));
  const incomingProfiles = out.settings.backgroundProfiles && typeof out.settings.backgroundProfiles === 'object' ? out.settings.backgroundProfiles : {};
  out.settings.backgroundProfiles = {};
  for (const mode of Object.keys(BACKGROUND_DEFAULTS)) out.settings.backgroundProfiles[mode] = normalizeBackgroundSettings(mode, incomingProfiles[mode]);
  out.settings.backgroundAutoSave = toBool(out.settings.backgroundAutoSave, true);
  out.settings.backgroundSettings = normalizeBackgroundSettings(out.settings.backgroundMode, out.settings.backgroundSettings || out.settings.backgroundProfiles[out.settings.backgroundMode]);
  out.settings.backgroundProfiles[out.settings.backgroundMode] = clone(out.settings.backgroundSettings);
  out.settings.ackObservationMs = toInt(out.settings.ackObservationMs, 7000, 500, 15000);
  out.settings.uiActionTimeoutMs = toInt(out.settings.uiActionTimeoutMs, 120000, 30000, 300000);
  out.settings.interactionCooldownCapSec = toInt(out.settings.interactionCooldownCapSec, 86400, 60, 604800);
  out.settings.sendTimeoutMs = toInt(out.settings.sendTimeoutMs, 60000, 15000, 120000);
  out.settings.maxInstantPairs = toInt(out.settings.maxInstantPairs, 250, 1, 1000);
  out.settings.instantDuplicateGuard = toBool(out.settings.instantDuplicateGuard, true);
  out.settings.instantCountTowardCycle = toBool(out.settings.instantCountTowardCycle, false);
  out.settings.sendOrder = ['target-first','image-first'].includes(out.settings.sendOrder) ? out.settings.sendOrder : 'target-first';
  out.settings.preText = String(out.settings.preText ?? 'chat BOT').trim();
  out.settings.postText = String(out.settings.postText ?? '').trim();
  out.recipients = Array.isArray(src.recipients) ? src.recipients.map(normalizeRecipient).filter(r => r.name) : [];
  out.groups = Array.isArray(src.groups) ? src.groups.map(normalizeGroup).filter(g => g.name && g.gid) : [];
  out.settings.scheduledGroupsEnabled = toBool(out.settings.scheduledGroupsEnabled, true);
  out.settings.groupAssistantEnabled = toBool(out.settings.groupAssistantEnabled, true);
  out.settings.automationEnabled = toBool(out.settings.automationEnabled, true);
  out.interaction = { ...base.interaction, ...(src.interaction || {}) };
  out.interaction.enabled = toBool(out.interaction.enabled, out.settings.interactionEnabled);
  out.interaction.scope = ['all', 'private', 'groups', 'selected'].includes(out.interaction.scope) ? out.interaction.scope : out.settings.interactionScope;
  out.interaction.chatIds = Array.isArray(out.interaction.chatIds) ? out.interaction.chatIds.map(x => String(x).trim()).filter(Boolean).slice(0, 200) : out.settings.interactionChatIds.slice();
  out.interaction.ignoreOwnMessages = toBool(out.interaction.ignoreOwnMessages, out.settings.interactionIgnoreOwn);
  out.interaction.rules = Array.isArray(out.interaction.rules) ? out.interaction.rules.map(normalizeRule).slice(0, 100) : [];
  out.automation = { ...base.automation, ...(src.automation || {}) };
  out.automation.enabled = toBool(out.automation.enabled, out.settings.automationEnabled);
  out.automation.tasks = Array.isArray(out.automation.tasks) ? out.automation.tasks.map(normalizeTask).slice(0, 200) : [];
  out.automation.recent = Array.isArray(out.automation.recent) ? out.automation.recent.slice(-300) : [];
  out.interaction.recent = Array.isArray(out.interaction.recent) ? out.interaction.recent.slice(-200) : [];
  out.cycle = { ...base.cycle, ...(src.cycle || {}) };
  out.cycle.round = Math.max(1, toInt(out.cycle.round, 1, 1, 1000000000));
  out.cycle.roundStartedAt = out.cycle.roundStartedAt || out.createdAt;
  out.cycle.imageOrder = Array.isArray(out.cycle.imageOrder) ? out.cycle.imageOrder.map(String) : [];
  out.cycle.currentIndex = toInt(out.cycle.currentIndex, 0, 0, 1000000);
  out.cycle.delivery = out.cycle.delivery && typeof out.cycle.delivery === 'object' ? out.cycle.delivery : {};
  out.cycle.manualGuard = out.cycle.manualGuard && typeof out.cycle.manualGuard === 'object' ? out.cycle.manualGuard : {};
  for (const [imageId, targets] of Object.entries(out.cycle.manualGuard)) out.cycle.manualGuard[imageId] = targets && typeof targets === 'object' ? targets : {};
  out.schedule = { ...base.schedule, ...(src.schedule || {}) };
  out.stats = { ...base.stats, ...(src.stats || {}) };
  for (const key of Object.keys(base.stats)) out.stats[key] = Math.max(0, Number.isFinite(Number(out.stats[key])) ? Number(out.stats[key]) : 0);
  out.stats.skippedDuplicates = Math.max(0, Number.isFinite(Number(out.stats.skippedDuplicates)) ? Number(out.stats.skippedDuplicates) : 0);
  out.logs = Array.isArray(out.logs) ? out.logs.slice(-400) : [];
  return out;
}
function sessionDir(id) { return path.join(SESSIONS_DIR, safeSessionId(id)); }
function sessionFile(id) { return path.join(sessionDir(id), 'session.json'); }
function getPaths(id) {
  const dir = sessionDir(id);
  return { dir, file: sessionFile(id), images: path.join(dir, 'images'), uploads: path.join(dir, '_uploads'), backgrounds: path.join(dir, 'backgrounds'), authRoot: path.join(dir, 'auth'), logs: path.join(dir, 'logs'), logFile: path.join(dir, 'logs', 'bot.log'), backups: path.join(dir, 'backups') };
}
function prepareSessionDirs(id) {
  const p = getPaths(id);
  for (const d of [p.dir, p.images, p.uploads, p.backgrounds, p.authRoot, p.logs, p.backups]) ensureDir(d);
  if (!fs.existsSync(p.logFile)) fs.writeFileSync(p.logFile, '', 'utf8');
}
function globalDefault() { return { sessions: [], activeSessionId: null, createdAt: new Date().toISOString() }; }
function loadGlobal() { ensureDir(DATA_DIR); return readJson(GLOBAL_FILE, globalDefault()); }
function saveGlobal(value) { return atomicWrite(GLOBAL_FILE, value); }
function ensureDefault() {
  const global = loadGlobal();
  if (!Array.isArray(global.sessions)) global.sessions = [];
  global.sessions = [...new Set(global.sessions.map(safeSessionId))];
  if (!global.sessions.length) {
    const session = defaultSession('default', 'الجلسة الرئيسية');
    prepareSessionDirs('default');
    atomicWrite(sessionFile('default'), session);
    global.sessions = ['default'];
    global.activeSessionId = 'default';
    saveGlobal(global);
  } else {
    for (const id of global.sessions) {
      prepareSessionDirs(id);
      if (!fs.existsSync(sessionFile(id))) atomicWrite(sessionFile(id), defaultSession(id, id));
    }
    if (!global.activeSessionId || !global.sessions.includes(global.activeSessionId)) {
      global.activeSessionId = global.sessions[0];
      saveGlobal(global);
    }
  }
  return global;
}
function listSessionIds() { return ensureDefault().sessions.slice(); }
function activeSessionId() { return ensureDefault().activeSessionId; }
function assertSession(id) {
  const safe = safeSessionId(id);
  if (!listSessionIds().includes(safe)) throw new Error('الجلسة غير موجودة.');
  return safe;
}
function setActiveSession(id) {
  const safe = assertSession(id);
  const global = ensureDefault();
  global.activeSessionId = safe;
  saveGlobal(global);
  return loadSession(safe);
}
function loadSession(id) {
  const safe = safeSessionId(id);
  prepareSessionDirs(safe);
  return normalizeSession(readJson(sessionFile(safe), defaultSession(safe, safe)), safe);
}
function saveSession(session) {
  const safe = safeSessionId(session.id);
  const normalized = normalizeSession(session, safe);
  normalized.updatedAt = new Date().toISOString();
  atomicWrite(sessionFile(safe), normalized);
  return normalized;
}
function createSession(name) {
  const global = ensureDefault();
  const requestedName = normalize(name || 'جلسة جديدة');
  const base = safeSessionId(requestedName);
  let id = base; let n = 2;
  while (global.sessions.includes(id)) id = `${base}-${n++}`;
  const session = defaultSession(id, requestedName || id);
  prepareSessionDirs(id);
  atomicWrite(sessionFile(id), session);
  global.sessions.push(id);
  global.activeSessionId = id;
  saveGlobal(global);
  return session;
}
function renameSession(id, name) {
  const session = loadSession(assertSession(id));
  session.name = normalize(name).slice(0, 80) || session.id;
  return saveSession(session);
}
function deleteSession(id) {
  const global = ensureDefault();
  const safe = assertSession(id);
  if (global.sessions.length === 1) throw new Error('لا يمكن حذف آخر جلسة.');
  global.sessions = global.sessions.filter(x => x !== safe);
  if (global.activeSessionId === safe) global.activeSessionId = global.sessions[0];
  saveGlobal(global);
  try { fs.rmSync(sessionDir(safe), { recursive: true, force: true }); } catch {}
  return global;
}

ensureDefault();

module.exports = { APP_VERSION, ROOT, DATA_DIR, SESSIONS_DIR, WEEKDAYS, BACKGROUND_DEFAULTS, DEFAULTS, clone, normalize, toInt, toBool, safeSessionId, validTimezone, backgroundDefaults, normalizeBackgroundSettings, getPaths, defaultRule, normalizeRule, normalizeRecipient, normalizeGroup, normalizeTask, prepareSessionDirs, listSessionIds, activeSessionId, assertSession, setActiveSession, loadSession, saveSession, createSession, renameSession, deleteSession };
