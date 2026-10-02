(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const DAY_NAMES = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const BG_MAP = {
    aurora: 'aurora', grid: 'cyber-grid', stars: 'starfield', particles: 'ocean',
    orbits: 'vortex', waves: 'plasma', matrix: 'matrix', nebula: 'nebula', meteor: 'meteor'
  };
  const BG_LABELS = {
    aurora: 'الشفق', grid: 'الشبكة', stars: 'النجوم', particles: 'الجسيمات',
    orbits: 'المدارات', waves: 'الموجات', matrix: 'المطر الرقمي', nebula: 'السديم', meteor: 'النيزك'
  };
  const BG_DEFAULTS = { speed: 1, density: 1, glow: 0.6, intensity: 1, interactive: true, trail: true };
  const assistant = {
    connect: 'من «الجلسات» اضغط ربط / تشغيل ثم امسح QR من WhatsApp.',
    send: 'من «الإرسال» اختر رقمًا أو مجموعة وملفًا ثم اضغط إرسال الآن.',
    groups: 'من «المجموعات» استخدم اكتشاف مجموعاتي، أو حلّل GID ثم احفظ المجموعة داخل الجلسة.',
    numbers: 'اختر الدولة واكتب الرقم المحلي، أو أدخل الرقم بصيغة دولية تبدأ بـ + أو 00.',
    interaction: 'فعّل التفاعل ثم أضف قاعدة رسالة أو Reaction، ويمكن تخصيصها للمجموعات فقط.',
    errors: 'تأكد من جاهزية الجلسة، ثم افحص الرقم أو المجموعة والملف. أي خطأ سيظهر في الرسائل أسفل الصفحة.'
  };

  const state = { data: null, page: 'home', loading: false };
  const selected = { targets: new Set(), groups: new Set(), images: new Set(), schedule: new Set() };
  let pendingGroup = null;
  let assistantOpen = false;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function human(status) {
    return ({
      idle: 'متوقف', starting: 'جارٍ الاتصال', qr: 'بانتظار QR', authenticated: 'تمت المصادقة',
      ready: 'جاهزة', disconnected: 'منفصلة', logged_out: 'غير مرتبطة', auth_failure: 'فشل التوثيق',
      error: 'خطأ', stopped: 'متوقف'
    })[status] || status || 'غير معروف';
  }

  function toast(message, error = false) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.style.borderColor = error ? 'rgba(255,143,143,.45)' : 'rgba(110,231,183,.3)';
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function api(url, options = {}) {
    const headers = {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 45000);
    try {
      const response = await fetch(url, { ...options, headers, cache: 'no-store', signal: options.signal || controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('انتهت مهلة الطلب. تأكد من أن البرنامج يعمل ثم جرّب مرة أخرى.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function sid() { return state.data?.session?.id || ''; }
  function targetKeys() { return [...selected.targets, ...selected.groups]; }

  function go(page) {
    state.page = page;
    $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
    $$('#nav button[data-page]').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    renderPage(page);
  }

  function renderPage(page) {
    if (!state.data) return;
    if (page === 'home') renderHome();
    if (page === 'send') renderSend();
    if (page === 'automation') renderAutomation();
    if (page === 'groups') renderGroups();
    if (page === 'interaction') renderInteraction();
    if (page === 'sessions') renderSessions();
    if (page === 'settings') renderSettings();
    if (page === 'guide') renderGuideState();
  }

  function renderTop() {
    const d = state.data || {};
    const w = d.whatsapp || {};
    const select = $('sessionSelect');
    if (select) {
      select.innerHTML = (d.sessions || []).map((session) =>
        `<option value="${esc(session.id)}" ${session.id === d.activeSessionId ? 'selected' : ''}>${esc(session.name)}${session.ready ? ' · متصل' : ''}</option>`
      ).join('');
      select.onchange = () => switchSession(select.value);
    }
    const topStatus = $('topStatus');
    if (topStatus) topStatus.textContent = human(w.status);
    const topDot = $('topDot');
    if (topDot) topDot.className = `dot ${w.ready ? 'ok' : ['error', 'auth_failure'].includes(w.status) ? 'bad' : ''}`;
    const nextRun = $('topNextRun');
    if (nextRun) nextRun.textContent = d.schedule?.nextRun || 'متوقفة';
    const sync = $('topSync');
    if (sync) sync.textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-OM', { hour: '2-digit', minute: '2-digit' })}`;
  }


  async function loadCountries() {
    const select = $('recipientCountry');
    if (!select || select.dataset.loaded === '1') return;
    try {
      const data = await api('/api/countries');
      const list = Array.isArray(data.countries) ? data.countries : [];
      const old = select.value || 'OM';
      select.innerHTML = list.map((c) => `<option value="${esc(c.code)}">${esc(c.flag || '')} ${esc(c.name || c.code)} (+${esc(c.callingCode || '')})</option>`).join('');
      select.value = list.some((c) => c.code === old) ? old : (list.some((c) => c.code === 'OM') ? 'OM' : (list[0]?.code || ''));
      select.dataset.loaded = '1';
    } catch (error) {
      select.innerHTML = '<option value="OM">🇴🇲 عُمان (+968)</option>';
    }
  }

  async function load({ stay = true } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      const data = await api(`/api/state?sessionId=${encodeURIComponent(sid())}`);
      state.data = data;
      await loadCountries();
      pruneSelections();
      renderTop();
      renderPage(stay ? state.page : 'home');
      setupBackground();
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.loading = false;
    }
  }

  function pruneSelections() {
    const validRecipients = new Set((state.data?.recipients || []).map((x) => `r:${x.id}`));
    const validGroups = new Set((state.data?.groups || []).map((x) => `g:${x.id}`));
    const validImages = new Set((state.data?.images || []).map((x) => x.id));
    const validTargets = new Set([...validRecipients, ...validGroups]);
    for (const key of selected.targets) if (!validRecipients.has(key)) selected.targets.delete(key);
    for (const key of selected.groups) if (!validGroups.has(key)) selected.groups.delete(key);
    for (const key of selected.images) if (!validImages.has(key)) selected.images.delete(key);
    for (const key of selected.schedule) if (!validTargets.has(key)) selected.schedule.delete(key);
  }

  async function act(url, options = {}) {
    const button = options.button;
    if (button) button.classList.add('loading');
    try {
      const data = await api(url, options);
      toast(data.message || 'تم التنفيذ بنجاح.');
      await load();
      return data;
    } catch (error) {
      toast(error.message, true);
      throw error;
    } finally {
      if (button) button.classList.remove('loading');
    }
  }

  function renderHome() {
    const d = state.data || {};
    const w = d.whatsapp || {};
    const settings = d.settings || {};
    const schedule = d.schedule || {};
    const rules = (d.interaction?.rules || []).filter((x) => x.enabled !== false).length;
    $('homeTitle').textContent = `الرئيسية — ${d.session?.name || ''}`;
    $('heroText').textContent = w.ready ? 'الجلسة جاهزة للإرسال والاستقبال والتفاعل.' : 'ابدأ من «الجلسات» لربط WhatsApp، ثم استخدم الصفحات حسب حاجتك.';
    $('homeStatus').textContent = human(w.status);
    $('homeDot').className = `dot ${w.ready ? 'ok' : ['error', 'auth_failure'].includes(w.status) ? 'bad' : ''}`;
    $('currentImageName').textContent = d.currentImage?.filename || 'لا توجد صورة';
    $('flowImage').textContent = d.currentImage?.filename || '—';
    $('flowPre').textContent = settings.preText || 'بدون';
    $('flowPost').textContent = settings.postText || 'اختياري';
    $('nextRun').textContent = schedule.nextRun || 'متوقفة';
    $('statRecipients').textContent = (d.recipients || []).filter((x) => x.enabled !== false).length;
    $('statImages').textContent = (d.images || []).length;
    $('statSent').textContent = d.stats?.sentImages || 0;
    $('statRules').textContent = rules;
    $('quickWa').textContent = human(w.status);
    $('quickWaDot').className = `dot ${w.ready ? 'ok' : ['error', 'auth_failure'].includes(w.status) ? 'bad' : ''}`;
    $('quickSchedule').textContent = settings.scheduleEnabled ? 'مفعّلة' : 'متوقفة';
    $('quickScheduleDot').className = `dot ${settings.scheduleEnabled ? 'ok' : 'bad'}`;
    $('quickInteraction').textContent = settings.interactionEnabled ? 'مفعّل' : 'متوقف';
    $('quickInteractionDot').className = `dot ${settings.interactionEnabled ? 'ok' : 'bad'}`;
    $('quickState').textContent = w.ready ? 'يعمل' : 'يحتاج ربط';
    $('homeLogs').innerHTML = (d.logs || []).slice(0, 18).map((entry) =>
      `<div class="log"><b>${esc(entry.level)}</b> ${esc(entry.message)}</div>`
    ).join('') || '<div class="log">لا يوجد نشاط بعد.</div>';
  }

  function renderRecipientList() {
    const el = $('recipientList');
    if (!el) return;
    el.innerHTML = (state.data?.recipients || []).map((r) => `
      <div class="item">
        <div class="avatar">${esc((r.name || '?')[0])}</div>
        <div><strong>${esc(r.name)}</strong><small>${esc(r.formatted || r.phone)} · ${esc(r.country || '')}</small></div>
        <div class="row">
          <input type="checkbox" data-rec="${esc(r.id)}" ${selected.targets.has(`r:${r.id}`) ? 'checked' : ''} ${r.enabled === false ? 'disabled' : ''}>
          <button class="btn sm" data-test-rec="${esc(r.id)}">اختبار</button>
          <button class="btn sm" data-toggle-rec="${esc(r.id)}">${r.enabled === false ? 'تفعيل' : 'إيقاف'}</button>
          <button class="btn sm danger" data-del-rec="${esc(r.id)}">حذف</button>
        </div>
      </div>`).join('') || '<div class="empty">أضف أول رقم.</div>';
    $$('[data-rec]').forEach((input) => input.onchange = () => {
      input.checked ? selected.targets.add(`r:${input.dataset.rec}`) : selected.targets.delete(`r:${input.dataset.rec}`);
      updateSelection();
    });
    $$('[data-test-rec]').forEach((button) => button.onclick = () => sendTestTarget(`r:${button.dataset.testRec}`));
    $$('[data-toggle-rec]').forEach((button) => button.onclick = () => act(`/api/recipient/${encodeURIComponent(button.dataset.toggleRec)}/toggle`, { method: 'POST' }));
    $$('[data-del-rec]').forEach((button) => button.onclick = () => confirm('حذف الرقم؟') && act(`/api/recipient/${encodeURIComponent(button.dataset.delRec)}`, { method: 'DELETE' }));
  }

  function renderGroupTargets() {
    const el = $('groupSendList');
    if (!el) return;
    const groups = (state.data?.groups || []).filter((x) => x.enabled !== false);
    el.innerHTML = groups.map((g) => `
      <label class="check-card"><input type="checkbox" data-group-send="${esc(g.id)}" ${selected.groups.has(`g:${g.id}`) ? 'checked' : ''}>
      <span><strong>${esc(g.name)}</strong><small>${esc(g.gid)}</small></span></label>`).join('') || '<div class="empty">لا توجد مجموعات محفوظة في هذه الجلسة.</div>';
    $$('[data-group-send]').forEach((input) => input.onchange = () => {
      input.checked ? selected.groups.add(`g:${input.dataset.groupSend}`) : selected.groups.delete(`g:${input.dataset.groupSend}`);
      updateSelection();
    });
  }

  function renderImages() {
    const el = $('imageList');
    if (!el) return;
    const images = state.data?.images || [];
    el.innerHTML = images.map((file) => `
      <label class="image ${selected.images.has(file.id) ? 'selected' : ''} ${state.data?.currentImage?.id === file.id ? 'current' : ''}">
        <input type="checkbox" data-img="${esc(file.id)}" ${selected.images.has(file.id) ? 'checked' : ''}>
        ${file.isImage ? `<img src="${esc(file.url)}" alt="">` : '<div style="aspect-ratio:1;display:grid;place-items:center;background:#0a1420;color:#91a5ba">ملف</div>'}
        <div class="image-body"><div class="image-name">${esc(file.filename)}</div><div class="image-meta">${Math.max(1, Math.round((file.size || 0) / 1024))} KB · ${file.isImage ? 'صورة' : 'ملف'}</div><button type="button" class="btn sm danger" data-del-media="${esc(file.filename)}">حذف</button></div>
      </label>`).join('') || '<div class="empty">لا توجد ملفات بعد.</div>';
    $$('[data-img]').forEach((input) => input.onchange = () => {
      input.checked ? selected.images.add(input.dataset.img) : selected.images.delete(input.dataset.img);
      renderImages();
      updateSelection();
    });
    $$('[data-del-media]').forEach((button) => button.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (confirm(`حذف ${button.dataset.delMedia}؟`)) act(`/api/media/${encodeURIComponent(button.dataset.delMedia)}`, { method: 'DELETE' });
    });
  }

  function renderScheduleTargets() {
    const el = $('scheduleTargetList');
    if (!el) return;
    const all = [
      ...(state.data?.recipients || []).filter((x) => x.enabled !== false).map((x) => ({ key: `r:${x.id}`, name: x.name, desc: x.formatted || x.phone, kind: 'رقم' })),
      ...(state.data?.groups || []).filter((x) => x.enabled !== false).map((x) => ({ key: `g:${x.id}`, name: x.name, desc: x.gid, kind: 'مجموعة' }))
    ];
    const saved = new Set(state.data?.settings?.scheduleTargets || []);
    if (!selected.schedule.size) for (const key of saved) selected.schedule.add(key);
    el.innerHTML = all.map((item) => `
      <label class="check-card"><input type="checkbox" data-schedule="${esc(item.key)}" ${selected.schedule.has(item.key) ? 'checked' : ''}>
      <span><strong>${esc(item.name)}</strong><small>${esc(item.kind)} · ${esc(item.desc)}</small></span></label>`).join('') || '<div class="empty">لا توجد أهداف.</div>';
    $$('[data-schedule]').forEach((input) => input.onchange = () => {
      input.checked ? selected.schedule.add(input.dataset.schedule) : selected.schedule.delete(input.dataset.schedule);
    });
  }

  function updateSelection() {
    const count = selected.targets.size + selected.groups.size;
    const summary = $('selectionSummary');
    if (summary) summary.textContent = `${count} مستلمين/مجموعات · ${selected.images.size} صور/ملفات`;
  }

  function renderSend() {
    renderRecipientList();
    renderGroupTargets();
    renderImages();
    renderScheduleTargets();
    const s = state.data?.settings || {};
    $('preText').value = s.preText || '';
    $('postText').value = s.postText || '';
    $('sendOrder').value = s.sendOrder || 'target-first';
    $('scheduleEnabled').checked = !!s.scheduleEnabled;
    $('scheduledGroups').checked = s.scheduledGroupsEnabled !== false;
    $('scheduleTime').value = s.scheduleTime || '17:30';
    $('scheduleDate').value = s.scheduleDate || '';
    $('scheduleDay').innerHTML = DAY_NAMES.map((name, index) => `<option value="${index}" ${Number(s.scheduleDay) === index ? 'selected' : ''}>${name}</option>`).join('');
    updateSelection();
    if ($('scheduleStateText')) $('scheduleStateText').textContent = `الموعد القادم: ${state.data?.schedule?.nextRun || 'متوقفة'} · آخر تنفيذ: ${state.data?.lastRun?.at || '—'}`;
    if ($('scheduleBadge')) $('scheduleBadge').textContent = s.scheduleEnabled ? 'مفعّلة' : 'متوقفة';
  }

  function renderAutomation() {
    const s = state.data?.settings || {};
    const schedule = state.data?.schedule || {};
    const next = schedule.nextRun || 'متوقفة';
    const status = $('automationStatus');
    if (status) status.textContent = s.scheduleEnabled ? 'مفعّلة' : 'متوقفة';
    const box = $('automationSummary');
    if (box) box.innerHTML = `<div class="phase2-item"><strong>موعد الجلسة الحالية</strong><div class="phase2-kv"><span>الحالة<b>${s.scheduleEnabled ? 'مفعّلة' : 'متوقفة'}</b></span><span>الموعد القادم<b>${esc(next)}</b></span><span>اليوم<b>${esc(DAY_NAMES[Number(s.scheduleDay) || 0])}</b></span><span>الساعة<b>${esc(s.scheduleTime || '17:30')}</b></span></div></div>`;
    const targets = $('automationTargets');
    const count = (s.scheduleTargets || []).length;
    if (targets) targets.innerHTML = `<div class="callout">${count ? `هذه الجلسة تستخدم ${count} أهداف محفوظة للجدولة.` : 'لم تحدد أهدافًا خاصة؛ سيستخدم المجدول الأهداف المفعلة في هذه الجلسة.'}</div>`;
    const h = $('automationHistory');
    if (h) h.innerHTML = state.data?.lastRun ? `<div class="log"><b>آخر تشغيل</b> ${esc(state.data.lastRun.at || '—')} · ${esc(state.data.lastRun.image || '—')} · نجاح ${state.data.lastRun.sent?.length || 0} · فشل ${state.data.lastRun.failed?.length || 0}</div>` : '<div class="log">لم يتم تنفيذ جدولة بعد.</div>';
  }

  function renderInteraction() {
    const settings = state.data?.settings || {};
    $('interactionEnabled').checked = settings.interactionEnabled !== false;
    $('interactionScope').value = settings.interactionScope || 'all';
    $('interactionChatIds').value = (settings.interactionChatIds || []).join('\n');
    $('interactionIgnoreOwn').checked = settings.interactionIgnoreOwn !== false;
    $('maxActions').value = settings.maxActionsPerMinute || 20;
    $('quietEnabled').checked = !!settings.interactionQuietEnabled;
    $('quietStart').value = settings.interactionQuietStart || '23:00';
    $('quietEnd').value = settings.interactionQuietEnd || '07:00';
    $('interactionState').textContent = settings.interactionEnabled !== false ? 'مفعّل' : 'متوقف';
    if ($('groupAssistantEnabled')) $('groupAssistantEnabled').checked = settings.groupAssistantEnabled !== false;
    $('interactionDot').className = `dot ${settings.interactionEnabled !== false ? 'ok' : ''}`;
    const rules = state.data?.interaction?.rules || [];
    $('ruleList').innerHTML = rules.map((rule) => `
      <div class="item"><div><strong>${esc(rule.name)}</strong><small>${rule.when?.type === 'reaction' ? 'Reaction' : 'رسالة'} · ${esc(rule.when?.match)} · ${esc(rule.when?.value || 'أي شيء')}</small><div class="muted">${rule.then?.reply ? `الرد: ${esc(rule.then.reply)}` : ''}${rule.then?.reaction ? ` · Reaction ${esc(rule.then.reaction)}` : ''}</div></div>
      <span class="pill">${rule.enabled === false ? 'متوقفة' : 'مفعّلة'}</span><div class="row"><button class="btn sm" data-rule-toggle="${esc(rule.id)}">${rule.enabled === false ? 'تشغيل' : 'إيقاف'}</button><button class="btn sm danger" data-rule-del="${esc(rule.id)}">حذف</button></div></div>`).join('') || '<div class="empty">لا توجد قواعد.</div>';
    $$('[data-rule-toggle]').forEach((button) => button.onclick = () => act(`/api/interaction/rules/${encodeURIComponent(button.dataset.ruleToggle)}/toggle`, { method: 'POST' }));
    $$('[data-rule-del]').forEach((button) => button.onclick = () => confirm('حذف القاعدة؟') && act(`/api/interaction/rules/${encodeURIComponent(button.dataset.ruleDel)}`, { method: 'DELETE' }));
  }

  function renderGroups() {
    const groups = state.data?.groups || [];
    $('groupCount').textContent = `${groups.length} مجموعات`;
    $('groupList').innerHTML = groups.map((group) => `
      <div class="phase2-item"><div class="between"><strong>${esc(group.name)}</strong><span class="pill">${group.enabled === false ? 'متوقفة' : 'مفعّلة'}</span></div>
      <div class="phase2-kv"><span>GID<b>${esc(group.gid)}</b></span><span>الأعضاء<b>${group.participantsCount ?? '؟'}</b></span></div>
      <div class="muted" style="margin-top:6px">${esc(group.description || 'بدون وصف')}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-group-toggle="${esc(group.id)}">${group.enabled === false ? 'تفعيل' : 'إيقاف'}</button><button class="btn sm" data-group-refresh="${esc(group.id)}">تحديث</button></div></div>`).join('') || '<div class="empty">لا توجد مجموعات محفوظة.</div>';
    $$('[data-group-toggle]').forEach((button) => button.onclick = () => act(`/api/groups/${encodeURIComponent(button.dataset.groupToggle)}/toggle`, { method: 'POST' }));
    $$('[data-group-refresh]').forEach((button) => button.onclick = () => act(`/api/groups/${encodeURIComponent(button.dataset.groupRefresh)}/refresh`, { method: 'POST' }));
  }

  function renderSessions() {
    const w = state.data?.whatsapp || {};
    $('authStatus').textContent = human(w.status);
    $('authDot').className = `dot ${w.ready ? 'ok' : ['error', 'auth_failure'].includes(w.status) ? 'bad' : ''}`;
    $('authHint').textContent = w.ready ? 'الجلسة جاهزة للإرسال والاستقبال.' : 'اضغط «ربط / تشغيل» ثم امسح QR إذا ظهر.';
    $('qrBox').innerHTML = w.qr ? `<img src="${esc(w.qr)}" alt="QR">` : '<span class="muted">QR سيظهر هنا</span>';
    $('sessionList').innerHTML = (state.data?.sessions || []).map((session) => `
      <div class="item"><div><strong>${esc(session.name)}</strong><small>${esc(session.id)} · ${session.ready ? 'متصل' : 'غير متصل'} · ${session.recipients} أرقام · ${session.images} صور</small></div><span class="pill">${esc(human(session.status))}</span>
      <div class="row"><button class="btn sm" data-session-switch="${esc(session.id)}">${session.id === state.data.activeSessionId ? 'الحالية' : 'تبديل'}</button><button class="btn sm" data-session-rename="${esc(session.id)}">تسمية</button><button class="btn sm danger" data-session-delete="${esc(session.id)}">حذف</button></div></div>`).join('');
    $$('[data-session-switch]').forEach((button) => button.onclick = () => switchSession(button.dataset.sessionSwitch));
    $$('[data-session-rename]').forEach((button) => button.onclick = async () => { const name = prompt('اسم الجلسة الجديد:'); if (name !== null) await act(`/api/sessions/${encodeURIComponent(button.dataset.sessionRename)}`, { method: 'PUT', body: JSON.stringify({ name }) }); });
    $$('[data-session-delete]').forEach((button) => button.onclick = () => confirm('حذف الجلسة وبياناتها؟') && act(`/api/sessions/${encodeURIComponent(button.dataset.sessionDelete)}`, { method: 'DELETE' }));
  }

  function renderSettings() {
    const s = state.data?.settings || {};
    $('dayOfWeek').innerHTML = DAY_NAMES.map((name, index) => `<option value="${index}">${name}</option>`).join('');
    $('dayOfWeek').value = String(s.scheduleDay ?? 5);
    const [hour, minute] = String(s.scheduleTime || '17:30').split(':');
    $('hour').value = hour || '17'; $('minute').value = minute || '30';
    $('scheduleEnabledSettings').checked = !!s.scheduleEnabled;
    $('timezone').value = s.timezone || 'Asia/Muscat';
    $('settingPre').value = s.preText || '';
    $('settingPost').value = s.postText || '';
    $('retryAttempts').value = s.retryAttempts || 2;
    $('retryDelay').value = s.retryDelayMs || 1600;
    $('sendDelay').value = s.sendDelayMs ?? 700;
    $('settingDuplicateGuard').checked = true;
    $('settingCountCycle').checked = false;
    $('settingSendOrder').value = s.sendOrder || 'target-first';
    $('autoStart').checked = s.autoStartSession !== false;
    $('headless').value = s.browserHeadless === false ? 'false' : 'true';
    renderBackground();
  }

  function renderGuideState() {}

  async function switchSession(id) {
    try {
      await api('/api/sessions/switch', { method: 'POST', body: JSON.stringify({ sessionId: id }) });
      selected.targets.clear(); selected.groups.clear(); selected.images.clear(); selected.schedule.clear();
      await load({ stay: false });
      toast('تم التبديل إلى الجلسة المحددة.');
    } catch (error) { toast(error.message, true); }
  }

  async function addRecipient() {
    try {
      const data = await api('/api/recipient', { method: 'POST', body: JSON.stringify({ sessionId: sid(), name: $('recipientName').value, country: $('recipientCountry').value, phone: $('recipientPhone').value }) });
      $('recipientName').value = ''; $('recipientPhone').value = '';
      toast(`تمت إضافة ${data.recipient.formatted}`);
      await load();
    } catch (error) { toast(error.message, true); }
  }

  async function validatePhone() {
    try {
      const data = await api('/api/phone/validate', { method: 'POST', body: JSON.stringify({ sessionId: sid(), country: $('recipientCountry').value || 'OM', phone: $('recipientPhone').value }) });
      const phone = $('phoneHint');
      phone.className = 'muted phone-valid';
      phone.textContent = `✓ ${data.message}`;
    } catch (error) {
      const phone = $('phoneHint');
      phone.className = 'muted phone-invalid';
      phone.textContent = `✕ ${error.message}`;
    }
  }

  async function sendTestTarget(key) {
    await act('/api/send', { method: 'POST', body: JSON.stringify({ sessionId: sid(), targetKeys: [key], preText: 'رسالة اختبار من chat BOT', repeatGuard: false }) });
  }

  async function sendNow() {
    const keys = targetKeys();
    const mediaIds = [...selected.images];
    if (!keys.length) return toast('حدد رقمًا أو مجموعة واحدة على الأقل.', true);
    if (!mediaIds.length && !String($('preText').value || '').trim() && !String($('postText').value || '').trim()) return toast('اكتب رسالة أو اختر ملفًا واحدًا على الأقل.', true);
    try {
      const data = await api('/api/send', { method: 'POST', body: JSON.stringify({
        sessionId: sid(), targetKeys: keys, mediaIds,
        preText: $('preText').value, postText: $('postText').value,
        sendOrder: $('sendOrder').value, countTowardCycle: $('countTowardCycle').checked,
        repeatGuard: $('duplicateGuard').checked
      }) });
      toast(data.failed?.length ? `اكتمل مع ${data.failed.length} نتيجة تحتاج مراجعة.` : 'تم الإرسال بنجاح.');
      await load();
      renderSend();
    } catch (error) { toast(error.message, true); }
  }

  async function saveSchedule() {
    await act('/api/schedule', { method: 'POST', body: JSON.stringify({
      sessionId: sid(), scheduleMode: $('scheduleDate').value ? 'once' : 'weekly', scheduleTime: $('scheduleTime').value,
      scheduleDay: Number($('scheduleDay').value), scheduleDate: $('scheduleDate').value, scheduleEnabled: $('scheduleEnabled').checked,
      scheduledGroupsEnabled: $('scheduledGroups').checked, scheduleTargets: [...selected.schedule]
    }) });
  }

  function preset(kind) {
    const presets = {
      hello: ['ترحيب', 'message', 'contains', 'سلام', 'وعليكم السلام {{sender}} 👋', ''],
      thanks: ['شكر', 'message', 'contains', 'شكر', 'العفو 🌟', ''],
      welcome: ['ترحيب', 'message', 'contains', 'مرحبا', 'أهلًا وسهلًا ✨', ''],
      help: ['مساعدة', 'message', 'contains', 'مساعدة', 'كيف أساعدك؟', ''],
      morning: ['صباح', 'message', 'contains', 'صباح', 'صباح الخير ☀️', ''],
      thumb: ['رد 👍', 'reaction', 'exact', '👍', '', '👍']
    };
    const p = presets[kind]; if (!p) return;
    $('ruleName').value = p[0]; $('whenType').value = p[1]; $('whenMatch').value = p[2]; $('whenValue').value = p[3]; $('reply').value = p[4]; $('reaction').value = p[5];
  }

  async function testRuleActual() {
    const sample = String($('whenValue')?.value || '').trim();
    const value = String($('whenValue')?.value || '').trim();
    if (!sample) return toast('اكتب قيمة للمطابقة أولًا.', true);
    try {
      const data = await api('/api/interaction/test', { method: 'POST', body: JSON.stringify({ type: $('whenType').value, match: $('whenMatch').value, value, sample, reactionSample: sample }) });
      $('ruleTest').textContent = data.matches ? '✓ القاعدة تتطابق مع المثال الحالي.' : '○ القاعدة لا تتطابق مع المثال الحالي.';
    } catch (error) { $('ruleTest').textContent = error.message; toast(error.message, true); }
  }

  async function addRule() {
    const scope = $('scope').value;
    const chatIds = $('ruleChatIds').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (scope === 'selected' && !chatIds.length) return toast('أدخل IDs عند اختيار «محدد فقط».', true);
    await act('/api/interaction/rules', { method: 'POST', body: JSON.stringify({
      sessionId: sid(), name: $('ruleName').value || 'قاعدة', priority: 10,
      when: { type: $('whenType').value, match: $('whenMatch').value, value: $('whenValue').value },
      then: { reply: $('reply').value, reaction: $('reaction').value }, scope, chatIds, cooldownSec: Number($('cooldown').value || 30)
    }) });
  }

  async function saveInteraction() {
    await act('/api/settings', { method: 'POST', body: JSON.stringify({
      sessionId: sid(), interactionEnabled: $('interactionEnabled').checked, interactionIgnoreOwn: $('interactionIgnoreOwn').checked,
      groupAssistantEnabled: $('groupAssistantEnabled')?.checked !== false, interactionScope: $('interactionScope').value,
      interactionChatIds: $('interactionChatIds').value.split(/\s+/).map((x) => x.trim()).filter(Boolean),
      interactionQuietEnabled: $('quietEnabled').checked, interactionQuietStart: $('quietStart').value,
      interactionQuietEnd: $('quietEnd').value, maxActionsPerMinute: Number($('maxActions').value || 20)
    }) });
  }

  async function saveSettings() {
    const time = `${String($('hour').value).padStart(2, '0')}:${String($('minute').value).padStart(2, '0')}`;
    await act('/api/settings', { method: 'POST', body: JSON.stringify({
      sessionId: sid(), timezone: $('timezone').value, scheduleEnabled: $('scheduleEnabledSettings').checked,
      scheduleDay: Number($('dayOfWeek').value), scheduleTime: time, preText: $('settingPre').value, postText: $('settingPost').value,
      retryAttempts: Number($('retryAttempts').value), retryDelayMs: Number($('retryDelay').value), sendDelayMs: Number($('sendDelay').value),
      autoStartSession: $('autoStart').checked, browserHeadless: $('headless').value === 'true', sendOrder: $('settingSendOrder').value,
      scheduledGroupsEnabled: state.data?.settings?.scheduledGroupsEnabled !== false
    }) });
  }

  function renderBackground() {
    const background = state.data?.background || {};
    const modeKey = Object.entries(BG_MAP).find(([, internal]) => internal === background.mode)?.[0] || 'aurora';
    $$('#backgroundOptions .bg-option').forEach((button) => button.classList.toggle('active', button.dataset.bgMode === modeKey));
    $('backgroundStatus').textContent = BG_LABELS[modeKey] || 'الشفق';
    $('backgroundOpacity').value = Math.round(Number(background.opacity ?? 0.22) * 100);
    $('backgroundOpacityValue').textContent = `${$('backgroundOpacity').value}%`;
    const cfg = { ...BG_DEFAULTS, ...(background.settings || {}) };
    $('backgroundControls').innerHTML = `
      <div class="bg-field"><label>السرعة <output>${Number(cfg.speed).toFixed(2)}</output></label><input id="bgSpeed" type="range" min="0.1" max="3" step="0.1" value="${cfg.speed}"></div>
      <div class="bg-field"><label>الكثافة <output>${Number(cfg.density).toFixed(2)}</output></label><input id="bgDensity" type="range" min="0.2" max="2" step="0.1" value="${cfg.density}"></div>
      <div class="bg-field"><label>التوهج <output>${Number(cfg.glow).toFixed(2)}</output></label><input id="bgGlow" type="range" min="0" max="1" step="0.05" value="${cfg.glow}"></div>
      <div class="bg-field"><label>الشدة <output>${Number(cfg.intensity).toFixed(2)}</output></label><input id="bgIntensity" type="range" min="0.2" max="1.8" step="0.05" value="${cfg.intensity}"></div>
      <div class="bg-field"><label>التفاعل</label><select id="bgInteractive" class="select"><option value="true" ${cfg.interactive !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${cfg.interactive === false ? 'selected' : ''}>متوقف</option></select></div>
      <div class="bg-field"><label>الحركة الناعمة</label><select id="bgTrail" class="select"><option value="true" ${cfg.trail !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${cfg.trail === false ? 'selected' : ''}>متوقف</option></select></div>`;
    ['bgSpeed', 'bgDensity', 'bgGlow', 'bgIntensity', 'bgInteractive', 'bgTrail'].forEach((id) => $(id)?.addEventListener('input', previewBackground));
    $('bgInteractive')?.addEventListener('change', previewBackground); $('bgTrail')?.addEventListener('change', previewBackground);
    $('backgroundCustom').textContent = background.imageUrl ? 'الخلفية الخاصة مفعّلة لهذه الجلسة.' : 'الخلفية الخاصة: لا توجد.';
    window.bgEngine?.set({ mode: background.mode || 'aurora', settings: cfg, opacity: Number(background.opacity ?? 0.22), imageUrl: background.imageUrl });
  }

  function previewBackground() {
    const active = $('#backgroundOptions .bg-option.active');
    const mode = BG_MAP[active?.dataset.bgMode || 'aurora'];
    const settings = {
      speed: Number($('#bgSpeed')?.value || 1), density: Number($('#bgDensity')?.value || 1),
      glow: Number($('#bgGlow')?.value || 0.6), intensity: Number($('#bgIntensity')?.value || 1),
      interactive: $('#bgInteractive')?.value !== 'false', trail: $('#bgTrail')?.value !== 'false'
    };
    const opacity = Number($('#backgroundOpacity')?.value || 22) / 100;
    ['bgSpeed', 'bgDensity', 'bgGlow', 'bgIntensity'].forEach((id) => { const input = $(id), output = input?.parentElement?.querySelector('output'); if (output) output.textContent = Number(input.value).toFixed(2); });
    window.bgEngine?.set({ mode, settings, opacity, imageUrl: state.data?.background?.imageUrl });
  }

  class BackgroundEngine {
    constructor(canvas) {
      this.c = canvas; this.x = canvas?.getContext('2d'); this.mode = 'aurora'; this.cfg = { ...BG_DEFAULTS };
      this.p = { x: 0.5, y: 0.5, down: false }; this.t = 0; this.last = 0;
      this.resize(); addEventListener('resize', () => this.resize());
      canvas?.addEventListener('pointermove', (e) => { this.p.x = e.clientX / innerWidth; this.p.y = e.clientY / innerHeight; });
      canvas?.addEventListener('pointerdown', () => { this.p.down = true; }); addEventListener('pointerup', () => { this.p.down = false; });
      requestAnimationFrame((t) => this.frame(t));
    }
    resize() { if (!this.c || !this.x) return; const dpr = Math.min(devicePixelRatio || 1, 2); this.w = innerWidth; this.h = innerHeight; this.c.width = Math.floor(this.w * dpr); this.c.height = Math.floor(this.h * dpr); this.x.setTransform(dpr, 0, 0, dpr, 0, 0); }
    set(data) { if (!data) return; this.mode = data.mode || this.mode; this.cfg = { ...this.cfg, ...(data.settings || {}) }; const image = $('bgImageLayer'); if (image) { image.style.opacity = data.imageUrl ? String(Math.max(0.28, Number(data.opacity ?? 0.22))) : '0'; image.style.backgroundImage = data.imageUrl ? `url("${data.imageUrl}")` : 'none'; } if (this.c) this.c.style.opacity = String(Math.max(0.1, Math.min(0.8, 0.14 + Number(data.opacity ?? 0.22) * 0.9))); }
    frame(time) { const dt = Math.min(40, time - (this.last || time)); this.last = time; this.t += dt * 0.001 * Number(this.cfg.speed || 1); this.draw(); requestAnimationFrame((t) => this.frame(t)); }
    clear() { this.x.fillStyle = `rgba(4,10,18,${this.cfg.trail === false ? 0.22 : 0.11})`; this.x.fillRect(0, 0, this.w, this.h); }
    draw() { if (!this.x) return; const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, p = this.p; x.save(); this.clear(); x.globalCompositeOperation = 'lighter'; if (this.mode === 'aurora') this.aurora(); else if (this.mode === 'nebula') this.nebula(); else if (this.mode === 'meteor') this.meteor(); else if (this.mode === 'matrix') this.matrix(); else if (this.mode === 'cyber-grid') this.grid(); else if (this.mode === 'plasma') this.waves(); else if (this.mode === 'starfield') this.stars(); else if (this.mode === 'vortex') this.vortex(); else this.ocean(); if (c.interactive !== false) { x.beginPath(); x.arc(p.x * w, p.y * h, 16 + Math.sin(t * 3) * 4, 0, Math.PI * 2); x.strokeStyle = `rgba(110,231,183,${0.08 * c.intensity})`; x.stroke(); if (p.down) { x.beginPath(); x.arc(p.x * w, p.y * h, 42 + Math.sin(t * 8) * 8, 0, Math.PI * 2); x.strokeStyle = `rgba(120,184,255,${0.14 * c.intensity})`; x.stroke(); } } x.restore(); }
    aurora() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg; for (let k = 0; k < 4; k++) { x.beginPath(); for (let i = 0; i <= w; i += 12) x.lineTo(i, h * (0.18 + k * 0.16) + Math.sin(i * 0.008 + t * (0.55 + k * 0.18)) * 32); x.strokeStyle = `hsla(${165 + k * 35},90%,65%,${0.055 * c.intensity})`; x.lineWidth = 55; x.shadowBlur = 35 * c.glow; x.stroke(); } }
    nebula() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, n = Math.floor(110 * c.density); for (let i = 0; i < n; i++) { const a = i * 12.9898 % 6.283, r = ((i * 37.13) % 1) * Math.min(w, h) * 0.5, q = t * (0.2 + (i % 7) / 35), vx = w * 0.5 + Math.cos(a + q) * r, vy = h * 0.5 + Math.sin(a + q * 0.8) * r * 0.65; x.fillStyle = `hsla(${205 + (i % 4) * 32},90%,70%,${0.11 * c.intensity})`; x.beginPath(); x.arc(vx, vy, 2 + (i % 8), 0, Math.PI * 2); x.fill(); } }
    meteor() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, n = Math.floor(45 * c.density); for (let i = 0; i < n; i++) { const sp = 70 + (i % 9) * 18, vx = (i * 97 + t * sp * 1.8) % (w + 300) - 150, vy = (i * 43 + t * sp * 0.7) % (h + 120) - 60; x.beginPath(); x.moveTo(vx, vy); x.lineTo(vx - sp * 0.28, vy - sp * 0.11); x.strokeStyle = `hsla(${185 + (i % 5) * 25},95%,70%,${0.18 * c.intensity})`; x.lineWidth = 1 + (i % 3); x.stroke(); } }
    matrix() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, cols = Math.floor(78 * c.density), step = Math.max(13, w / Math.max(cols, 1)); x.font = '15px monospace'; for (let i = 0; i < cols; i++) { const y = (i * 79 + t * (55 + (i % 7) * 6)) % (h + 220) - 220; x.fillStyle = `rgba(110,231,249,${0.2 * c.intensity})`; x.fillText(String.fromCharCode(0x30a0 + (i * 13) % 90), i * step, y); } }
    grid() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, step = Math.max(38, 112 - c.density * 45), off = (t * 35) % step; x.strokeStyle = `rgba(120,184,255,${0.1 * c.intensity})`; for (let y = -step + off; y < h + step; y += step) { x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); } for (let xx = -step + (t * 18 % step); xx < w + step; xx += step) { x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx, h); x.stroke(); } }
    waves() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg; for (let k = 0; k < 6; k++) { x.beginPath(); for (let i = 0; i <= w; i += 10) x.lineTo(i, h * (0.22 + k * 0.12) + Math.sin(i * 0.012 + t * (0.8 + k * 0.08)) * 28); x.strokeStyle = `hsla(${190 + k * 23},85%,62%,${0.07 * c.intensity})`; x.lineWidth = 18; x.stroke(); } }
    stars() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, n = Math.floor(170 * c.density); for (let i = 0; i < n; i++) { const z = ((i * 31 + t * 14) % 100) / 100, vx = (i * 97.31) % w, vy = (i * 47.21) % h; x.fillStyle = `rgba(220,240,255,${0.15 + z * 0.6})`; x.beginPath(); x.arc(vx, vy, 0.5 + z * 2.4, 0, Math.PI * 2); x.fill(); } }
    vortex() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg, n = Math.floor(145 * c.density); for (let i = 0; i < n; i++) { const p = i / n, a = p * Math.PI * 10 + t * (0.3 + p), r = p * Math.min(w, h) * 0.42, vx = w / 2 + Math.cos(a) * r, vy = h / 2 + Math.sin(a) * r * 0.62; x.fillStyle = `hsla(${190 + p * 130},95%,68%,${0.1 * c.intensity})`; x.beginPath(); x.arc(vx, vy, 1 + p * 2.5, 0, Math.PI * 2); x.fill(); } }
    ocean() { const x = this.x, w = this.w, h = this.h, t = this.t, c = this.cfg; for (let k = 0; k < 7; k++) { x.beginPath(); for (let i = 0; i <= w; i += 10) x.lineTo(i, h * (0.52 + k * 0.07) + Math.sin(i * 0.009 + t * (0.65 + k * 0.05)) * 18); x.strokeStyle = `hsla(${180 + k * 8},85%,65%,${0.055 * c.intensity})`; x.lineWidth = 10 + c.glow * 10; x.stroke(); } }
  }

  function setupBackground() {
    if (!window.bgEngine) window.bgEngine = new BackgroundEngine($('bgCanvas'));
    window.bgEngine.set(state.data?.background || { mode: 'aurora', settings: BG_DEFAULTS, opacity: 0.22 });
  }

  async function discoverGroups(button) { await act('/api/groups/discover', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button }); }
  async function refreshGroups(button) { await act('/api/groups/refresh-all', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button }); }

  function bind() {
    $$('button[data-page]').forEach((button) => button.onclick = () => go(button.dataset.page));
    $$('[data-page-link]').forEach((button) => button.onclick = () => go(button.dataset.pageLink));
    $('refreshBtn').onclick = () => load();
    $('homeRefresh').onclick = () => load();
    $('homeConnect').onclick = () => go('sessions');
    $('themeBtn').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; localStorage.setItem('chatbot-theme', document.documentElement.dataset.theme); };
    $('connectSession').onclick = (e) => act('/api/session/connect', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget });
    $('refreshSession').onclick = () => load();
    $('stopSession').onclick = (e) => act('/api/session/stop', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget });
    $('unlinkSession').onclick = (e) => confirm('إلغاء ربط الحساب؟') && act('/api/session/unlink', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget });
    $('newSession').onclick = async () => { const name = prompt('اسم الجلسة', 'جلسة جديدة'); if (name) await act('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) }); };
    $('addRecipient').onclick = addRecipient;
    $('validatePhone').onclick = validatePhone;
    $('allRecipients').onclick = () => { (state.data?.recipients || []).filter((x) => x.enabled !== false).forEach((x) => selected.targets.add(`r:${x.id}`)); renderRecipientList(); updateSelection(); };
    $('clearRecipients').onclick = () => { selected.targets.clear(); renderRecipientList(); updateSelection(); };
    $('allGroupsSend').onclick = () => { (state.data?.groups || []).filter((x) => x.enabled !== false).forEach((x) => selected.groups.add(`g:${x.id}`)); renderGroupTargets(); updateSelection(); };
    $('clearGroupsSend').onclick = () => { selected.groups.clear(); renderGroupTargets(); updateSelection(); };
    $('allImages').onclick = () => { (state.data?.images || []).forEach((x) => selected.images.add(x.id)); renderImages(); updateSelection(); };
    $('clearImages').onclick = () => { selected.images.clear(); renderImages(); updateSelection(); };
    $('chooseImages').onclick = () => $('imageInput').click();
    $('imageInput').onchange = () => uploadFiles([...$('imageInput').files]);
    const drop = $('dropzone');
    if (drop) {
      ['dragenter', 'dragover'].forEach((event) => drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach((event) => drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
      drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
    }
    $('normalizeImages').onclick = async (e) => { try { await act('/api/media/normalize', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget }); } catch {} };
    $('openImageFolder').onclick = async () => { try { await api('/api/media/open-folder', { method: 'POST', body: JSON.stringify({ sessionId: sid() }) }); toast('تم فتح مجلد الوسائط.'); } catch (error) { toast(error.message, true); } };
    $('sendPreflight').onclick = () => { const keys = targetKeys(); const count = selected.images.size; $('sendPlan').textContent = keys.length && (count || $('preText').value.trim() || $('postText').value.trim()) ? `جاهز: ${keys.length} هدف و${count} ملف. سيُرسل حسب ترتيب التنفيذ المحدد.` : 'حدد هدفًا واكتب رسالة أو اختر ملفًا.'; };
    $('sendInstant').onclick = (e) => sendNow(e.currentTarget);
    $('testSelected').onclick = () => { const key = targetKeys()[0]; key ? sendTestTarget(key) : toast('حدد هدفًا أولًا.', true); };
    $('skipCycle').onclick = (e) => act('/api/cycle/skip', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget });
    $('resetCycle').onclick = (e) => act('/api/cycle/reset', { method: 'POST', body: JSON.stringify({ sessionId: sid() }), button: e.currentTarget });
    $('saveSchedule').onclick = (e) => saveSchedule(e.currentTarget);
    $('automationEnable')?.addEventListener('click', async (e) => { try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ sessionId: sid(), scheduleEnabled: true }) }); await load(); toast('تم تشغيل الجدولة.'); } catch (error) { toast(error.message, true); } });
    $('automationDisable')?.addEventListener('click', async (e) => { try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ sessionId: sid(), scheduleEnabled: false }) }); await load(); toast('تم إيقاف الجدولة.'); } catch (error) { toast(error.message, true); } });
    $('refreshAutomation')?.addEventListener('click', () => load().catch((error) => toast(error.message, true)));
    $('allScheduleTargets').onclick = () => { (state.data?.recipients || []).filter((x) => x.enabled !== false).forEach((x) => selected.schedule.add(`r:${x.id}`)); (state.data?.groups || []).filter((x) => x.enabled !== false).forEach((x) => selected.schedule.add(`g:${x.id}`)); renderScheduleTargets(); };
    $('clearScheduleTargets').onclick = () => { selected.schedule.clear(); renderScheduleTargets(); };
    $$('[data-preset]').forEach((button) => button.onclick = () => preset(button.dataset.preset));
    $('addRule').onclick = addRule;
    $('testRule').onclick = testRuleActual;
    $('saveInteractionSettings').onclick = saveInteraction;
    $('discoverGroups').onclick = (e) => discoverGroups(e.currentTarget);
    $('refreshGroups').onclick = (e) => refreshGroups(e.currentTarget);
    $('analyzeGid').onclick = analyzeGid;
    $('analyzeInvite').onclick = analyzeInvite;
    $('saveGroupAnalysis').onclick = saveGroupAnalysis;
    $('saveSettings').onclick = saveSettings;
    $('runReview').onclick = async (e) => { try { const data = await api(`/api/diagnostics?sessionId=${encodeURIComponent(sid())}`); $('reviewBox').innerHTML = Object.entries(data.checks).map(([key, value]) => `<div class="between"><span>${esc(key)}</span><span class="badge"><i class="dot ${value ? 'ok' : 'bad'}"></i>${value === true ? 'OK' : esc(value)}</span></div>`).join(''); toast('اكتمل الفحص.'); } catch (error) { toast(error.message, true); } };
    $('removeBackground').onclick = async (e) => { try { await api('/api/background/remove', { method: 'POST', body: JSON.stringify({ sessionId: sid() }) }); toast('تمت إزالة الخلفية الخاصة.'); await load(); } catch (error) { toast(error.message, true); } };
    $('backgroundInput').onchange = uploadBackground;
    $$('#backgroundOptions .bg-option').forEach((button) => button.onclick = () => {
      $$('#backgroundOptions .bg-option').forEach((b) => b.classList.toggle('active', b === button));
      const internal = BG_MAP[button.dataset.bgMode];
      window.bgEngine?.set({ mode: internal, settings: state.data?.background?.settings || BG_DEFAULTS, opacity: Number($('backgroundOpacity').value) / 100, imageUrl: state.data?.background?.imageUrl });
      $('backgroundStatus').textContent = BG_LABELS[button.dataset.bgMode];
      previewBackground();
      saveBackground();
    });
    $('backgroundOpacity').oninput = () => { $('backgroundOpacityValue').textContent = `${$('backgroundOpacity').value}%`; previewBackground(); };
    $('backgroundOpacity').onchange = saveBackground;
    $('assistantOrb').onclick = () => { assistantOpen = !assistantOpen; $('assistantPanel').classList.toggle('open', assistantOpen); };
    $('closeAssistant').onclick = () => { assistantOpen = false; $('assistantPanel').classList.remove('open'); };
    const titles = { connect: 'كيف أربط WhatsApp؟', send: 'كيف أرسل؟', groups: 'كيف أتعامل مع المجموعات؟', numbers: 'كيف أضيف رقمًا دوليًا؟', interaction: 'كيف أشغل التفاعل؟', errors: 'ما الحل عند حدوث خطأ؟' };
    $('assistantQuestions').innerHTML = Object.entries(assistant).map(([key]) => `<button class="q" data-q="${key}">${titles[key]}</button>`).join('');
    $$('[data-q]').forEach((button) => button.onclick = () => { $('assistantAnswer').textContent = assistant[button.dataset.q]; $('assistantAnswer').classList.add('show'); });
  }

  async function analyzeGid() {
    try {
      const data = await api('/api/groups/analyze-gid', { method: 'POST', body: JSON.stringify({ sessionId: sid(), gid: $('gid').value }) });
      pendingGroup = data.group; $('groupResult').innerHTML = groupResultHtml(data.group); $('saveGroupAnalysis').disabled = !data.group?.gid;
    } catch (error) { toast(error.message, true); }
  }
  async function analyzeInvite() {
    try {
      const data = await api('/api/groups/analyze-invite', { method: 'POST', body: JSON.stringify({ sessionId: sid(), url: $('invite').value }) });
      pendingGroup = data.group; $('groupResult').innerHTML = groupResultHtml(data.group); $('saveGroupAnalysis').disabled = !data.group?.gid;
    } catch (error) { toast(error.message, true); }
  }
  function groupResultHtml(group) { return `<div class="phase2-item"><strong>${esc(group?.name || 'مجموعة')}</strong><div class="phase2-kv"><span>GID<b>${esc(group?.gid || 'غير متاح')}</b></span><span>الأعضاء<b>${group?.participantsCount ?? '؟'}</b></span></div><div class="muted" style="margin-top:6px">${esc(group?.description || 'بدون وصف')}</div></div>`; }
  async function saveGroupAnalysis() {
    if (!pendingGroup?.gid) return toast('لا يوجد GID صالح للحفظ.', true);
    try { await api('/api/groups/save', { method: 'POST', body: JSON.stringify({ sessionId: sid(), group: pendingGroup }) }); pendingGroup = null; $('saveGroupAnalysis').disabled = true; toast('تم حفظ المجموعة داخل الجلسة الحالية.'); await load(); renderGroups(); } catch (error) { toast(error.message, true); }
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    const form = new FormData(); files.forEach((file) => form.append('files', file)); form.append('sessionId', sid());
    try { await api('/api/media', { method: 'POST', body: form }); toast(`تم رفع ${files.length} ملف.`); await load(); go('send'); } catch (error) { toast(error.message, true); }
  }
  async function uploadBackground() {
    const file = $('backgroundInput').files?.[0]; if (!file) return;
    const form = new FormData(); form.append('file', file); form.append('sessionId', sid());
    try { await api('/api/background', { method: 'POST', body: form }); toast('تم تطبيق الخلفية الخاصة.'); await load(); } catch (error) { toast(error.message, true); }
  }
  async function saveBackground() {
    const active = $('#backgroundOptions .bg-option.active');
    if (!active) return;
    const settings = { speed: Number($('#bgSpeed')?.value || 1), density: Number($('#bgDensity')?.value || 1), glow: Number($('#bgGlow')?.value || 0.6), intensity: Number($('#bgIntensity')?.value || 1), interactive: $('#bgInteractive')?.value !== 'false', trail: $('#bgTrail')?.value !== 'false' };
    try { await api('/api/settings/background', { method: 'POST', body: JSON.stringify({ sessionId: sid(), mode: BG_MAP[active.dataset.bgMode], settings, opacity: Number($('backgroundOpacity').value) / 100 }) }); } catch (error) { toast(error.message, true); }
  }

  const theme = localStorage.getItem('chatbot-theme');
  if (theme) document.documentElement.dataset.theme = theme;
  bind();
  load({ stay: true });
})();
