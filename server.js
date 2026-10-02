'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const express = require('express');
const multer = require('multer');

const store = require('./src/store');
const media = require('./src/media');
const phones = require('./src/phones');
const { WhatsAppManager, safeError } = require('./src/whatsapp');
const { DeliveryService, renderTemplate } = require('./src/delivery');
const { InteractionEngine, validateRule, matchRule } = require('./src/interaction');
const { ReliableScheduler, localParts, due, nextRun } = require('./src/scheduler');
const groups = require('./src/groups');
const { AutomationService, zonedDateToUtc } = require('./src/automation');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = store.toInt(process.env.PORT, 7005, 1, 65535);
const TEMP_DIR = path.join(store.DATA_DIR, '_temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });

function log(id, level, message, extra = null) {
  if (!id) { globalLog(level, message, extra); return; }
  const safeCandidate = store.safeSessionId(id);
  if (!store.listSessionIds().includes(safeCandidate)) { globalLog(level, `[${safeCandidate}] ${message}`, extra); return; }
  const safeId = safeCandidate;
  const s = store.loadSession(safeId);
  const entry = { at: new Date().toISOString(), level, message, extra };
  s.logs = [...s.logs, entry].slice(-400);
  store.saveSession(s);
  try { fs.appendFileSync(store.getPaths(safeId).logFile, `[${entry.at}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`, 'utf8'); } catch {}
  console.log(`[${entry.at}] [${safeId}] [${level}] ${message}`);
}
function globalLog(level, message, extra = null) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  try { fs.appendFileSync(path.join(store.DATA_DIR, 'system.log'), line + '\n', 'utf8'); } catch {}
}
function sid(value) { const raw = value || store.activeSessionId(); return store.assertSession(raw); }
function replyError(res, status, error) { return res.status(status).json({ ok: false, error: safeError(error) }); }
function activeSession(req) { return sid(req.body?.sessionId || req.query?.sessionId); }

const whatsapp = new WhatsAppManager({ store, log });
const delivery = new DeliveryService({ store, whatsapp, log });
const interaction = new InteractionEngine({ store, whatsapp, log });
const scheduler = new ReliableScheduler({ store, ids: () => store.listSessionIds(), run: id => delivery.scheduledRun(id), log });
const automation = new AutomationService({ store, delivery, whatsapp, log });

async function handleGroupCommand(id, message) {
  try {
    const s = store.loadSession(id);
    if (!s.settings.groupAssistantEnabled || message?.fromMe) return;
    const body = String(message?.body || '').trim();
    if (!body) return;
    const commandMatch = /^(?:\/|!)?(?:gid|group\s*id|تحليل\s*(?:المجموعة|القروب)|معرف\s*المجموعة|معلومات\s*المجموعة)\b/i.test(body);
    const invite = body.match(/https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i);
    const gidMatch = body.match(/\b\d{5,20}[-A-Za-z0-9]*@g\.us\b/i);
    if (!commandMatch && !invite && !gidMatch) return;
    const target = invite ? invite[0] : (gidMatch ? gidMatch[0] : body.replace(/^(?:\/|!)?(?:gid|group\s*id|تحليل\s*(?:المجموعة|القروب)|معرف\s*المجموعة|معلومات\s*المجموعة)\s*:?[\s]*/i, '').trim());
    if (!target) {
      await whatsapp.replyToMessage(id, message, 'أرسل GID مثل 1203630XXXXXXXX@g.us أو رابط دعوة من chat.whatsapp.com لتحليل المجموعة.');
      return;
    }
    let info;
    if (groups.isGroupId(target)) info = await whatsapp.getGroupInfo(id, groups.normalizeGid(target));
    else info = await whatsapp.analyzeGroupInvite(id, groups.extractInviteCode(target));
    const text = `تحليل المجموعة\n${groups.formatGroupAnalysis(info)}\n\nإذا توفر GID صالح، يمكنك حفظ المجموعة من قسم المجموعات في لوحة التحكم.`;
    await whatsapp.replyToMessage(id, message, text);
    log(id, 'INFO', `تم تحليل مجموعة عبر أمر WhatsApp: ${info.gid || 'GID غير متاح'}`);
  } catch (e) {
    try { await whatsapp.replyToMessage(id, message, `تعذر تحليل المجموعة: ${safeError(e)}`); } catch {}
    log(id, 'ERROR', `فشل تحليل المجموعة عبر WhatsApp: ${safeError(e)}`);
  }
}

whatsapp.on('message', (id, message) => Promise.allSettled([
  interaction.onMessage(id, message),
  handleGroupCommand(id, message)
]).then(results => { for (const result of results) if (result.status === 'rejected') log(id, 'ERROR', `حدث الرسالة: ${safeError(result.reason)}`); }));
whatsapp.on('reaction', (id, reaction) => interaction.onReaction(id, reaction).catch(e => log(id, 'ERROR', `Reaction: ${safeError(e)}`)));

function imagePayload(id) {
  const s = store.loadSession(id);
  const scan = media.scanImages(store.getPaths(id).images, s.settings.maxImageSizeMB);
  return scan.images.map(x => ({ ...x, url: `/media/${encodeURIComponent(x.filename)}?sessionId=${encodeURIComponent(id)}` }));
}
function currentImage(id) { return delivery.currentImage(id); }
function snapshot(id) {
  const s = store.loadSession(id);
  const scan = media.scanImages(store.getPaths(id).images, s.settings.maxImageSizeMB);
  const r = whatsapp.listRuntime(id);
  return {
    version: store.APP_VERSION,
    session: { id:s.id, name:s.name, setupComplete:s.setupComplete },
    activeSessionId: store.activeSessionId(),
    phoneCountries: phones.countries(),
    sessions: store.listSessionIds().map(x => { const ss=store.loadSession(x), rr=whatsapp.listRuntime(x), ii=media.scanImages(store.getPaths(x).images, ss.settings.maxImageSizeMB); return { id:ss.id, name:ss.name, status:rr.status, ready:rr.ready, recipients:ss.recipients.filter(y=>y.enabled!==false).length, images:ii.images.length }; }),
    recipients: s.recipients,
    groups: s.groups || [],
    automation: s.automation || { enabled:true, tasks:[], recent:[] },
    images: scan.images.map(x => ({ ...x, url:`/media/${encodeURIComponent(x.filename)}?sessionId=${encodeURIComponent(id)}` })),
    duplicates: scan.duplicates,
    invalidImages: scan.invalid,
    currentImage: currentImage(id),
    cycle: s.cycle,
    settings: s.settings,
    interaction: s.interaction,
    whatsapp: r,
    schedule: { ...scheduler.status(s), nextRun: nextRun(s), due: due(new Date(), s) },
    clock: localParts(new Date(), s.settings.timezone),
    background: {
      mode: s.settings.backgroundMode,
      imageName: s.settings.backgroundImage,
      imageUrl: s.settings.backgroundImage ? `/background/${encodeURIComponent(s.settings.backgroundImage)}?sessionId=${encodeURIComponent(id)}&v=${encodeURIComponent(s.updatedAt)}` : null,
      opacity: s.settings.backgroundOpacity,
      settings: s.settings.backgroundSettings,
      profiles: s.settings.backgroundProfiles
    },
    stats: s.stats,
    lastRun: s.lastRun,
    lastBackup: s.lastBackup,
    logs: s.logs.slice(-60).reverse()
  };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit:'4mb' }));
app.use(express.urlencoded({ extended:true, limit:'4mb' }));
app.use('/control', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); next(); });
app.use(express.static(path.join(store.ROOT, 'public')));
app.get('/control/ping',(req,res)=>res.status(200).json({ok:true,version:store.APP_VERSION,service:'chat-BOT',time:new Date().toISOString()}));
app.get('/media/:filename', (req,res)=>{ try { const id=sid(req.query.sessionId); res.sendFile(media.safeImagePath(store.getPaths(id).images, decodeURIComponent(req.params.filename))); } catch { res.status(404).send('Not found'); } });
app.get('/background/:filename', (req,res)=>{ try { const id=sid(req.query.sessionId); const s=store.loadSession(id); const requested=decodeURIComponent(req.params.filename); if(!s.settings.backgroundImage || requested!==s.settings.backgroundImage) return res.status(404).send('Not found'); res.setHeader('Cache-Control','no-store, max-age=0'); res.sendFile(media.safeBackgroundPath(store.getPaths(id).backgrounds, requested)); } catch { res.status(404).send('Not found'); } });

const upload = multer({
  dest:TEMP_DIR,
  limits:{ fileSize:50*1024*1024, files:100 },
  fileFilter:(_req,file,cb)=>{
    const ext=path.extname(file.originalname||'').toLowerCase();
    if (media.EXT.has(ext) && media.MIME[ext] === file.mimetype) return cb(null, true);
    return cb(new Error('نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP أو GIF.'));
  }
});

const backgroundUpload = multer({
  dest:TEMP_DIR,
  limits:{ fileSize:15*1024*1024, files:1 },
  fileFilter:(_req,file,cb)=>{
    const ext=path.extname(file.originalname||'').toLowerCase();
    if (media.BACKGROUND_EXT.has(ext) && media.BACKGROUND_MIME[ext] === file.mimetype) return cb(null, true);
    return cb(new Error('خلفية غير مدعومة. استخدم JPG أو PNG أو WEBP فقط.'));
  }
});

/* Local control routes: browser <-> this computer only. No external AI/API service. */
app.get('/control/state', (req,res)=>{ try { res.json({ok:true,...snapshot(activeSession(req))}); } catch(e){ replyError(res,500,e); } });
app.get('/control/health', (req,res)=>{ try { const id=activeSession(req), s=store.loadSession(id), r=whatsapp.listRuntime(id), scan=media.scanImages(store.getPaths(id).images,s.settings.maxImageSizeMB); res.json({ok:true,version:store.APP_VERSION,sessionId:id,status:r.status,ready:r.ready,browser:r.browser,images:scan.images.length,recipients:s.recipients.filter(x=>x.enabled!==false).length,scheduler:scheduler.status(s),lastAck:r.lastAck,lastSent:r.lastSent}); } catch(e){ replyError(res,500,e); } });
app.get('/control/review', (req,res)=>{ try { const id=activeSession(req), s=store.loadSession(id), r=whatsapp.listRuntime(id), scan=media.scanImages(store.getPaths(id).images,s.settings.maxImageSizeMB), d=due(new Date(),s); res.json({ok:true,checks:[
  {title:'المتصفح',ok:Boolean(r.browser),detail:r.browser||'غير موجود'},
  {title:'جلسة WhatsApp',ok:r.ready,detail:r.status},
  {title:'مستلم واحد على الأقل',ok:s.recipients.some(x=>x.enabled!==false),detail:String(s.recipients.filter(x=>x.enabled!==false).length)},
  {title:'صورة واحدة على الأقل',ok:scan.images.length>0,detail:String(scan.images.length)},
  {title:'الجدولة',ok:s.settings.scheduleEnabled,detail:nextRun(s)||'متوقفة'},
  {title:'الوقت الحالي',ok:Number.isFinite(d.late),detail:`${String(snapshot(id).clock.hour).padStart(2,'0')}:${String(snapshot(id).clock.minute).padStart(2,'0')}`}
],version:store.APP_VERSION,noExternalAI:true}); } catch(e){ replyError(res,500,e); } });

/* Sessions */
app.get('/control/sessions',(req,res)=>res.json({ok:true,activeSessionId:store.activeSessionId(),sessions:store.listSessionIds().map(id=>{const s=store.loadSession(id),r=whatsapp.listRuntime(id);return{id:s.id,name:s.name,status:r.status,ready:r.ready,groups:(s.groups||[]).filter(g=>g.enabled!==false).length,automation:(s.automation?.tasks||[]).filter(t=>t.enabled!==false).length};})}));
app.post('/control/sessions',async(req,res)=>{try{const previousId=store.activeSessionId();const s=store.createSession(String(req.body?.name||'جلسة جديدة'));if(previousId&&previousId!==s.id)await whatsapp.stop(previousId).catch(e=>log(previousId,'WARN',`تعذر إيقاف الجلسة السابقة بعد إنشاء جلسة جديدة: ${safeError(e)}`));scheduler.wake(s.id);scheduler.wakeAll();res.json({ok:true,session:{id:s.id,name:s.name}});}catch(e){replyError(res,400,e);}});
app.post('/control/sessions/switch',async(req,res)=>{try{const targetId=sid(req.body?.sessionId);const previousId=store.activeSessionId();if(previousId&&previousId!==targetId)await whatsapp.stop(previousId).catch(e=>log(previousId,'WARN',`تعذر إيقاف الجلسة السابقة أثناء التبديل: ${safeError(e)}`));const session=store.setActiveSession(targetId);if(session.settings.autoStartSession&&whatsapp.hasSavedAuth(session.id))await whatsapp.start(session.id).catch(e=>log(session.id,'WARN',`تعذر تشغيل الجلسة الجديدة تلقائيًا: ${safeError(e)}`));res.json({ok:true,sessionId:session.id,runtime:whatsapp.listRuntime(session.id)});}catch(e){replyError(res,400,e);}});
app.put('/control/sessions/:id',(req,res)=>{try{const s=store.renameSession(req.params.id,req.body?.name);res.json({ok:true,session:{id:s.id,name:s.name}});}catch(e){replyError(res,400,e);}});
app.delete('/control/sessions/:id',async(req,res)=>{try{const id=sid(req.params.id);await whatsapp.stop(id,{clearAuth:true});scheduler.cancel(id);const g=store.deleteSession(id);res.json({ok:true,activeSessionId:g.activeSessionId});}catch(e){replyError(res,400,e);}});

/* Simple QR-only authentication */
app.post('/control/session/connect',async(req,res)=>{try{const id=activeSession(req);const r=await whatsapp.start(id);res.json({ok:true,runtime:r,message:r.qr?'امسح QR الظاهر في صفحة الجلسات.':r.ready?'الجلسة جاهزة.':'تم بدء الاتصال.'});}catch(e){replyError(res,400,e);}});
app.get('/control/session/status',(req,res)=>{try{res.json({ok:true,...whatsapp.listRuntime(activeSession(req))});}catch(e){replyError(res,500,e);}});
app.post('/control/session/stop',async(req,res)=>{try{await whatsapp.stop(activeSession(req));res.json({ok:true});}catch(e){replyError(res,400,e);}});
app.post('/control/session/unlink',async(req,res)=>{try{await whatsapp.stop(activeSession(req),{clearAuth:true});res.json({ok:true});}catch(e){replyError(res,400,e);}});

/* Recipients */
function parseRecipientPhone(input, country) {
  const parsed = phones.parse(input, country || 'OM');
  return {
    phone: parsed.digits,
    country: parsed.country,
    callingCode: parsed.callingCode,
    formatted: parsed.international,
    national: parsed.national
  };
}
app.post('/control/phone/validate',(req,res)=>{
  try {
    const parsed = phones.tryParse(req.body?.phone, String(req.body?.country||'OM').toUpperCase());
    if (!parsed.ok) return res.status(400).json({ok:false,error:parsed.error});
    res.json({ok:true,number:parsed});
  } catch(e) { replyError(res,400,e); }
});
app.post('/control/recipients',(req,res)=>{
  try{
    const s=store.loadSession(activeSession(req));
    const name=String(req.body?.name||'').trim();
    if(!name) throw new Error('اكتب اسم المستلم.');
    const normalized=parseRecipientPhone(req.body?.phone, String(req.body?.country||'OM').toUpperCase());
    if(s.recipients.some(x=>x.phone===normalized.phone)) throw new Error('الرقم مكرر في هذه الجلسة.');
    const r={id:crypto.randomUUID(),name:name.slice(0,80),...normalized,enabled:true,createdAt:new Date().toISOString()};
    s.recipients.push(r);s.setupComplete=true;store.saveSession(s);
    res.json({ok:true,recipient:r});
  }catch(e){replyError(res,400,e);}
});
app.post('/control/recipients/:id/toggle',(req,res)=>{try{const s=store.loadSession(activeSession(req));const r=s.recipients.find(x=>x.id===req.params.id);if(!r)throw new Error('المستلم غير موجود.');r.enabled=!r.enabled;store.saveSession(s);res.json({ok:true,enabled:r.enabled});}catch(e){replyError(res,400,e);}});
app.put('/control/recipients/:id',(req,res)=>{
  try{
    const s=store.loadSession(activeSession(req));
    const r=s.recipients.find(x=>x.id===req.params.id);
    if(!r) throw new Error('المستلم غير موجود.');
    const name=String(req.body?.name??r.name).trim();
    if(!name) throw new Error('اكتب اسم المستلم.');
    const normalized=parseRecipientPhone(req.body?.phone??r.phone, String(req.body?.country||r.country||'OM').toUpperCase());
    if(s.recipients.some(x=>x.id!==r.id&&x.phone===normalized.phone)) throw new Error('الرقم مكرر في هذه الجلسة.');
    Object.assign(r,{name:name.slice(0,80),...normalized});
    store.saveSession(s);res.json({ok:true,recipient:r});
  }catch(e){replyError(res,400,e);}
});
app.delete('/control/recipients/:id',(req,res)=>{try{const s=store.loadSession(activeSession(req));const before=s.recipients.length;s.recipients=s.recipients.filter(x=>x.id!==req.params.id);if(before===s.recipients.length)throw new Error('المستلم غير موجود.');store.saveSession(s);res.json({ok:true});}catch(e){replyError(res,400,e);}});

/* Groups */
function saveGroupRecord(session, info) {
  if (!info?.gid || !String(info.gid).endsWith('@g.us')) throw new Error('WhatsApp لم يعِد GID صالحًا لهذه المجموعة.');
  const existing = (session.groups || []).find(g => g.gid === info.gid);
  const normalized = store.normalizeGroup({
    id: existing?.id,
    name: info.name,
    gid: info.gid,
    inviteCode: info.inviteCode,
    description: info.description,
    owner: info.owner,
    participantsCount: info.participantsCount,
    discoveredAt: existing?.discoveredAt,
    updatedAt: new Date().toISOString(),
    enabled: existing?.enabled !== false
  });
  session.groups = Array.isArray(session.groups) ? session.groups : [];
  if (existing) Object.assign(existing, normalized);
  else session.groups.push(normalized);
  store.saveSession(session);
  return normalized;
}
app.get('/control/groups',(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id);res.json({ok:true,groups:s.groups||[]});}catch(e){replyError(res,500,e);}});
app.post('/control/groups/discover',async(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id),found=await whatsapp.listGroups(id),saved=[];for(const info of found){saved.push(saveGroupRecord(s,info));}res.json({ok:true,found:found.length,saved});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/refresh-all',async(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id),saved=[],failed=[];for(const g of (s.groups||[])){try{const info=await whatsapp.getGroupInfo(id,g.gid);saved.push(saveGroupRecord(s,info));}catch(e){failed.push({id:g.id,name:g.name,error:safeError(e)});}}res.json({ok:failed.length===0,saved,failed});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/analyze-gid',async(req,res)=>{try{const id=activeSession(req),info=await whatsapp.getGroupInfo(id,groups.normalizeGid(req.body?.gid));res.json({ok:true,group:info});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/analyze-invite',async(req,res)=>{try{const id=activeSession(req);const code=groups.extractInviteCode(req.body?.url || req.body?.code);const info=await whatsapp.analyzeGroupInvite(id,code);res.json({ok:true,group:info});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/save',async(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id);let info=req.body?.group && typeof req.body.group==='object' ? req.body.group : null;if(!info?.gid) { if(req.body?.gid) info=await whatsapp.getGroupInfo(id,groups.normalizeGid(req.body.gid)); else throw new Error('أدخل GID المجموعة.'); } const saved=saveGroupRecord(s,info);res.json({ok:true,group:saved});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/:id/refresh',async(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id),g=s.groups.find(x=>x.id===req.params.id);if(!g)throw new Error('المجموعة غير موجودة.');const info=await whatsapp.getGroupInfo(id,g.gid);const saved=saveGroupRecord(s,info);res.json({ok:true,group:saved});}catch(e){replyError(res,400,e);}});
app.post('/control/groups/:id/toggle',(req,res)=>{try{const s=store.loadSession(activeSession(req)),g=s.groups.find(x=>x.id===req.params.id);if(!g)throw new Error('المجموعة غير موجودة.');g.enabled=!g.enabled;store.saveSession(s);res.json({ok:true,enabled:g.enabled});}catch(e){replyError(res,400,e);}});
app.delete('/control/groups/:id',(req,res)=>{try{const s=store.loadSession(activeSession(req)),before=s.groups.length;s.groups=s.groups.filter(x=>x.id!==req.params.id);if(before===s.groups.length)throw new Error('المجموعة غير موجودة.');store.saveSession(s);res.json({ok:true});}catch(e){replyError(res,400,e);}});
/* Images */
app.post('/control/images/upload',upload.array('images',100),(req,res)=>{try{const id=activeSession(req), dir=store.getPaths(id).images;const files=req.files||[];if(!files.length)throw new Error('لم يتم اختيار صور.');const added=[];for(const f of files){try{added.push(media.importImage(f.path,f.originalname,dir));}finally{try{fs.unlinkSync(f.path);}catch{}}}delivery.syncCycle(id);res.json({ok:true,added,images:imagePayload(id)});}catch(e){for(const f of req.files||[])try{fs.unlinkSync(f.path);}catch{}replyError(res,400,e);}});
app.post('/control/images/normalize',(req,res)=>{try{const id=activeSession(req);const out=media.normalizeNames(store.getPaths(id).images);delivery.syncCycle(id);res.json({ok:true,changes:out.changes,images:imagePayload(id)});}catch(e){replyError(res,400,e);}});
app.delete('/control/images/:filename',(req,res)=>{try{const id=activeSession(req),file=media.safeImagePath(store.getPaths(id).images,decodeURIComponent(req.params.filename));fs.unlinkSync(file);delivery.syncCycle(id);res.json({ok:true});}catch(e){replyError(res,400,e);}});
app.post('/control/images/open-folder',(req,res)=>{try{if(process.platform!=='win32')throw new Error('فتح المجلد من الواجهة متاح على Windows فقط.');execFile('explorer.exe',[store.getPaths(activeSession(req)).images]);res.json({ok:true});}catch(e){replyError(res,400,e);}});

/* Sending */
app.post('/control/send/instant',async(req,res)=>{try{const result=await delivery.instantSend(activeSession(req),{recipientIds:Array.isArray(req.body?.recipientIds)?req.body.recipientIds.map(String):[],groupIds:Array.isArray(req.body?.groupIds)?req.body.groupIds.map(String):[],imageIds:Array.isArray(req.body?.imageIds)?req.body.imageIds.map(String):[],preText:req.body?.preText,postText:req.body?.postText,duplicateGuard:req.body?.duplicateGuard,countTowardCycle:req.body?.countTowardCycle,sendOrder:req.body?.sendOrder});res.status(result.ok?200:207).json(result);}catch(e){replyError(res,400,e);}});
app.post('/control/send/preflight',async(req,res)=>{try{const id=activeSession(req);const result=await delivery.preflightSelection(id,{recipientIds:req.body?.recipientIds||[],groupIds:req.body?.groupIds||[],imageIds:req.body?.imageIds||[],preText:req.body?.preText,postText:req.body?.postText,duplicateGuard:req.body?.duplicateGuard,countTowardCycle:req.body?.countTowardCycle});res.status(result.ok?200:207).json(result);}catch(e){replyError(res,400,e);}});
app.post('/control/send/test',async(req,res)=>{try{res.json(await delivery.testRecipient(activeSession(req),String(req.body?.recipientId||'')));}catch(e){replyError(res,400,e);}});
app.post('/control/groups/:id/test',async(req,res)=>{try{res.json(await delivery.testGroup(activeSession(req),String(req.params.id)));}catch(e){replyError(res,400,e);}});
app.post('/control/cycle/skip',(req,res)=>{try{res.json({ok:true,currentImage:delivery.skip(activeSession(req))});}catch(e){replyError(res,400,e);}});
app.post('/control/cycle/reset',(req,res)=>{try{res.json({ok:true,currentImage:delivery.reset(activeSession(req))});}catch(e){replyError(res,400,e);}});

/* Automation — exact dates/times + recurring tasks */
app.get('/control/automation',(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id);res.json({ok:true,enabled:s.automation.enabled,tasks:s.automation.tasks,recent:s.automation.recent});}catch(e){replyError(res,500,e);}});
app.post('/control/automation/settings',(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id);s.settings.automationEnabled=store.toBool(req.body?.enabled,s.settings.automationEnabled);s.automation.enabled=s.settings.automationEnabled;store.saveSession(s);res.json({ok:true,enabled:s.automation.enabled});}catch(e){replyError(res,400,e);}});
app.post('/control/automation/tasks',(req,res)=>{try{const id=activeSession(req),body=req.body||{},timezone=String(body.timezone||store.loadSession(id).settings.timezone).trim();if(!store.validTimezone(timezone))throw new Error('المنطقة الزمنية غير صالحة.');let runAt=body.runAt?String(body.runAt):null;if(body.date||body.time){runAt=zonedDateToUtc(String(body.date||''),String(body.time||''),timezone).toISOString();}const task=store.normalizeTask({...body,timezone,runAt,targets:{recipientIds:Array.isArray(body.recipientIds)?body.recipientIds:[],groupIds:Array.isArray(body.groupIds)?body.groupIds:[]},repeat:{kind:body.repeatKind||body.repeat?.kind||'once',interval:body.repeatInterval??body.repeat?.interval??1}});if(!task.runAt)throw new Error('حدد التاريخ والوقت.');const runMs=Date.parse(task.runAt);if(!Number.isFinite(runMs))throw new Error('موعد المهمة غير صالح.');if(runMs < Date.now()-5*60*1000 && task.repeat.kind==='once')throw new Error('موعد المهمة قديم. اختر تاريخًا ووقتًا قادمين لتجنب إرسال غير مقصود.');const saved=automation.addOrUpdate(id,task);res.json({ok:true,task:saved});}catch(e){replyError(res,400,e);}});
app.post('/control/automation/tasks/:id/toggle',(req,res)=>{try{const enabled=automation.toggle(activeSession(req),req.params.id);res.json({ok:true,enabled});}catch(e){replyError(res,400,e);}});
app.delete('/control/automation/tasks/:id',(req,res)=>{try{automation.remove(activeSession(req),req.params.id);res.json({ok:true});}catch(e){replyError(res,400,e);}});
app.post('/control/automation/tasks/:id/run',async(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id),task=s.automation.tasks.find(t=>t.id===req.params.id);if(!task)throw new Error('المهمة غير موجودة.');await automation.execute(id,task);const out=store.loadSession(id).automation.tasks.find(t=>t.id===task.id);res.json({ok:out?.lastStatus==='success',task:out});}catch(e){replyError(res,400,e);}});
/* Interaction */
function ruleFromBody(body){const rule=store.normalizeRule({id:body?.id,name:body?.name,enabled:body?.enabled,priority:body?.priority,scope:body?.scope,chatIds:body?.chatIds,when:{type:body?.type,match:body?.match,value:body?.value,ignoreCase:body?.ignoreCase},then:{reply:body?.reply,reaction:body?.reaction,stopAfter:body?.stopAfter},cooldownSec:body?.cooldownSec});validateRule(rule);return rule;}
app.post('/control/interaction',(req,res)=>{try{const s=store.loadSession(activeSession(req));s.settings.interactionEnabled=store.toBool(req.body?.enabled,s.settings.interactionEnabled);s.settings.interactionScope=['all','private','groups','selected'].includes(req.body?.scope)?req.body.scope:s.settings.interactionScope;s.settings.interactionChatIds=Array.isArray(req.body?.chatIds)?req.body.chatIds.map(x=>String(x).trim()).filter(Boolean).slice(0,200):s.settings.interactionChatIds;s.settings.interactionIgnoreOwn=store.toBool(req.body?.ignoreOwn,s.settings.interactionIgnoreOwn);s.interaction.enabled=s.settings.interactionEnabled;s.interaction.scope=s.settings.interactionScope;s.interaction.chatIds=s.settings.interactionChatIds.slice();s.interaction.ignoreOwnMessages=s.settings.interactionIgnoreOwn;s.settings.maxActionsPerMinute=store.toInt(req.body?.maxActionsPerMinute,s.settings.maxActionsPerMinute,1,120);s.settings.interactionQuietEnabled=store.toBool(req.body?.quietEnabled,s.settings.interactionQuietEnabled);s.settings.interactionQuietStart=/^([01]\d|2[0-3]):[0-5]\d$/.test(String(req.body?.quietStart||''))?String(req.body.quietStart):s.settings.interactionQuietStart;s.settings.interactionQuietEnd=/^([01]\d|2[0-3]):[0-5]\d$/.test(String(req.body?.quietEnd||''))?String(req.body.quietEnd):s.settings.interactionQuietEnd;store.saveSession(s);res.json({ok:true,interaction:s.interaction,settings:s.settings});}catch(e){replyError(res,400,e);}});
app.post('/control/interaction/rules',(req,res)=>{try{const s=store.loadSession(activeSession(req));const rule=ruleFromBody(req.body||{});const existing=s.interaction.rules.findIndex(x=>x.id===rule.id);if(existing>=0)s.interaction.rules[existing]=rule;else s.interaction.rules.push(rule);s.interaction.rules=s.interaction.rules.slice(-100);store.saveSession(s);res.json({ok:true,rule,rules:s.interaction.rules});}catch(e){replyError(res,400,e);}});
app.post('/control/interaction/rules/:id/toggle',(req,res)=>{try{const s=store.loadSession(activeSession(req));const r=s.interaction.rules.find(x=>x.id===req.params.id);if(!r)throw new Error('القاعدة غير موجودة.');r.enabled=!r.enabled;store.saveSession(s);res.json({ok:true,enabled:r.enabled});}catch(e){replyError(res,400,e);}});
app.delete('/control/interaction/rules/:id',(req,res)=>{try{const s=store.loadSession(activeSession(req));s.interaction.rules=s.interaction.rules.filter(x=>x.id!==req.params.id);store.saveSession(s);res.json({ok:true});}catch(e){replyError(res,400,e);}});
app.post('/control/interaction/test',(req,res)=>{try{const rule=ruleFromBody(req.body||{});const kind=rule.when.type;const result=matchRule(rule,kind,String(req.body?.sample||''),String(req.body?.reactionSample||''));res.json({ok:true,matches:result});}catch(e){replyError(res,400,e);}});
app.post('/control/interaction/clear',(req,res)=>{try{const s=store.loadSession(activeSession(req));s.interaction.recent=[];store.saveSession(s);res.json({ok:true});}catch(e){replyError(res,400,e);}});

/* Settings */
app.post('/control/settings',(req,res)=>{try{const s=store.loadSession(activeSession(req));const timezone=String(req.body?.timezone||s.settings.timezone).trim();if(!store.validTimezone(timezone))throw new Error('المنطقة الزمنية غير صالحة.');s.settings={...s.settings,
  scheduleEnabled:store.toBool(req.body?.scheduleEnabled,s.settings.scheduleEnabled),timezone,
  scheduledGroupsEnabled:store.toBool(req.body?.scheduledGroupsEnabled,s.settings.scheduledGroupsEnabled),groupAssistantEnabled:store.toBool(req.body?.groupAssistantEnabled,s.settings.groupAssistantEnabled),automationEnabled:store.toBool(req.body?.automationEnabled,s.settings.automationEnabled),instantDuplicateGuard:store.toBool(req.body?.instantDuplicateGuard,s.settings.instantDuplicateGuard),instantCountTowardCycle:store.toBool(req.body?.instantCountTowardCycle,s.settings.instantCountTowardCycle),sendOrder:['target-first','image-first'].includes(req.body?.sendOrder)?req.body.sendOrder:s.settings.sendOrder,
  dayOfWeek:store.toInt(req.body?.dayOfWeek,s.settings.dayOfWeek,0,6),hour:store.toInt(req.body?.hour,s.settings.hour,0,23),minute:store.toInt(req.body?.minute,s.settings.minute,0,59),
  catchUpMinutes:store.toInt(req.body?.catchUpMinutes,s.settings.catchUpMinutes,0,120),retryAttempts:store.toInt(req.body?.retryAttempts,s.settings.retryAttempts,1,5),retryDelayMs:store.toInt(req.body?.retryDelayMs,s.settings.retryDelayMs,250,20000),sendDelayMs:store.toInt(req.body?.sendDelayMs,s.settings.sendDelayMs,0,15000),
  preText:String(req.body?.preText??s.settings.preText).trim(),postText:String(req.body?.postText??s.settings.postText).trim(),browserHeadless:store.toBool(req.body?.browserHeadless,s.settings.browserHeadless),autoReconnect:store.toBool(req.body?.autoReconnect,s.settings.autoReconnect),autoStartSession:store.toBool(req.body?.autoStartSession,s.settings.autoStartSession),
  backgroundMode:['aurora','grid','stars','particles','orbits','waves','matrix','nebula','meteor'].includes(req.body?.backgroundMode)?req.body.backgroundMode:s.settings.backgroundMode,
  backgroundOpacity:Math.max(0.05,Math.min(0.9,Number.isFinite(Number(req.body?.backgroundOpacity))?Number(req.body.backgroundOpacity):s.settings.backgroundOpacity)),
  backgroundSettings:store.normalizeBackgroundSettings(req.body?.backgroundMode || s.settings.backgroundMode, req.body?.backgroundSettings || s.settings.backgroundSettings),
  backgroundProfiles: req.body?.backgroundProfiles && typeof req.body.backgroundProfiles==='object' ? req.body.backgroundProfiles : s.settings.backgroundProfiles
};s.automation.enabled=s.settings.automationEnabled;s.interaction.enabled=s.settings.interactionEnabled;s.interaction.scope=s.settings.interactionScope;store.saveSession(s);scheduler.wake(s.id);scheduler.wakeAll();res.json({ok:true,settings:s.settings});}catch(e){replyError(res,400,e);}});

/* Background controls */
app.post('/control/background/settings',(req,res)=>{
  try {
    const id=activeSession(req), s=store.loadSession(id);
    const mode=String(req.body?.mode||s.settings.backgroundMode);
    if(!['aurora','grid','stars','particles','orbits','waves','matrix','nebula','meteor'].includes(mode)) throw new Error('وضع الخلفية غير صالح.');
    const opacity=Math.max(0.05,Math.min(0.9,Number.isFinite(Number(req.body?.opacity))?Number(req.body.opacity):s.settings.backgroundOpacity));
    s.settings.backgroundMode=mode;
    s.settings.backgroundOpacity=opacity;
    s.settings.backgroundProfiles=s.settings.backgroundProfiles && typeof s.settings.backgroundProfiles==='object' ? s.settings.backgroundProfiles : {};
    const incomingProfiles=req.body?.profiles && typeof req.body.profiles==='object' ? req.body.profiles : {};
    for(const profileMode of Object.keys(store.BACKGROUND_DEFAULTS)) s.settings.backgroundProfiles[profileMode]=store.normalizeBackgroundSettings(profileMode,incomingProfiles[profileMode] || s.settings.backgroundProfiles[profileMode]);
    const currentProfile=store.normalizeBackgroundSettings(mode, req.body?.settings || s.settings.backgroundProfiles[mode]);
    s.settings.backgroundProfiles[mode]=currentProfile;
    s.settings.backgroundSettings=currentProfile;
    store.saveSession(s);
    res.json({ok:true,background:{mode,opacity,settings:s.settings.backgroundSettings,profiles:s.settings.backgroundProfiles,imageName:s.settings.backgroundImage,imageUrl:s.settings.backgroundImage?`/background/${encodeURIComponent(s.settings.backgroundImage)}?sessionId=${encodeURIComponent(id)}&v=${encodeURIComponent(s.updatedAt)}`:null}});
  } catch(e){replyError(res,400,e);}
});
app.post('/control/background/upload',backgroundUpload.single('background'),(req,res)=>{
  try {
    const id=activeSession(req);
    if(!req.file) throw new Error('اختر صورة خلفية أولًا.');
    const targetName=media.importBackground(req.file.path,req.file.originalname,store.getPaths(id).backgrounds);
    const s=store.loadSession(id);
    s.settings.backgroundImage=targetName;
    store.saveSession(s);
    try{fs.unlinkSync(req.file.path);}catch{}
    res.json({ok:true,background:{mode:s.settings.backgroundMode,opacity:s.settings.backgroundOpacity,settings:s.settings.backgroundSettings,profiles:s.settings.backgroundProfiles,imageName:targetName,imageUrl:`/background/${encodeURIComponent(targetName)}?sessionId=${encodeURIComponent(id)}&v=${encodeURIComponent(Date.now())}`}});
  }catch(e){if(req.file?.path)try{fs.unlinkSync(req.file.path);}catch{} replyError(res,400,e);}
});
app.post('/control/background/remove',(req,res)=>{
  try{
    const id=activeSession(req),s=store.loadSession(id);
    if(s.settings.backgroundImage){try{fs.unlinkSync(media.safeBackgroundPath(store.getPaths(id).backgrounds,s.settings.backgroundImage));}catch{}}
    s.settings.backgroundImage=null;
    store.saveSession(s);
    res.json({ok:true});
  }catch(e){replyError(res,400,e);}
});
/* Downloads / backups */
app.get('/control/download/logs',(req,res)=>{try{const id=activeSession(req),file=store.getPaths(id).logFile;if(!fs.existsSync(file))fs.writeFileSync(file,'','utf8');res.download(file,`${id}-bot.log`);}catch(e){replyError(res,404,e);}});
app.get('/control/download/settings',(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id);res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${id}-settings.json"`);res.send(JSON.stringify({version:store.APP_VERSION,exportedAt:new Date().toISOString(),session:{id:s.id,name:s.name,settings:s.settings,recipients:s.recipients,groups:s.groups,interaction:s.interaction,automation:s.automation}},null,2));}catch(e){replyError(res,500,e);}});
app.post('/control/backup',(req,res)=>{try{const id=activeSession(req),s=store.loadSession(id),stamp=new Date().toISOString().replace(/[:.]/g,'-'),file=path.join(store.getPaths(id).backups,`backup-${stamp}.json`),scan=media.scanImages(store.getPaths(id).images,s.settings.maxImageSizeMB);fs.writeFileSync(file,JSON.stringify({version:store.APP_VERSION,exportedAt:new Date().toISOString(),session:s,images:scan.images.map(x=>({filename:x.filename,id:x.id,size:x.size,sequence:x.sequence}))},null,2),'utf8');s.lastBackup=new Date().toISOString();store.saveSession(s);res.download(file,path.basename(file));}catch(e){replyError(res,500,e);}});

app.use((err,_req,res,_next)=>{globalLog('ERROR',safeError(err));if(!res.headersSent){const status=err?.statusCode||err?.status||500;replyError(res,status,err);}});

const server=http.createServer(app);
let stopping=false;
async function shutdown(signal){if(stopping)return;stopping=true;globalLog('INFO',`إيقاف chat BOT (${signal})`);scheduler.stop();automation.stop();await whatsapp.stopAll();server.close(()=>process.exit(0));}
process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));process.on('unhandledRejection',e=>globalLog('ERROR',`Unhandled rejection: ${safeError(e)}`));

scheduler.start();
automation.start();
server.listen(PORT,HOST,()=>{
  globalLog('INFO',`chat BOT v${store.APP_VERSION} يعمل على http://${HOST}:${PORT}`);
  const activeId=store.activeSessionId();
  try { const s=store.loadSession(activeId); if(s.settings.autoStartSession && whatsapp.hasSavedAuth(activeId)) whatsapp.start(activeId).catch(e=>log(activeId,'WARN',`تعذر التشغيل التلقائي: ${safeError(e)}`)); }
  catch(e){ log(activeId,'ERROR',`تعذر فحص الجلسة: ${safeError(e)}`); }
});
