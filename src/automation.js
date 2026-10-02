'use strict';

function pad(n) { return String(n).padStart(2, '0'); }
function datePartsToKey(p) { return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`; }

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const get = type => parts.find(x => x.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return { year:Number(get('year')), month:Number(get('month')), day:Number(get('day')), hour, minute:Number(get('minute')), second:Number(get('second')), weekday:weekdays[get('weekday')] };
}

function zonedDateToUtc(dateText, timeText, timezone) {
  const dm = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeText || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dm || !tm) throw new Error('التاريخ أو الوقت غير صالح. استخدم YYYY-MM-DD و HH:mm.');
  const year = Number(dm[1]); const month = Number(dm[2]); const day = Number(dm[3]);
  const hour = Number(tm[1]); const minute = Number(tm[2]); const second = Number(tm[3] || 0);
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || probe.getUTCHours() !== hour || probe.getUTCMinutes() !== minute) {
    throw new Error('التاريخ غير صالح.');
  }
  let guess = probe.getTime();
  for (let i = 0; i < 4; i += 1) {
    const lp = localParts(new Date(guess), timezone);
    const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second);
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = targetUtc - asUtc;
    if (Math.abs(diff) < 1000) break;
    guess += diff;
  }
  return new Date(guess);
}

function addCalendarDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  d.setUTCDate(d.getUTCDate() + days);
  return { year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate(), hour:parts.hour, minute:parts.minute, second:parts.second };
}
function addCalendarMonths(parts, months) {
  const wantedDay = parts.day;
  const first = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1, parts.hour, parts.minute, parts.second));
  const year = first.getUTCFullYear();
  const month = first.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day:Math.min(wantedDay, lastDay), hour:parts.hour, minute:parts.minute, second:parts.second };
}
function partsToUtc(parts, timezone) {
  const textDate = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const textTime = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return zonedDateToUtc(textDate, textTime, timezone);
}
function occurrenceAfter(task, basis, from) {
  const timezone = task.timezone || 'Asia/Muscat';
  let parts = localParts(basis, timezone);
  const repeatKind = task.repeat?.kind || 'once';
  const interval = Math.max(1, Number(task.repeat?.interval) || 1);
  if (repeatKind === 'daily') return partsToUtc(addCalendarDays(parts, interval), timezone);
  if (repeatKind === 'weekly') return partsToUtc(addCalendarDays(parts, 7 * interval), timezone);
  if (repeatKind === 'monthly') return partsToUtc(addCalendarMonths(parts, interval), timezone);
  return null;
}
function addNextRun(task, from = new Date()) {
  if (!task.runAt) return null;
  const first = new Date(task.nextRunAt || task.runAt || 0);
  if (!Number.isFinite(first.getTime())) return null;
  const repeatKind = task.repeat?.kind || 'once';
  if (repeatKind === 'once') return task.lastRunAt ? null : first.toISOString();
  let candidate = first;
  let guard = 0;
  while (candidate.getTime() <= from.getTime() && guard < 1000) {
    const next = occurrenceAfter(task, candidate, from);
    if (!next || !Number.isFinite(next.getTime())) return null;
    candidate = next;
    guard += 1;
  }
  return candidate.toISOString();
}

function taskDue(task, now = new Date()) {
  if (!task?.enabled || !task.nextRunAt) return false;
  const t = Date.parse(task.nextRunAt);
  return Number.isFinite(t) && t <= now.getTime();
}

function safeErr(e) { return String(e?.message || e || 'خطأ غير معروف'); }

class AutomationService {
  constructor({ store, delivery, whatsapp, log }) {
    this.store = store;
    this.delivery = delivery;
    this.whatsapp = whatsapp;
    this.log = log;
    this.timer = null;
    this.busy = new Set();
    this.started = false;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.tick().catch(e => this.log(null, 'ERROR', `الأتمتة: ${safeErr(e)}`)), 500);
    this.tick().catch(e => this.log(null, 'ERROR', `الفحص الأولي للأتمتة: ${safeErr(e)}`));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.started = false; }
  async tick(now = new Date()) {
    if (!this.started) return;
    for (const id of this.store.listSessionIds()) {
      const safe = this.store.safeSessionId(id);
      const s = this.store.loadSession(safe);
      if (!s.settings.automationEnabled || !s.automation.enabled) continue;
      for (const task of s.automation.tasks) {
        if (!task.enabled || !taskDue(task, now) || this.busy.has(`${safe}:${task.id}`)) continue;
        this.busy.add(`${safe}:${task.id}`);
        await this.execute(safe, task).catch(() => undefined);
        this.busy.delete(`${safe}:${task.id}`);
      }
    }
  }
  async execute(id, task) {
    const s0 = this.store.loadSession(id);
    const task0 = s0.automation.tasks.find(x => x.id === task.id);
    if (!task0 || !task0.enabled) return;
    task0.lastRunAt = new Date().toISOString();
    task0.lastStatus = 'running';
    task0.lastError = null;
    this.store.saveSession(s0);
    try {
      const result = await this.delivery.runAutomation(id, task0);
      const s = this.store.loadSession(id);
      const t = s.automation.tasks.find(x => x.id === task0.id);
      if (!t) return;
      t.lastStatus = result.ok ? 'success' : 'partial';
      t.lastError = result.ok ? null : String(result.message || 'لم تكتمل المهمة.').slice(0, 500);
      const next = addNextRun(t, new Date());
      t.nextRunAt = next;
      if (!next && t.repeat?.kind !== 'once') t.lastStatus = 'error';
      s.automation.recent = [...(s.automation.recent || []), { at:new Date().toISOString(), taskId:t.id, taskName:t.name, status:t.lastStatus, sent:result.sent?.length || 0, failed:result.failed?.length || 0, error:t.lastError }].slice(-300);
      if (result.ok) s.stats.successfulRuns += 1; else s.stats.failedRuns += 1;
      this.store.saveSession(s);
      this.log(id, result.ok ? 'INFO' : 'WARN', `اكتملت مهمة الأتمتة «${t.name}» بحالة ${t.lastStatus}.`);
    } catch (error) {
      const s = this.store.loadSession(id);
      const t = s.automation.tasks.find(x => x.id === task0.id);
      if (t) {
        t.lastStatus = 'error';
        t.lastError = safeErr(error).slice(0, 500);
        const retryAt = new Date(Date.now() + Math.max(5000, Number(s.settings.retryDelayMs) || 5000));
        t.nextRunAt = t.repeat?.kind === 'once' ? retryAt.toISOString() : (t.nextRunAt || retryAt.toISOString());
      }
      s.automation.recent = [...(s.automation.recent || []), { at:new Date().toISOString(), taskId:task0.id, taskName:task0.name, status:'error', sent:0, failed:1, error:safeErr(error) }].slice(-300);
      this.store.saveSession(s);
      this.log(id, 'ERROR', `فشل مهمة الأتمتة «${task0.name}»: ${safeErr(error)}`);
    }
  }
  list(id) { return this.store.loadSession(id).automation.tasks; }
  addOrUpdate(id, task) {
    const s = this.store.loadSession(id);
    const normalized = this.store.normalizeTask(task);
    if (!normalized.runAt) throw new Error('يجب تحديد تاريخ ووقت المهمة.');
    if (!normalized.targets.recipientIds.length && !normalized.targets.groupIds.length) throw new Error('حدد مستلمًا أو مجموعة واحدة على الأقل.');
    if (normalized.repeat.kind !== 'once' && Date.parse(normalized.nextRunAt || normalized.runAt) <= Date.now()) {
      normalized.nextRunAt = addNextRun({ ...normalized, lastRunAt: new Date().toISOString(), nextRunAt: normalized.runAt }, new Date());
    }
    if (normalized.kind !== 'text' && !normalized.imageId) throw new Error('هذه المهمة تحتاج إلى صورة.');
    const ix = s.automation.tasks.findIndex(x => x.id === normalized.id);
    if (ix >= 0) s.automation.tasks[ix] = normalized; else s.automation.tasks.push(normalized);
    s.automation.tasks = s.automation.tasks.slice(0, 200);
    this.store.saveSession(s);
    return normalized;
  }
  remove(id, taskId) { const s=this.store.loadSession(id); const before=s.automation.tasks.length; s.automation.tasks=s.automation.tasks.filter(t=>t.id!==taskId); if(before===s.automation.tasks.length)throw new Error('المهمة غير موجودة.'); this.store.saveSession(s); }
  toggle(id, taskId) { const s=this.store.loadSession(id); const t=s.automation.tasks.find(x=>x.id===taskId); if(!t)throw new Error('المهمة غير موجودة.'); t.enabled=!t.enabled; this.store.saveSession(s); return t.enabled; }
}

module.exports = { AutomationService, localParts, zonedDateToUtc, taskDue, addNextRun, datePartsToKey };
