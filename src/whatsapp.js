'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { applyPatch } = require('../scripts/patch-whatsapp');
const phones = require('./phones');
const patchResult = applyPatch();
if (!patchResult.ok) throw new Error(`WhatsApp compatibility patch failed: ${patchResult.errors.join('; ')}`);

const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function withTimeout(promise, timeoutMs, label = 'العملية') {
  const ms = Math.max(1000, Number(timeoutMs) || 60000);
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} تجاوز مهلة ${Math.round(ms / 1000)} ثانية.`), { code: 'SEND_TIMEOUT' })), ms); })
  ]).finally(() => clearTimeout(timer));
}
function safeError(error) { return String(error?.message || error || 'خطأ غير معروف'); }
function normalizeDigits(value) {
  return String(value || '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}
function normalizePhone(value, country = 'OM') {
  try { return phones.parse(value, country || 'OM').digits; }
  catch { return normalizeDigits(value).replace(/\D/g, ''); }
}
function serializedId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const direct = value._serialized || value.$1 || value.serialized || value.id;
  if (direct) return String(direct).trim();
  if (value.fromMe !== undefined && value.remote && value.id) {
    return `${Boolean(value.fromMe)}_${value.remote}_${value.id}`;
  }
  return '';
}
function normalizeMessageObject(message) {
  try {
    if (message?.id && !message.id._serialized && message.id.$1) message.id._serialized = message.id.$1;
    if (message?._data?.id && !message._data.id._serialized && message._data.id.$1) message._data.id._serialized = message._data.id.$1;
  } catch {}
  return message;
}
function normalizeReactionObject(reaction) {
  try {
    const ids = [reaction?.id, reaction?.msgId];
    for (const obj of ids) {
      if (obj && !obj._serialized && obj.$1) obj._serialized = obj.$1;
      if (obj && !obj._serialized && obj.fromMe !== undefined && obj.remote && obj.id) obj._serialized = `${Boolean(obj.fromMe)}_${obj.remote}_${obj.id}`;
    }
  } catch {}
  return reaction;
}
function browserCandidates() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}
function browserExecutable() {
  const explicit = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  return browserCandidates().find(x => fs.existsSync(x)) || null;
}

class WhatsAppManager extends EventEmitter {
  constructor({ store, log }) {
    super();
    this.store = store;
    this.log = log;
    this.items = new Map();
    this.shuttingDown = false;
  }
  runtime(id) {
    const safe = this.store.safeSessionId(id);
    if (!this.items.has(safe)) this.items.set(safe, {
      client: null, qr: null, status: 'stopped', browser: null,
      reconnectTimer: null, reconnectAttempts: 0, generation: 0,
      startPromise: null, stopPromise: null, intentionalStop: false,
      queue: Promise.resolve(), lastEvent: null, lastReadyAt: null,
      lastDisconnect: null, messageEvents: 0, reactionEvents: 0,
      ackEvents: 0, pendingAcks: new Map(), lastAck: null, ackHistory: [], lastSent: null,
      chatCache: new Map()
    });
    return this.items.get(safe);
  }
  listRuntime(id) {
    const r = this.runtime(id);
    return {
      status: r.status,
      ready: Boolean(r.client && r.status === 'ready'),
      qr: r.qr,
      browser: r.browser,
      reconnectAttempts: r.reconnectAttempts,
      lastEvent: r.lastEvent,
      lastReadyAt: r.lastReadyAt,
      lastDisconnect: r.lastDisconnect,
      messageEvents: r.messageEvents,
      reactionEvents: r.reactionEvents,
      ackEvents: r.ackEvents,
      lastAck: r.lastAck,
      ackHistory: r.ackHistory.slice(-12),
      lastSent: r.lastSent
    };
  }
  isReady(id) { return this.listRuntime(id).ready; }
  hasSavedAuth(id) {
    const p = this.store.getPaths(id).authRoot;
    try { return fs.existsSync(p) && fs.readdirSync(p).some(x => x.startsWith('session-')); } catch { return false; }
  }
  async start(id) {
    const safe = this.store.safeSessionId(id);
    const r = this.runtime(safe);
    if (r.startPromise) return r.startPromise;
    if (r.stopPromise) await r.stopPromise;
    if (r.client) return this.listRuntime(safe);
    if (this.shuttingDown) throw new Error('البوت في وضع الإيقاف.');

    r.startPromise = (async () => {
      const session = this.store.loadSession(safe);
      const browser = browserExecutable();
      if (!browser) throw new Error('لم يتم العثور على Google Chrome أو Microsoft Edge المثبت على الجهاز.');
      r.intentionalStop = false;
      r.chatCache.clear();
      r.status = 'starting';
      r.qr = null;
      r.browser = browser;
      r.generation += 1;
      const generation = r.generation;
      const auth = new LocalAuth({
        dataPath: this.store.getPaths(safe).authRoot,
        clientId: this.store.safeSessionId(safe),
        rmMaxRetries: 12
      });
      const client = new Client({
        authStrategy: auth,
        takeoverOnConflict: false,
        takeoverTimeoutMs: 5000,
        authTimeoutMs: 120000,
        qrMaxRetries: 6,
        puppeteer: {
          headless: session.settings.browserHeadless,
          executablePath: browser,
          protocolTimeout: 120000,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--disable-renderer-backgrounding'
          ]
        }
      });
      r.client = client;
      const current = () => r.client === client && r.generation === generation;
      const event = (name, data = null) => { if (current()) r.lastEvent = { name, data, at: new Date().toISOString() }; };

      client.on('qr', qr => {
        if (!current()) return;
        r.status = 'qr';
        r.qr = null;
        QRCode.toDataURL(qr, { width: 320, margin: 1 }).then(data => {
          if (current()) r.qr = data;
        }).catch(error => this.log(safe, 'WARN', `تعذر إنشاء QR: ${safeError(error)}`));
        event('qr');
        this.log(safe, 'INFO', 'QR جاهز. افتح الجلسة وامسح الرمز من WhatsApp > الأجهزة المرتبطة.');
      });
      client.on('authenticated', () => {
        if (!current()) return;
        r.status = 'authenticated';
        r.qr = null;
        r.reconnectAttempts = 0;
        event('authenticated');
        this.log(safe, 'INFO', 'تمت مصادقة جلسة WhatsApp.');
      });
      client.on('ready', () => {
        if (!current()) return;
        r.status = 'ready';
        r.qr = null;
        r.reconnectAttempts = 0;
        r.lastReadyAt = new Date().toISOString();
        event('ready');
        this.log(safe, 'INFO', 'جلسة WhatsApp جاهزة للإرسال والاستقبال.');
      });
      client.on('auth_failure', message => {
        if (!current()) return;
        r.status = 'auth_failure';
        r.client = null;
        Promise.resolve(client.destroy()).catch(error => this.log(safe, 'WARN', `تعذر تنظيف جلسة المصادقة الفاشلة: ${safeError(error)}`));
        event('auth_failure', String(message));
        this.log(safe, 'ERROR', `فشل المصادقة: ${message}`);
      });
      client.on('disconnected', reason => {
        if (!current()) return;
        const why = String(reason || 'UNKNOWN');
        r.status = why === 'LOGOUT' ? 'logged_out' : 'disconnected';
        r.qr = null;
        r.lastDisconnect = { reason: why, at: new Date().toISOString() };
        r.chatCache.clear();
        r.client = null;
        event('disconnected', why);
        this.log(safe, 'WARN', `انفصلت الجلسة: ${why}`);
        if (!r.intentionalStop && why !== 'LOGOUT' && this.store.loadSession(safe).settings.autoReconnect) this.scheduleReconnect(safe);
      });
      client.on('change_state', state => {
        if (current()) event('state', String(state));
      });
      client.on('message_ack', (message, ack) => {
        if (!current()) return;
        r.ackEvents += 1;
        const id = serializedId(message?.id);
        r.lastAck = { id, ack: Number(ack), at: new Date().toISOString() };
        r.ackHistory.push(r.lastAck);
        r.ackHistory = r.ackHistory.slice(-50);
        const waiter = id ? r.pendingAcks.get(id) : null;
        if (waiter) {
          r.pendingAcks.delete(id);
          waiter(Number(ack));
        }
      });
      client.on('message', message => {
        if (!current()) return;
        r.messageEvents += 1;
        this.emit('message', safe, normalizeMessageObject(message));
      });
      client.on('message_reaction', reaction => {
        if (!current()) return;
        r.reactionEvents += 1;
        this.emit('reaction', safe, normalizeReactionObject(reaction));
      });
      await client.initialize();
      return this.listRuntime(safe);
    })().catch(error => {
      r.status = 'error';
      r.client = null;
      this.log(safe, 'ERROR', `فشل تشغيل WhatsApp: ${safeError(error)}`);
      throw error;
    }).finally(() => {
      r.startPromise = null;
    });
    return r.startPromise;
  }
  scheduleReconnect(id) {
    const safe = this.store.safeSessionId(id);
    const r = this.runtime(safe);
    if (r.reconnectTimer || r.intentionalStop || this.shuttingDown) return;
    r.reconnectAttempts = Math.min(r.reconnectAttempts + 1, 8);
    const delay = Math.min(5000 * Math.pow(2, Math.max(0, r.reconnectAttempts - 1)), 120000);
    this.log(safe, 'WARN', `ستتم محاولة إعادة الاتصال بعد ${Math.ceil(delay / 1000)} ثانية.`);
    r.reconnectTimer = setTimeout(async () => {
      r.reconnectTimer = null;
      if (r.intentionalStop || this.shuttingDown) return;
      try {
        await this.stop(safe);
        await sleep(1500);
        await this.start(safe);
      } catch (error) {
        this.log(safe, 'ERROR', `فشلت إعادة الاتصال: ${safeError(error)}`);
        this.scheduleReconnect(safe);
      }
    }, delay);
  }
  async stop(id, { clearAuth = false } = {}) {
    const safe = this.store.safeSessionId(id);
    const r = this.runtime(safe);
    if (r.stopPromise) return r.stopPromise;
    r.stopPromise = (async () => {
      r.intentionalStop = true;
      if (r.reconnectTimer) clearTimeout(r.reconnectTimer);
      r.reconnectTimer = null;
      const client = r.client;
      for (const done of r.pendingAcks.values()) { try { done(-1); } catch {} }
      r.pendingAcks.clear();
      r.chatCache.clear();
      r.client = null;
      r.qr = null;
      r.status = 'stopping';
      r.generation += 1;
      if (client) {
        try { await client.destroy(); }
        catch (error) { this.log(safe, 'WARN', `تعذر إغلاق متصفح WhatsApp بصورة فورية: ${safeError(error)}`); }
      }
      if (clearAuth) {
        const authRoot = this.store.getPaths(safe).authRoot;
        let removed = false;
        let lastError = null;
        for (let attempt = 0; attempt < 3 && !removed; attempt += 1) {
          try {
            await fs.promises.rm(authRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 750 });
            removed = !fs.existsSync(authRoot);
            if (!removed) await sleep(750);
          } catch (error) {
            lastError = error;
            await sleep(750);
          }
        }
        if (!removed) {
          const detail = lastError ? `: ${safeError(lastError)}` : '';
          this.log(safe, 'WARN', `تعذر حذف ربط الجلسة الآن${detail}`);
        }
      }
      r.status = 'stopped';
      this.log(safe, 'INFO', clearAuth ? 'تم حذف ربط الجلسة المحلي.' : 'تم إيقاف جلسة WhatsApp.');
    })().finally(() => { r.stopPromise = null; });
    return r.stopPromise;
  }
  async ensureReady(id) {
    const safe = this.store.safeSessionId(id);
    if (this.isReady(safe)) return true;
    if (!this.hasSavedAuth(safe)) throw new Error('الجلسة غير مرتبطة بواتساب. افتح صفحة الجلسات واضغط «ربط الجلسة».');
    await this.start(safe);
    const started = Date.now();
    while (Date.now() - started < 60000) {
      if (this.isReady(safe)) return true;
      const status = this.runtime(safe).status;
      if (status === 'error' || status === 'logged_out' || status === 'auth_failure') break;
      await sleep(250);
    }
    throw new Error('لم تصبح جلسة WhatsApp جاهزة خلال المهلة. تحقق من المتصفح وحالة الجلسة.');
  }
  enqueue(id, task, label) {
    const safe = this.store.safeSessionId(id);
    const r = this.runtime(safe);
    const next = r.queue.then(task);
    r.queue = next.catch(() => undefined);
    return next.catch(error => {
      this.log(safe, 'ERROR', `${label}: ${safeError(error)}`);
      throw error;
    });
  }
  async resolveChatId(id, recipient) {
    const safe = this.store.safeSessionId(id);
    await this.ensureReady(safe);
    const target = recipient || {};
    const groupValue = target.gid || target.chatId || (target.kind === 'group' ? target.id : '');
    if (target.kind === 'group' || String(groupValue || '').endsWith('@g.us')) {
      const gid = String(groupValue || '').trim();
      if (!gid.endsWith('@g.us')) throw new Error(`معرف المجموعة «${target.name || gid}» غير صالح.`);
      const client = this.runtime(safe).client;
      const cached = this.runtime(safe).chatCache.get(gid);
      if (cached && cached.expiresAt > Date.now()) return cached.chatId;
      if (cached) this.runtime(safe).chatCache.delete(gid);
      try {
        const chat = await withTimeout(client.getChatById(gid), 15000, 'التحقق من المجموعة');
        if (!chat || chat.isGroup !== true) throw new Error(`المعرف «${gid}» ليس مجموعة WhatsApp.`);
      } catch (error) {
        if (/ليس مجموعة/.test(String(error?.message || ''))) throw error;
        throw new Error(`تعذر الوصول إلى المجموعة ${gid}: ${safeError(error)}`);
      }
      this.runtime(safe).chatCache.set(gid, { chatId: gid, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      return gid;
    }
    let parsed;
    const storedRaw = normalizeDigits(target.phone).replace(/\D/g, '');
    try {
      parsed = phones.parse(storedRaw.startsWith('+') ? storedRaw : `+${storedRaw}`, target.country || 'OM');
    } catch {
      parsed = phones.parse(target.phone, target.country || 'OM');
    }
    const phone = parsed.digits;
    if (phone.length < 8) throw new Error(`رقم المستلم «${target.name || phone}» غير صالح.`);
    const r = this.runtime(safe);
    const cached = r.chatCache.get(phone);
    if (cached && cached.expiresAt > Date.now()) return cached.chatId;
    if (cached) r.chatCache.delete(phone);
    const client = r.client;
    let lastError = null;
    try {
      const numberId = await withTimeout(client.getNumberId(phone), 15000, 'التحقق من الرقم');
      const resolved = serializedId(numberId);
      if (resolved) {
        r.chatCache.set(phone, { chatId: resolved, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
        return resolved;
      }
    } catch (error) { lastError = error; }
    try {
      const registered = await withTimeout(client.isRegisteredUser(phone), 15000, 'فحص الرقم');
      if (registered === false) throw new Error(`الرقم ${target.phone} غير مسجل على WhatsApp.`);
    } catch (error) {
      if (String(error.message || '').includes('غير مسجل')) throw error;
      lastError = error;
    }
    if (lastError && /مهلة/.test(String(lastError.message || ''))) this.log(safe, 'WARN', `تعذر التحقق الكامل من ${target.name || phone}: ${safeError(lastError)}`);
    const fallback = `${phone}@c.us`;
    r.chatCache.set(phone, { chatId: fallback, expiresAt: Date.now() + 15 * 60 * 1000 });
    return fallback;
  }
  async getGroupInfo(id, gid) {
    const safe = this.store.safeSessionId(id);
    await this.ensureReady(safe);
    const groupId = String(gid || '').trim();
    if (!groupId.endsWith('@g.us')) throw new Error('GID يجب أن ينتهي بـ @g.us.');
    const chat = await withTimeout(this.runtime(safe).client.getChatById(groupId), 15000, 'تحليل المجموعة');
    if (!chat || chat.isGroup !== true) throw new Error('المعرف المحدد ليس مجموعة WhatsApp.');
    let inviteCode = null;
    if (typeof chat.getInviteCode === 'function') {
      try { inviteCode = await withTimeout(chat.getInviteCode(), 10000, 'قراءة رمز الدعوة'); } catch {}
    }
    return {
      gid: serializedId(chat.id) || groupId,
      name: String(chat.name || 'مجموعة بدون اسم'),
      description: String(chat.description || ''),
      owner: serializedId(chat.owner) || (chat.owner ? String(chat.owner) : null),
      participantsCount: Array.isArray(chat.participants) ? chat.participants.length : 0,
      adminsCount: Array.isArray(chat.participants) ? chat.participants.filter(p => p?.isAdmin || p?.isSuperAdmin || ['admin','superadmin'].includes(String(p?.role || '').toLowerCase())).length : 0,
      inviteCode,
      isGroup: true,
      source: 'chat'
    };
  }
  async analyzeGroupInvite(id, inviteCode) {
    const safe = this.store.safeSessionId(id);
    await this.ensureReady(safe);
    const code = String(inviteCode || '').trim();
    if (!code) throw new Error('رمز الدعوة فارغ.');
    if (typeof this.runtime(safe).client.getInviteInfo !== 'function') throw new Error('تحليل رابط الدعوة غير متاح في نسخة WhatsApp الحالية.');
    const info = await withTimeout(this.runtime(safe).client.getInviteInfo(code), 15000, 'تحليل رابط الدعوة');
    return {
      gid: serializedId(info?.id),
      name: String(info?.subject || info?.name || 'مجموعة بدون اسم'),
      description: String(info?.description || ''),
      owner: serializedId(info?.owner) || (info?.owner ? String(info.owner) : null),
      participantsCount: Number(info?.size || info?.participantsCount || info?.participantCount || 0) || 0,
      inviteCode: code,
      isGroup: true,
      source: 'invite'
    };
  }
  async listGroups(id) {
    const safe = this.store.safeSessionId(id);
    await this.ensureReady(safe);
    const chats = await withTimeout(this.runtime(safe).client.getChats(), 30000, 'تحميل المجموعات');
    return (Array.isArray(chats) ? chats : []).filter(chat => chat?.isGroup === true).map(chat => ({
      gid: serializedId(chat.id),
      name: String(chat.name || 'مجموعة بدون اسم'),
      description: String(chat.description || ''),
      owner: serializedId(chat.owner) || (chat.owner ? String(chat.owner) : null),
      participantsCount: Array.isArray(chat.participants) ? chat.participants.length : 0,
      adminsCount: Array.isArray(chat.participants) ? chat.participants.filter(p => p?.isAdmin || p?.isSuperAdmin || ['admin','superadmin'].includes(String(p?.role || '').toLowerCase())).length : 0,
      isGroup: true,
      source: 'chat'
    })).filter(x => x.gid).sort((a,b) => a.name.localeCompare(b.name, 'ar'));
  }
  async observeAck(id, message, ms) {
    const safe = this.store.safeSessionId(id);
    const r = this.runtime(safe);
    const mid = serializedId(message?.id || message);
    const requested = Math.max(500, Number(ms) || 7000);
    if (!mid) return { status: 'not_observed', ack: null };
    const initialAck = Number(message?.ack);
    if (Number.isFinite(initialAck) && initialAck >= 1) return { status: 'confirmed', ack: initialAck };
    if (Number.isFinite(initialAck) && initialAck < 0) return { status: 'error', ack: initialAck };
    const cached = r.ackHistory.findLast?.(item => item.id === mid && Number(item.ack) >= 1);
    if (cached) return { status: 'confirmed', ack: Number(cached.ack) };

    const wait = new Promise(resolve => {
      let timer;
      const done = ack => {
        clearTimeout(timer);
        r.pendingAcks.delete(mid);
        const value = Number(ack);
        resolve({ status: value >= 1 ? 'confirmed' : 'error', ack: value });
      };
      r.pendingAcks.set(mid, done);
      timer = setTimeout(() => {
        r.pendingAcks.delete(mid);
        resolve({ status: 'pending', ack: null });
      }, requested);
    });
    const observed = await wait;
    if (observed.status !== 'pending') return observed;

    const client = this.runtime(safe).client;
    if (client?.getMessageById) {
      for (let i = 0; i < 3; i += 1) {
        await sleep(350);
        try {
          const latest = await withTimeout(client.getMessageById(mid), 7000, 'التحقق من حالة الرسالة');
          const latestAck = Number(latest?.ack);
          if (Number.isFinite(latestAck) && latestAck >= 1) return { status: 'confirmed', ack: latestAck };
          if (Number.isFinite(latestAck) && latestAck < 0) return { status: 'error', ack: latestAck };
        } catch {}
      }
    }
    return { status: 'pending', ack: null };
  }
  async directSendText(safe, chatId, body, { quotedMessageId = null, observeAck = true } = {}) {
    const session = this.store.loadSession(safe);
    const client = this.runtime(safe).client;
    if (!client || !this.isReady(safe)) throw Object.assign(new Error('جلسة WhatsApp غير جاهزة أثناء الإرسال.'), { code:'SEND_NOT_READY' });
    const timeout = session.settings.sendTimeoutMs;
    const quote = serializedId(quotedMessageId);
    const baseOptions = { sendSeen:false, waitUntilMsgSent:false, ignoreQuoteErrors:true };
    let result;
    try {
      result = await withTimeout(client.sendMessage(chatId, body, quote ? {...baseOptions, quotedMessageId:quote} : baseOptions), timeout, 'إرسال الرسالة');
    } catch (error) {
      if (quote && this.isReady(safe)) {
        this.log(safe,'WARN',`تعذر إرسال الرد المقتبس؛ سيتم إرسال الرد بدون اقتباس: ${safeError(error)}`);
        result = await withTimeout(client.sendMessage(chatId, body, baseOptions), timeout, 'إرسال الرسالة');
      } else throw error;
    }
    if (!result) throw new Error('WhatsApp لم ينشئ الرسالة.');
    const ack=observeAck?await this.observeAck(safe,result,session.settings.ackObservationMs):{status:'dispatched',ack:null};
    Object.defineProperty(result,'__chatBotAck',{value:ack,enumerable:false,configurable:true});
    if(ack.status==='error') throw Object.assign(new Error('تم إنشاء الرسالة لكن WhatsApp أعلن فشل الإرسال.'),{code:'SEND_ACK_ERROR'});
    this.runtime(safe).lastSent={id:serializedId(result.id),kind:'text',ack,at:new Date().toISOString()};
    return result;
  }
  async sendText(id, chatId, text, { quotedMessageId = null, observeAck = true } = {}) {
    const safe=this.store.safeSessionId(id), body=String(text||'').trim(); if(!body)return null;
    await this.ensureReady(safe);
    return this.enqueue(safe,()=>this.directSendText(safe,chatId,body,{quotedMessageId,observeAck}),'الرسالة');
  }
  async directSendMedia(safe, chatId, filePath, { observeAck = true } = {}) {
    const session=this.store.loadSession(safe), client=this.runtime(safe).client;
    if(!client||!this.isReady(safe))throw Object.assign(new Error('جلسة WhatsApp غير جاهزة أثناء إرسال الوسائط.'),{code:'SEND_NOT_READY'});
    const stat=fs.statSync(filePath);if(!stat.isFile()||stat.size<=0)throw new Error('الملف غير صالح.');
    if(stat.size>session.settings.maxImageSizeMB*1024*1024)throw new Error(`حجم الملف أكبر من ${session.settings.maxImageSizeMB} MB.`);
    const ext=path.extname(filePath).toLowerCase();
    const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.txt':'text/plain','.zip':'application/zip','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}[ext];
    if(!mime)throw new Error('نوع الملف غير مدعوم.');
    const data=fs.readFileSync(filePath).toString('base64');if(!data)throw new Error('تعذر قراءة بيانات الملف.');
    const media=new MessageMedia(mime,data,path.basename(filePath),stat.size),isImage=mime.startsWith('image/');
    const result=await withTimeout(client.sendMessage(chatId,media,{sendMediaAsDocument:!isImage,sendMediaAsHd:false,sendSeen:false,waitUntilMsgSent:false,ignoreQuoteErrors:true}),session.settings.sendTimeoutMs,'إرسال الوسائط');
    if(!result)throw new Error('WhatsApp لم ينشئ رسالة الوسائط.');
    const ack=observeAck?await this.observeAck(safe,result,session.settings.ackObservationMs):{status:'dispatched',ack:null};
    Object.defineProperty(result,'__chatBotAck',{value:ack,enumerable:false,configurable:true});
    if(ack.status==='error')throw Object.assign(new Error('تم إنشاء الوسائط لكن WhatsApp أعلن فشل الإرسال.'),{code:'SEND_ACK_ERROR'});
    this.runtime(safe).lastSent={id:serializedId(result.id),kind:isImage?'image':'file',ack,at:new Date().toISOString()};
    return result;
  }
  async sendMedia(id, chatId, filePath, { observeAck = true } = {}) {
    const safe=this.store.safeSessionId(id);await this.ensureReady(safe);
    return this.enqueue(safe,()=>this.directSendMedia(safe,chatId,filePath,{observeAck}),'الوسائط');
  }
  async replyToMessage(id, messageOrId, text) {
    const safe=this.store.safeSessionId(id),body=String(text||'').trim();if(!body)return null;await this.ensureReady(safe);
    return this.enqueue(safe,async()=>{
      let message=messageOrId;const mid=serializedId(messageOrId?.id||messageOrId);const client=this.runtime(safe).client;
      if(!message||typeof message.reply!=='function'){
        if(!mid||typeof client.getMessageById!=='function')throw new Error('تعذر الوصول إلى الرسالة الأصلية للرد.');
        message=await withTimeout(client.getMessageById(mid),15000,'تحميل الرسالة الأصلية');
      }
      let result=null;
      if(message&&typeof message.reply==='function'){
        try{result=await withTimeout(message.reply(body,undefined,{sendSeen:false,waitUntilMsgSent:false,ignoreQuoteErrors:true}),this.store.loadSession(safe).settings.sendTimeoutMs,'الرد على الرسالة');
          if(!result) throw new Error('WhatsApp أعاد نتيجة فارغة من message.reply.');
        }
        catch(error){
          const chatId=String(message.from||message.to||'').trim();
          if(!chatId)throw error;
          this.log(safe,'WARN',`تعذر الرد الأصلي؛ سيتم استخدام مسار الإرسال المقتبس: ${safeError(error)}`);
          result=await this.directSendText(safe,chatId,body,{quotedMessageId:mid,observeAck:true});
        }
      } else {
        const chatId=String(message?.from||message?.to||'').trim();if(!chatId)throw new Error('تعذر تحديد محادثة الرسالة الأصلية.');
        result=await this.directSendText(safe,chatId,body,{quotedMessageId:mid,observeAck:true});
      }
      if(!result)throw new Error('WhatsApp لم ينشئ الرد.');
      const ack=result.__chatBotAck||await this.observeAck(safe,result,this.store.loadSession(safe).settings.ackObservationMs);
      Object.defineProperty(result,'__chatBotAck',{value:ack,enumerable:false,configurable:true});
      if(ack.status==='error')throw Object.assign(new Error('تم إنشاء الرد لكن WhatsApp أعلن فشل الإرسال.'),{code:'SEND_ACK_ERROR'});
      if(ack.status==='pending')throw Object.assign(new Error('تم إنشاء الرد لكن لم تصل حالة تأكيد من WhatsApp بعد.'),{code:'SEND_UNCERTAIN'});
      this.runtime(safe).lastSent={id:serializedId(result.id),kind:'reply',ack,at:new Date().toISOString()};
      return result;
    },'الرد');
  }
  async reactToMessage(id,messageOrId,emoji){
    const safe=this.store.safeSessionId(id),reaction=String(emoji||'👍').trim(),mid=serializedId(messageOrId?.id||messageOrId);if(!mid)throw new Error('تعذر تحديد الرسالة للتفاعل.');await this.ensureReady(safe);
    return this.enqueue(safe,async()=>{let message=messageOrId;const client=this.runtime(safe).client;if(!message||typeof message.react!=='function'){if(typeof client.getMessageById!=='function')throw new Error('تعذر تحميل الرسالة للتفاعل.');message=await withTimeout(client.getMessageById(mid),15000,'تحميل الرسالة للتفاعل');}if(message&&typeof message.react==='function'){await withTimeout(message.react(reaction),20000,'التفاعل على الرسالة');return{ok:true,id:mid,reaction,status:'confirmed'};}if(typeof client.sendReaction!=='function')throw new Error('واجهة Reaction غير متاحة في نسخة WhatsApp الحالية.');await withTimeout(client.sendReaction(mid,reaction),20000,'إرسال Reaction');return{ok:true,id:mid,reaction,status:'confirmed'};},'Reaction');
  }
  async sendReaction(id, messageId, emoji) { return this.reactToMessage(id, messageId, emoji); }
  async stopAll() {
    this.shuttingDown = true;
    return Promise.all([...this.items.keys()].map(id => this.stop(id).catch(() => undefined)));
  }
}

module.exports = { WhatsAppManager, normalizePhone, serializedId, safeError, browserExecutable, sleep, normalizeMessageObject, normalizeReactionObject };
