'use strict';

const crypto = require('node:crypto');
const { scanImages, safeImagePath } = require('./media');
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function safeError(error) { return String(error?.message || error || 'خطأ غير معروف'); }
function renderTemplate(text, values) {
  return String(text || '')
    .replace(/\{\{recipient\}\}/gi, String(values.recipient || ''))
    .replace(/\{\{phone\}\}/gi, String(values.phone || ''))
    .replace(/\{\{image\}\}/gi, String(values.image || ''))
    .replace(/\{\{date\}\}/gi, String(values.date || ''))
    .replace(/\{\{time\}\}/gi, String(values.time || ''))
    .trim();
}
function hashText(value) { return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 16); }
function isPermanentDeliveryError(message) {
  const text = String(message || '').toLowerCase();
  return /الرقم .* غير مسجل|رقم .* غير صالح|المستلم غير موجود|الصورة غير موجودة|الصورة غير صالحة|لا توجد صور|نوع الملف غير مدعوم|حجم الملف أكبر|اختر|حدد مستلم|حدد صورة|not registered|invalid (?:phone|number|recipient)|file (?:not found|invalid)|unsupported|too large/.test(text);
}
function isUncertainDeliveryError(error) { return String(error?.code || '') === 'SEND_UNCERTAIN'; }
function assertConfirmed(result, label) {
  const ack = result?.__chatBotAck;
  if (ack?.status === 'error') throw Object.assign(new Error(`${label}: رفض WhatsApp الإرسال.`), { code:'SEND_ACK_ERROR' });
  if (ack?.status === 'pending') throw Object.assign(new Error(`${label}: تم إنشاء الرسالة لكن لم تصل حالة تأكيد من WhatsApp بعد. لم يتم اعتمادها كمرسلة لتجنب التكرار.`), { code:'SEND_UNCERTAIN' });
  return result;
}
function nowVars(recipient, image, timezone='Asia/Muscat') {
  return { recipient:recipient.name, phone:recipient.phone, image:image.filename,
    date:new Intl.DateTimeFormat('ar-OM',{timeZone:timezone,dateStyle:'short'}).format(new Date()),
    time:new Intl.DateTimeFormat('ar-OM',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}).format(new Date()) };
}
function stageKey(stage, text, image) {
  if (stage==='image') return `image:${image?.id || ''}:${image?.filename || ''}:${image?.size || ''}`;
  return `${stage}:${hashText(text || '')}`;
}

class DeliveryService {
  constructor({store,whatsapp,log}) { this.store=store; this.whatsapp=whatsapp; this.log=log; this.busy=new Set(); }
  session(id){ return this.store.loadSession(id); }
  paths(id){ return this.store.getPaths(id); }
  save(s){ return this.store.saveSession(s); }
  targetLists(s){
    const recipients=s.recipients.filter(r=>r.enabled!==false).map(r=>({...r,kind:'recipient',targetId:r.id}));
    const groups=(s.groups||[]).filter(g=>g.enabled!==false).map(g=>({...g,kind:'group',targetId:g.id,phone:'',country:null}));
    return {recipients,groups};
  }
  scheduledTargets(s){ const l=this.targetLists(s); return [...l.recipients,...(s.settings.scheduledGroupsEnabled?l.groups:[])]; }
  findImage(id,imageId){ return this.images(id).images.find(x=>x.id===String(imageId))||null; }
  images(id){ const s=this.session(id); return scanImages(this.paths(id).images,s.settings.maxImageSizeMB); }
  syncCycle(id){
    const s=this.session(id), scan=this.images(id), ids=scan.images.map(x=>x.id), old=Array.isArray(s.cycle.imageOrder)?s.cycle.imageOrder:[];
    const current=old[s.cycle.currentIndex]||null;
    if(JSON.stringify(ids)===JSON.stringify(old)) return s;
    s.cycle.imageOrder=ids;
    const next={};
    for(const imageId of ids) if(s.cycle.delivery?.[imageId]) next[imageId]=s.cycle.delivery[imageId];
    s.cycle.delivery=next;
    const guardNext={};
    for(const imageId of ids) if(s.cycle.manualGuard?.[imageId]) guardNext[imageId]=s.cycle.manualGuard[imageId];
    s.cycle.manualGuard=guardNext;
    if(!ids.length){ s.cycle.currentIndex=0; s.cycle.delivery={}; s.cycle.manualGuard={}; }
    else if(current && ids.includes(current)) s.cycle.currentIndex=ids.indexOf(current);
    else { s.cycle.currentIndex=Math.min(Number(s.cycle.currentIndex)||0,ids.length-1); }
    return this.save(s);
  }
  currentImage(id){ const s=this.syncCycle(id), scan=this.images(id); if(!scan.images.length)return null; const cid=s.cycle.imageOrder[s.cycle.currentIndex]; return scan.images.find(x=>x.id===cid)||scan.images[0]; }
  deliveryState(s,imageId,targetId){
    s.cycle.delivery=s.cycle.delivery||{}; s.cycle.delivery[imageId]=s.cycle.delivery[imageId]||{};
    const prev=s.cycle.delivery[imageId][targetId]||{};
    s.cycle.delivery[imageId][targetId]={pre:false,image:false,post:false,preKey:null,imageKey:null,postKey:null,lastError:null,round:s.cycle.round,...prev};
    return s.cycle.delivery[imageId][targetId];
  }
  stageDone(state,flag,key,legacyKey=null){ const stored=state[`${flag}Key`]; if(state[flag]!==true)return false; if(!stored)return true; const accepted=Array.isArray(key)?key:[key]; if(legacyKey)accepted.push(legacyKey); return accepted.includes(stored); }
  async retry(task,attempts,delay,label='العملية'){
    let last;
    for(let i=0;i<attempts;i+=1){ try{return await task();}catch(error){ last=error; if(isPermanentDeliveryError(error?.message)||isUncertainDeliveryError(error)||error?.code==='SEND_ACK_ERROR')throw error; if(i+1<attempts){this.log?.(null,'WARN',`${label}: المحاولة ${i+1} فشلت، ستتم إعادة المحاولة.`);await sleep(delay*(i+1));}}}
    throw last||new Error(`فشلت ${label}.`);
  }
  async sequence(id,target,image,{scheduled=true,preText,postText,countStats=true,countTowardCycle=scheduled,round=null}={}){
    const s=this.session(id), vars=nowVars(target,image,s.settings.timezone);
    const pre=renderTemplate(preText??s.settings.preText,vars), post=renderTemplate(postText??s.settings.postText,vars);
    const targetId=target.targetId||target.id;
    const state=countTowardCycle?this.deliveryState(s,image.id,targetId):{pre:false,image:false,post:false,preKey:null,imageKey:null,postKey:null,lastError:null,round:s.cycle.round};
    const preK=stageKey('pre',preText??s.settings.preText,image), preLegacyK=stageKey('pre',pre,image), imageK=stageKey('image','',image), postK=stageKey('post',postText??s.settings.postText,image), postLegacyK=stageKey('post',post,image);
    const chatId=await this.whatsapp.resolveChatId(id,target); const file=safeImagePath(this.paths(id).images,image.filename); const delay=Number(s.settings.sendDelayMs)||0;
    const persist=()=>{if(countStats||countTowardCycle)this.save(s)};
    const markError=error=>{state.lastError=safeError(error);state.round=round??s.cycle.round;persist()};
    try{
      if(pre&&!this.stageDone(state,'pre',preK,preLegacyK)){
        const sent=await this.retry(()=>this.whatsapp.sendText(id,chatId,pre),s.settings.retryAttempts,s.settings.retryDelayMs,'الرسالة قبل الصورة');
        assertConfirmed(sent,'الرسالة قبل الصورة'); state.pre=true;state.preKey=preK;state.lastError=null;
        if(countStats)s.stats.sentMessages+=1;if(sent?.__chatBotAck?.status==='confirmed')s.stats.confirmedAcks+=1;persist();if(delay)await sleep(delay);
      }
      if(!this.stageDone(state,'image',imageK)){
        const sent=await this.retry(()=>this.whatsapp.sendMedia(id,chatId,file),s.settings.retryAttempts,s.settings.retryDelayMs,'الصورة');
        assertConfirmed(sent,'الصورة');state.image=true;state.imageKey=imageK;state.lastError=null;
        if(countStats)s.stats.sentImages+=1;if(sent?.__chatBotAck?.status==='confirmed')s.stats.confirmedAcks+=1;persist();if(delay)await sleep(delay);
      }
      if(post&&!this.stageDone(state,'post',postK,postLegacyK)){
        const sent=await this.retry(()=>this.whatsapp.sendText(id,chatId,post),s.settings.retryAttempts,s.settings.retryDelayMs,'الرسالة بعد الصورة');
        assertConfirmed(sent,'الرسالة بعد الصورة');state.post=true;state.postKey=postK;state.lastError=null;
        if(countStats)s.stats.sentMessages+=1;if(sent?.__chatBotAck?.status==='confirmed')s.stats.confirmedAcks+=1;persist();
      }
      return {...state,targetId,chatId};
    }catch(error){ if(error?.code==='SEND_UNCERTAIN')s.stats.uncertainSends=(s.stats.uncertainSends||0)+1; markError(error); throw error; }
  }
  allComplete(s,image){
    const targets=this.scheduledTargets(s); if(!targets.length)return false;
    return targets.every(t=>{
      const d=s.cycle.delivery?.[image.id]?.[t.targetId||t.id]||{};
      const vars=nowVars(t,image,s.settings.timezone);
      const pre=renderTemplate(s.settings.preText,vars),post=renderTemplate(s.settings.postText,vars);
      return this.stageDone(d,'image',stageKey('image','',image)) && (!pre || this.stageDone(d,'pre',stageKey('pre',s.settings.preText,image),stageKey('pre',pre,image))) && (!post || this.stageDone(d,'post',stageKey('post',s.settings.postText,image),stageKey('post',post,image)));
    });
  }
  startNewRound(s){ s.cycle.round=(Number(s.cycle.round)||1)+1; s.cycle.roundStartedAt=new Date().toISOString(); s.cycle.currentIndex=0; s.cycle.delivery={}; s.cycle.manualGuard={}; }
  advanceIfComplete(id){
    let s=this.syncCycle(id), image=this.currentImage(id); if(!image||!this.allComplete(s,image))return false;
    const count=s.cycle.imageOrder.length;
    if(s.cycle.currentIndex>=count-1){ this.startNewRound(s); this.save(s); this.log(id,'INFO',`اكتملت دورة الصور رقم ${(s.cycle.round||2)-1} وبدأت دورة جديدة رقم ${s.cycle.round}.`); return true; }
    s.cycle.currentIndex+=1; this.save(s); this.log(id,'INFO','اكتملت الصورة الحالية وانتقل البوت للصورة التالية.'); return true;
  }
  async scheduledRun(id){
    const safe=this.store.safeSessionId(id); if(this.busy.has(`send:${safe}`))return{ok:false,message:'يوجد إرسال آخر قيد التنفيذ لهذه الجلسة.'}; this.busy.add(`send:${safe}`);
    try{
      let s=this.syncCycle(safe); this.advanceIfComplete(safe); s=this.session(safe); const image=this.currentImage(safe),targets=this.scheduledTargets(s);
      if(!targets.length)return{ok:false,retry:false,message:'لا يوجد مستلمون أو مجموعات مفعّلة.'}; if(!image)return{ok:false,retry:false,message:'لا توجد صور في هذه الجلسة.'};
      try{await this.whatsapp.ensureReady(safe);}catch(error){const runtime=this.whatsapp.listRuntime(safe);const canRetry=this.whatsapp.hasSavedAuth(safe)&&!['logged_out','auth_failure','qr'].includes(runtime.status);return{ok:false,retry:canRetry,message:safeError(error)}}
      const sent=[],failed=[];
      for(const target of targets){try{await this.sequence(safe,target,image,{scheduled:true});sent.push({target:target.name,targetId:target.targetId,kind:target.kind,image:image.filename})}catch(error){const cur=this.session(safe),d=cur.cycle.delivery?.[image.id]?.[target.targetId||target.id];failed.push({target:target.name,targetId:target.targetId,kind:target.kind,error:safeError(error),code:error?.code||null,progress:d||null});cur.stats.failedSends+=1;this.save(cur)}}
      const cur=this.session(safe);const complete=this.allComplete(cur,image);if(complete)this.advanceIfComplete(safe);const after=this.session(safe);
      after.lastRun={at:new Date().toISOString(),type:'scheduled',round:after.cycle.round, image:image.filename,sent,failed,complete}; if(complete)after.stats.successfulRuns+=1;else after.stats.failedRuns+=1;this.save(after);
      return{ok:failed.length===0,retry:failed.length>0,sent,failed,image:image.filename,round:after.cycle.round,complete,message:failed.length?'لم تكتمل كل أهداف الإرسال لهذه الصورة.':'تم تنفيذ الإرسال.'};
    }finally{this.busy.delete(`send:${safe}`)}
  }
  async runAutomation(id,task){
    const safe=this.store.safeSessionId(id); if(this.busy.has(`send:${safe}`))return{ok:false,sent:[],failed:[],message:'يوجد إرسال آخر قيد التنفيذ لهذه الجلسة.'};this.busy.add(`send:${safe}`);
    try{const s=this.session(safe);const recipients=s.recipients.filter(r=>r.enabled!==false&&task.targets.recipientIds.includes(r.id)).map(r=>({...r,kind:'recipient',targetId:r.id}));const groups=(s.groups||[]).filter(g=>g.enabled!==false&&task.targets.groupIds.includes(g.id)).map(g=>({...g,kind:'group',targetId:g.id,phone:'',country:null}));const targets=[...recipients,...groups];if(!targets.length)return{ok:false,sent:[],failed:[],message:'المهمة لا تحتوي على أهداف صالحة.'};await this.whatsapp.ensureReady(safe);const sent=[],failed=[];for(const target of targets){try{const chatId=await this.whatsapp.resolveChatId(safe,target);const vars=nowVars(target,{filename:''},s.settings.timezone);if(task.kind==='text'){const txt=renderTemplate(task.messageText,vars);if(!txt)throw new Error('نص المهمة فارغ.');const r=await this.whatsapp.sendText(safe,chatId,txt,{observeAck:true});assertConfirmed(r,'الرسالة المجدولة')}else{const image=this.findImage(safe,task.imageId);if(!image)throw new Error('الصورة المحددة للمهمة غير موجودة.');const taskPost=task.kind==='image'?(task.postText||task.messageText):task.postText;await this.sequence(safe,target,image,{scheduled:false,preText:task.kind==='sequence'?task.preText:'',postText:taskPost,countStats:true,countTowardCycle:false})}sent.push({target:target.name,gid:target.gid||null})}catch(error){failed.push({target:target.name,error:safeError(error),code:String(error?.code||'')||null})} }return{ok:failed.length===0,sent,failed,message:failed.length?'لم تكتمل كل أهداف المهمة.':'تم تنفيذ المهمة.'};}
    finally{this.busy.delete(`send:${safe}`)}
  }
  async preflightTargets(id,targets){const checked=[],failed=[];for(const target of targets){try{const chatId=await this.whatsapp.resolveChatId(id,target);checked.push({target,chatId})}catch(error){failed.push({targetId:target.targetId||target.id,target:target.name,kind:target.kind,error:safeError(error)})}}return{checked,failed}}
  async preflightSelection(id,{recipientIds=[],groupIds=[],imageIds=[],preText,postText,duplicateGuard,countTowardCycle}={}){const safe=this.store.safeSessionId(id),s=this.syncCycle(safe),recSet=new Set(recipientIds.map(String)),groupSet=new Set(groupIds.map(String)),imageSet=new Set(imageIds.map(String));const recipients=s.recipients.filter(r=>r.enabled!==false&&recSet.has(r.id)).map(r=>({...r,kind:'recipient',targetId:r.id}));const groups=(s.groups||[]).filter(g=>g.enabled!==false&&groupSet.has(g.id)).map(g=>({...g,kind:'group',targetId:g.id,phone:'',country:null}));const targets=[...recipients,...groups],images=this.images(safe).images.filter(x=>imageSet.has(x.id));if(!targets.length)throw new Error('حدد مستلمًا أو مجموعة واحدة على الأقل.');if(!images.length)throw new Error('حدد صورة واحدة على الأقل.');const limit=s.settings.maxInstantPairs,operations=targets.length*images.length;if(operations>limit)throw new Error(`عدد عمليات الإرسال كبير جدًا. الحد الحالي ${limit} عملية.`);const guard=duplicateGuard??s.settings.instantDuplicateGuard,count=Boolean(countTowardCycle??s.settings.instantCountTowardCycle);const targetCheck=await this.preflightTargets(safe,targets);let skipped=0;for(const t of targets)for(const img of images){const d=s.cycle.delivery?.[img.id]?.[t.targetId]||{};const cycleDone=this.stageDone(d,'image',stageKey('image','',img));const manualDone=Boolean(s.cycle.manualGuard?.[img.id]?.[t.targetId]);if(guard&&((count&&cycleDone)||(!count&&manualDone)))skipped++;}return{ok:targetCheck.failed.length===0,operationCount:operations,sendableOperations:operations-skipped,skippedDuplicates:skipped,duplicateGuard:guard,countTowardCycle:count,limit,targets:{total:targets.length,checked:targetCheck.checked.length,failed:targetCheck.failed.length},targetFailures:targetCheck.failed,images:images.map(x=>({id:x.id,filename:x.filename,size:x.size})),messages:{pre:Boolean(String(preText??s.settings.preText??'').trim()),post:Boolean(String(postText??s.settings.postText??'').trim())},ready:this.whatsapp.isReady(safe),round:s.cycle.round};}
  async instantSend(id,{recipientIds=[],groupIds=[],imageIds=[],preText,postText,duplicateGuard,countTowardCycle,sendOrder}={}){
    const safe=this.store.safeSessionId(id);if(this.busy.has(`send:${safe}`))throw new Error('يوجد إرسال آخر قيد التنفيذ لهذه الجلسة.');this.busy.add(`send:${safe}`);const startedAt=Date.now();
    try{const s=this.syncCycle(safe);await this.whatsapp.ensureReady(safe);const recSet=new Set(recipientIds.map(String)),groupSet=new Set(groupIds.map(String)),imageSet=new Set(imageIds.map(String));const recipients=s.recipients.filter(r=>r.enabled!==false&&recSet.has(r.id)).map(r=>({...r,kind:'recipient',targetId:r.id}));const groups=(s.groups||[]).filter(g=>g.enabled!==false&&groupSet.has(g.id)).map(g=>({...g,kind:'group',targetId:g.id,phone:'',country:null}));const targets=[...recipients,...groups],images=this.images(safe).images.filter(x=>imageSet.has(x.id));if(!targets.length)throw new Error('حدد مستلمًا أو مجموعة واحدة على الأقل.');if(!images.length)throw new Error('حدد صورة واحدة على الأقل.');const operations=targets.length*images.length;if(operations>s.settings.maxInstantPairs)throw new Error(`عدد عمليات الإرسال كبير جدًا. الحد الحالي ${s.settings.maxInstantPairs} عملية.`);const guard=duplicateGuard??s.settings.instantDuplicateGuard,count=Boolean(countTowardCycle??s.settings.instantCountTowardCycle),order=sendOrder||s.settings.sendOrder||'target-first';const preflight=await this.preflightTargets(safe,targets),sent=[],failed=[],skipped=[];for(const f of preflight.failed)for(const image of images)failed.push({target:f.target,image:image.filename,error:f.error,code:'PREFLIGHT_FAILED'});const valid=new Map(preflight.checked.map(x=>[x.target.targetId,x]));const doOne=async(target,image)=>{const latestBefore=this.session(safe),d=latestBefore.cycle.delivery?.[image.id]?.[target.targetId]||{};const cycleDone=this.stageDone(d,'image',stageKey('image','',image));const manualDone=Boolean(latestBefore.cycle.manualGuard?.[image.id]?.[target.targetId]);if(guard&&((count&&cycleDone)||(!count&&manualDone))){skipped.push({target:target.name,targetId:target.targetId,image:image.filename,reason:'duplicate_guard'});latestBefore.stats.skippedDuplicates=(latestBefore.stats.skippedDuplicates||0)+1;this.save(latestBefore);return;}try{const result=await this.sequence(safe,target,image,{scheduled:false,preText,postText,countStats:true,countTowardCycle:count});if(!count){const latest=this.session(safe);latest.cycle.manualGuard=latest.cycle.manualGuard||{};latest.cycle.manualGuard[image.id]=latest.cycle.manualGuard[image.id]||{};latest.cycle.manualGuard[image.id][target.targetId]=true;this.save(latest);}sent.push({target:target.name,targetId:target.targetId,kind:target.kind,image:image.filename,chatId:result.chatId});}catch(error){failed.push({target:target.name,targetId:target.targetId,kind:target.kind,image:image.filename,error:safeError(error),code:String(error?.code||'')||null});this.log(safe,'ERROR',`فشل الإرسال ${image.filename} إلى ${target.name}: ${safeError(error)}`)}};
      if(order==='image-first')for(const image of images)for(const target of targets)if(valid.has(target.targetId))await doOne(target,image);else{}else for(const target of targets)for(const image of images)if(valid.has(target.targetId))await doOne(target,image);
      const cur=this.session(safe);cur.lastRun={at:new Date().toISOString(),type:'instant',durationMs:Date.now()-startedAt,operationCount:operations,sendableOperations:operations-skipped.length,sent,failed,skipped,round:cur.cycle.round};this.save(cur);return{ok:failed.length===0,sent,failed,skipped,operationCount:operations,sendableOperations:operations-skipped.length,durationMs:Date.now()-startedAt,targetFailures:preflight.failed,round:cur.cycle.round};
    }finally{this.busy.delete(`send:${safe}`)}
  }
  async testRecipient(id,recipientId){return this._test(id,'recipient',recipientId)}
  async testGroup(id,groupId){return this._test(id,'group',groupId)}
  async _test(id,kind,objectId){const safe=this.store.safeSessionId(id);if(this.busy.has(`send:${safe}`))throw new Error('يوجد إرسال آخر قيد التنفيذ لهذه الجلسة.');this.busy.add(`send:${safe}`);try{const s=this.session(safe),item=(kind==='group'?s.groups:s.recipients).find(x=>x.id===objectId),image=this.currentImage(safe);if(!item)throw new Error(kind==='group'?'المجموعة غير موجودة.':'المستلم غير موجود.');if(!image)throw new Error('لا توجد صورة للاختبار.');if(!this.whatsapp.isReady(safe))throw new Error('الجلسة غير متصلة.');const target=kind==='group'?{...item,kind:'group',targetId:item.id}:{...item,kind:'recipient',targetId:item.id};await this.sequence(safe,target,image,{scheduled:false,preText:kind==='group'?'chat BOT — اختبار المجموعة':'chat BOT — اختبار',postText:'',countStats:false,countTowardCycle:false});return{ok:true,[kind]:item.name,image:image.filename};}finally{this.busy.delete(`send:${safe}`)}}
  skip(id){const s=this.syncCycle(id),count=s.cycle.imageOrder.length;if(!count)throw new Error('لا توجد صور.');if(s.cycle.currentIndex>=count-1){this.startNewRound(s)}else s.cycle.currentIndex+=1;this.save(s);return this.currentImage(id)}
  reset(id){const s=this.session(id);s.cycle.currentIndex=0;this.save(s);return this.currentImage(id)}
}
module.exports={DeliveryService,renderTemplate,stageKey};
