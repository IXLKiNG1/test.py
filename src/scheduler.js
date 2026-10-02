'use strict';

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdayMap[get('weekday')],
    hour,
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}
function keyFor(date, session) {
  const p = localParts(date, session.settings.timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(session.settings.hour).padStart(2, '0')}:${String(session.settings.minute).padStart(2, '0')}`;
}
function due(date, session) {
  if (!session?.settings?.scheduleEnabled) return { due: false, key: null, late: 0 };
  const p = localParts(date, session.settings.timezone);
  if (p.weekday !== Number(session.settings.dayOfWeek)) return { due: false, key: null, late: 0 };
  const nowMinutes = p.hour * 60 + p.minute + p.second / 60;
  const targetMinutes = Number(session.settings.hour) * 60 + Number(session.settings.minute);
  const late = nowMinutes - targetMinutes;
  const grace = Math.max(0, Number(session.settings.catchUpMinutes) || 0);
  const withinWindow = late >= 0 && late <= grace;
  return { due: withinWindow, key: withinWindow ? keyFor(date, session) : null, late: Math.max(0, late) };
}
function nextRun(session, from = new Date()) {
  if (!session?.settings?.scheduleEnabled) return null;
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const horizon = 15 * 24 * 60;
  for (let i = 0; i < horizon; i += 1) {
    const date = new Date(start.getTime() + i * 60000);
    const p = localParts(date, session.settings.timezone);
    if (p.weekday === Number(session.settings.dayOfWeek) && p.hour === Number(session.settings.hour) && p.minute === Number(session.settings.minute)) return date.toISOString();
  }
  return null;
}

class ReliableScheduler {
  constructor({ store, ids, run, log }) {
    this.store = store;
    this.ids = ids;
    this.run = run;
    this.log = log;
    this.watchdog = null;
    this.timers = new Map();
    this.busy = new Set();
    this.started = false;
    this.lastTick = null;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.watchdog = setInterval(() => {
      this.tick().catch(error => this.log(null, 'ERROR', `خطأ في مراقبة الجدولة: ${error.message || error}`));
    }, 1000);
    this.armAll();
    this.tick().catch(error => this.log(null, 'ERROR', `فحص الجدولة الأولي: ${error.message || error}`));
  }
  stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.started = false;
  }
  armAll() { for (const id of this.ids()) this.arm(id); }
  arm(id) {
    if (!this.started) return;
    const safeId = this.store.safeSessionId(id);
    const old = this.timers.get(safeId);
    if (old) clearTimeout(old);
    const session = this.store.loadSession(safeId);
    const target = nextRun(session);
    if (!target) return;
    const targetMs = new Date(target).getTime();
    const delay = Math.max(250, Math.min(targetMs - Date.now(), 2147483647));
    const timer = setTimeout(async () => {
      this.timers.delete(safeId);
      try { await this.tick(new Date()); }
      catch (error) { this.log(safeId, 'ERROR', `خطأ تشغيل الموعد: ${error.message || error}`); }
      finally { this.arm(safeId); }
    }, delay);
    this.timers.set(safeId, timer);
  }
  wake(id) { this.arm(id); this.tick(new Date()).catch(error => this.log(null, 'ERROR', `فحص فوري للجدولة: ${error.message || error}`)); }
  wakeAll() { this.armAll(); this.tick(new Date()).catch(error => this.log(null, 'ERROR', `فحص فوري شامل للجدولة: ${error.message || error}`)); }
  cancel(id) { const safeId = this.store.safeSessionId(id); const timer = this.timers.get(safeId); if (timer) clearTimeout(timer); this.timers.delete(safeId); this.busy.delete(safeId); }
  async tick(now = new Date()) {
    if (!this.started) return;
    this.lastTick = now.toISOString();
    for (const id of this.ids()) {
      const safeId = this.store.safeSessionId(id);
      if (this.busy.has(safeId)) continue;
      const session = this.store.loadSession(safeId);
      if (!session.settings.scheduleEnabled) {
        if (session.schedule.nextRetryAt || session.schedule.lastError) {
          const cleared = this.store.loadSession(safeId);
          cleared.schedule.nextRetryAt = null;
          cleared.schedule.lastError = null;
          this.store.saveSession(cleared);
        }
        continue;
      }
      const d = due(now, session);
      const retryKey = session.schedule.lastAttemptKey && session.schedule.lastSuccessKey !== session.schedule.lastAttemptKey
        ? session.schedule.lastAttemptKey
        : null;
      const retryAt = session.schedule.nextRetryAt ? Date.parse(session.schedule.nextRetryAt) : NaN;
      const retryAge = session.schedule.lastAttemptAt ? now.getTime() - Date.parse(session.schedule.lastAttemptAt) : Infinity;
      const retryDue = Boolean(retryKey) && Number.isFinite(retryAt) && now.getTime() >= retryAt && retryAge >= 0 && retryAge <= 24 * 60 * 60 * 1000;
      const runKey = d.due && d.key ? d.key : (retryDue ? retryKey : null);
      if (!runKey) {
        if (retryKey && retryAge > 24 * 60 * 60 * 1000) {
          const stale = this.store.loadSession(safeId);
          stale.schedule.nextRetryAt = null;
          stale.schedule.lastError = stale.schedule.lastError || 'انتهت نافذة إعادة المحاولة بعد 24 ساعة.';
          this.store.saveSession(stale);
        }
        continue;
      }
      if (session.schedule.lastSuccessKey === runKey) continue;
      if (session.schedule.lastAttemptKey === runKey && session.schedule.nextRetryAt) {
        const retryMs = Date.parse(session.schedule.nextRetryAt);
        if (Number.isFinite(retryMs) && now.getTime() < retryMs) continue;
      }
      this.busy.add(safeId);
      const current = this.store.loadSession(safeId);
      current.schedule.lastAttemptKey = runKey;
      current.schedule.lastAttemptAt = now.toISOString();
      current.schedule.nextRetryAt = null;
      this.store.saveSession(current);
      this.log(safeId, 'INFO', `${retryDue ? 'إعادة محاولة' : 'وصل موعد'} الجدولة ${runKey}. بدأ الإرسال تلقائيًا.`);
      try {
        const result = await this.run(safeId);
        const after = this.store.loadSession(safeId);
        if (result?.ok) {
          after.schedule.lastSuccessKey = runKey;
          after.schedule.nextRetryAt = null;
          after.schedule.lastError = null;
          this.log(safeId, 'INFO', `اكتمل الإرسال المجدول للموعد ${runKey}.`);
        } else if (result?.retry === false) {
          after.schedule.nextRetryAt = null;
          after.schedule.lastError = String(result?.message || 'لم يكتمل الإرسال.').slice(0, 500);
          this.log(safeId, 'WARN', `لن تتم إعادة المحاولة الآن: ${after.schedule.lastError}`);
        } else {
          after.schedule.nextRetryAt = new Date(Date.now() + Math.max(5000, Number(after.settings.retryDelayMs) || 5000)).toISOString();
          after.schedule.lastError = String(result?.message || 'لم يكتمل الإرسال.').slice(0, 500);
          this.log(safeId, 'WARN', `لم يكتمل الإرسال المجدول: ${after.schedule.lastError}`);
        }
        this.store.saveSession(after);
      } catch (error) {
        const after = this.store.loadSession(safeId);
        after.schedule.nextRetryAt = new Date(Date.now() + Math.max(5000, Number(after.settings.retryDelayMs) || 5000)).toISOString();
        after.schedule.lastError = String(error?.message || error).slice(0, 500);
        this.store.saveSession(after);
        this.log(safeId, 'ERROR', `فشل الإرسال المجدول: ${after.schedule.lastError}`);
      } finally {
        this.busy.delete(safeId);
        this.arm(safeId);
      }
    }
  }
  status(session) {
    return {
      alive: this.started,
      nextRun: nextRun(session),
      lastTick: this.lastTick,
      lastAttempt: session.schedule.lastAttemptAt,
      lastSuccess: session.schedule.lastSuccessKey,
      lastError: session.schedule.lastError || null,
      nextRetryAt: session.schedule.nextRetryAt || null,
      armed: Boolean(this.timers.get(session.id))
    };
  }
}

module.exports = { ReliableScheduler, localParts, due, nextRun, keyFor };
