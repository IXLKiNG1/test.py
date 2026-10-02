"use strict";
const {Client,LocalAuth,MessageMedia}=require('whatsapp-web.js');
const EventEmitter=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const {patch}=require('./compat');
patch();

function safeError(e){return String(e?.message||e||'خطأ غير معروف')}
function withTimeout(p,ms,label){let timer;const timeout=new Promise((_,rej)=>{timer=setTimeout(()=>rej(Object.assign(new Error(`${label||'العملية'} تجاوزت المهلة.`),{code:'SEND_TIMEOUT'})),Math.max(1,Number(ms)||30000));});return Promise.race([Promise.resolve(p),timeout]).finally(()=>clearTimeout(timer));}
function idSerialized(id){if(!id)return '';if(typeof id==='string')return id;if(id._serialized)return String(id._serialized);if(id.$1)return String(id.$1);if(id.remote&&id.id!==undefined)return `${Boolean(id.fromMe)}_${id.remote}_${id.id}`;return String(id.id||'')}
function remoteId(id){if(!id)return '';if(typeof id==='string')return id;if(typeof id.remote==='string')return id.remote;if(id.remote?._serialized)return String(id.remote._serialized);if(id.remote?.$1)return String(id.remote.$1);return ''}
function normalizeChatId(value){if(value&&typeof value==='object'){if(value._serialized)return String(value._serialized).trim().toLowerCase();if(value.$1)return String(value.$1).trim().toLowerCase();if(value.remote)return normalizeChatId(value.remote)}return String(value||'').trim().toLowerCase()}
function groupFromMessage(msg){const candidates=[msg?.from,msg?.to,msg?.chatId,msg?.id?.remote,msg?.msgId?.remote,msg?._data?.id?.remote,msg?._data?.chatId,msg?._data?.id?._serialized,msg?._data?.id?.$1];for(const value of candidates){const id=normalizeChatId(value);if(id.endsWith('@g.us'))return id;}return null}

class WhatsAppManager extends EventEmitter{
  constructor({store,log}){super();this.store=store;this.log=log;this.clients=new Map();}
  entry(id){
    const sid=this.store.safeSessionId(id);
    if(!this.clients.has(sid))this.clients.set(sid,{client:null,status:'idle',ready:false,qr:null,browser:'',info:null,lastAck:null,lastSent:null,starting:null,liveGroups:new Map(),stopping:false,reconnectTimer:null,reconnects:0,generation:0});
    return this.clients.get(sid);
  }
  hasSavedAuth(id){
    const sid=this.store.safeSessionId(id),p=this.store.getPaths(sid);
    return fs.existsSync(path.join(p.auth,`session-${sid}`));
  }
  async start(id){
    const sid=this.store.safeSessionId(id),e=this.entry(sid);
    e.stopping=false;
    if(e.ready&&e.client)return this.listRuntime(sid);
    if(e.starting)return e.starting;
    if(e.client){try{await e.client.destroy()}catch{}e.client=null;}
    const generation=++e.generation;
    e.status='starting';e.qr=null;
    e.starting=(async()=>{
      const p=this.store.getPaths(sid);fs.mkdirSync(p.auth,{recursive:true});
      const sessionSettings=this.store.loadSession(sid).settings||{};
      const headless=sessionSettings.browserHeadless!==false && String(process.env.HEADLESS||'true')!=='false';
      const client=new Client({
        authStrategy:new LocalAuth({clientId:sid,dataPath:p.auth}),
        puppeteer:{headless,executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}
      });
      e.client=client;
      client.on('qr',async qr=>{if(generation!==e.generation)return;e.qr=qr;e.status='qr';try{const QR=require('qrcode');e.qr=await QR.toDataURL(qr,{margin:1,width:260});}catch{}this.emit('status',sid,this.listRuntime(sid));});
      client.on('authenticated',()=>{if(generation!==e.generation)return;e.status='authenticated';e.qr=null;this.emit('status',sid,this.listRuntime(sid));});
      client.on('ready',()=>{
        if(generation!==e.generation)return;
        e.ready=true;e.status='ready';e.qr=null;e.browser='Chromium/Puppeteer';e.info=client.info||null;e.reconnects=0;
        this.log(sid,'INFO','جلسة WhatsApp جاهزة للإرسال والاستقبال.');
        this.emit('status',sid,this.listRuntime(sid));
        this.listGroups(sid).catch(err=>this.log(sid,'WARN',`تعذر مزامنة المجموعات تلقائيًا: ${safeError(err)}`));
      });
      client.on('auth_failure',msg=>{if(generation!==e.generation)return;e.ready=false;e.status='auth_failure';this.log(sid,'ERROR',`فشل توثيق WhatsApp: ${msg||'غير معروف'}`);this.emit('status',sid,this.listRuntime(sid));});
      client.on('disconnected',reason=>{
        if(generation!==e.generation)return;
        e.ready=false;e.status='disconnected';e.client=null;this.log(sid,'WARN',`انفصلت جلسة WhatsApp: ${reason||'غير معروف'}`);this.emit('status',sid,this.listRuntime(sid));
        if(!e.stopping&&this.hasSavedAuth(sid)&&e.reconnects<5){const wait=[2500,5000,10000,20000,30000][Math.min(e.reconnects,4)];e.reconnects++;clearTimeout(e.reconnectTimer);e.reconnectTimer=setTimeout(()=>{if(generation!==e.generation||e.stopping)return;this.start(sid).catch(err=>this.log(sid,'ERROR',`فشل إعادة الاتصال: ${safeError(err)}`));},wait)}
      });
      client.on('message',msg=>{
        const gid=groupFromMessage(msg);
        if(gid){
          const fallback={gid,name:String(msg?._data?.chat?.subject||msg?._data?.chat?.name||msg?.chat?.name||msg?._data?.notifyName||gid)};
          const remember=info=>{const clean=this.store.normalizeGroup({...fallback,...(info||{}),gid});const runtime=this.entry(sid);runtime.liveGroups.set(gid,clean);try{const sess=this.store.loadSession(sid),idx=sess.groups.findIndex(g=>String(g.gid||'').toLowerCase()===gid);if(idx<0){sess.groups.push(clean);this.store.saveSession(sess);this.log(sid,'INFO',`تم اكتشاف مجموعة جديدة تلقائيًا: ${clean.name}`);}else{const current=sess.groups[idx];const merged=this.store.normalizeGroup({...current,...clean,enabled:current.enabled});sess.groups[idx]=merged;this.store.saveSession(sess);}}catch(err){this.log(sid,'WARN',`تعذر حفظ المجموعة المكتشفة: ${safeError(err)}`)}};
          remember();
          Promise.resolve().then(()=>msg.getChat?.()).then(chat=>chat?this.groupInfoFromChat(chat,{withInvite:true}):null).then(info=>{if(info)remember(info)}).catch(()=>{});
        }
        this.emit('message',sid,msg);
      });
      client.on('message_ack',(msg,ack)=>{e.lastAck={at:new Date().toISOString(),id:idSerialized(msg?.id||msg),ack};this.emit('ack',sid,e.lastAck);});
      client.on('message_create',msg=>{if(msg?.fromMe)this.emit('message_create',sid,msg);});
      client.on('message_reaction',reaction=>{
        const normalized={...reaction,chatId:String(reaction?.chatId||reaction?.id?.remote||reaction?.msgId?.remote||remoteId(reaction?.id)||remoteId(reaction?.msgId)||'').trim(),emoji:String(reaction?.reaction||reaction?.emoji||reaction?.value||''),msgId:reaction?.msgId||reaction?.messageId||reaction?.id||null,senderId:String(reaction?.senderId||'')};
        this.emit('reaction',sid,normalized);
      });
      await client.initialize();
      return this.listRuntime(sid);
    })().catch(async err=>{
      if(generation===e.generation&&e.client===client){try{await client.destroy()}catch{}e.client=null;}
      e.status='error';e.ready=false;this.log(sid,'ERROR',`فشل تشغيل الجلسة: ${safeError(err)}`);throw err;
    }).finally(()=>{e.starting=null;});
    return e.starting;
  }
  async ensureReady(id){const e=this.entry(id);if(e.ready&&e.client)return e.client;await this.start(id);const after=this.entry(id);if(!after.ready)throw new Error(`جلسة WhatsApp ليست جاهزة. الحالة: ${after.status}`);return after.client}
  async stop(id,{clearAuth=false}={}){
    const sid=this.store.safeSessionId(id),e=this.entry(sid);e.stopping=true;++e.generation;clearTimeout(e.reconnectTimer);
    if(e.client){try{await withTimeout(e.client.destroy(),10000,'إيقاف الجلسة')}catch{}}
    e.client=null;e.ready=false;e.qr=null;e.status='stopped';
    if(clearAuth){try{fs.rmSync(this.store.getPaths(sid).auth,{recursive:true,force:true})}catch{}}
    e.stopping=false;e.reconnects=0;this.emit('status',sid,this.listRuntime(sid));
  }
  listRuntime(id){const e=this.entry(id);return{status:e.status,ready:e.ready,qr:e.qr,browser:e.browser,info:e.info,lastAck:e.lastAck,lastSent:e.lastSent,reconnects:e.reconnects||0,liveGroups:[...e.liveGroups.values()]};}

  async resolveChatId(id,target){
    const sid=this.store.safeSessionId(id),client=await this.ensureReady(sid);
    if(target?.kind==='group'||String(target?.gid||'').toLowerCase().endsWith('@g.us')){
      const gid=String(target?.gid||'').trim().toLowerCase();
      if(!/^\d+(?:-\d+)*@g\.us$/.test(gid))throw new Error('معرف المجموعة غير صالح.');
      try{const chat=await withTimeout(client.getChatById(gid),12000,'الوصول إلى المجموعة');if(chat?.isGroup||String(chat?.id?._serialized||chat?.id||'').endsWith('@g.us'))return String(chat.id?._serialized||chat.id||gid).toLowerCase();}catch{}
      return gid;
    }
    const phone=String(target?.phone||'').replace(/\D/g,'');if(!phone)throw new Error('رقم المستلم مفقود.');
    const n=await withTimeout(client.getNumberId(phone),15000,'التحقق من الرقم');
    if(!n)throw new Error(`الرقم ${phone} غير مسجل على WhatsApp.`);
    return n._serialized||n;
  }
  async sendText(id,chatId,text,{timeoutMs=30000}={}){const client=await this.ensureReady(id);const content=String(text||'').trim();if(!content)throw new Error('النص فارغ.');const result=await withTimeout(client.sendMessage(chatId,content),timeoutMs,'إرسال النص');this.entry(id).lastSent={at:new Date().toISOString(),chatId,kind:'text'};return{result,__chatBotAck:{status:'confirmed',mode:'text'}}}
  async sendMedia(id,chatId,file,{timeoutMs=30000}={}){
    const client=await this.ensureReady(id),media=MessageMedia.fromFilePath(file);
    try{
      const result=await withTimeout(client.sendMessage(chatId,media,{sendMediaAsDocument:false}),timeoutMs,'إرسال الوسائط');
      this.entry(id).lastSent={at:new Date().toISOString(),chatId,kind:'media'};return{result,__chatBotAck:{status:'confirmed',mode:'media'}};
    }catch(err){
      const msg=safeError(err);
      if(/OpaqueData|memoize|getter must include an id/i.test(msg)){
        try{const fallback=await withTimeout(client.sendMessage(chatId,media,{sendMediaAsDocument:true}),timeoutMs,'إرسال الوسائط كملف');this.entry(id).lastSent={at:new Date().toISOString(),chatId,kind:'media-document-fallback'};return{result:fallback,__chatBotAck:{status:'confirmed',mode:'document-fallback'}};}catch(fallbackError){err=fallbackError;}
      }
      if(err.code==='SEND_TIMEOUT')throw Object.assign(new Error('انتهت مهلة إرسال الوسائط ولم نتأكد من النتيجة؛ لن نعيد الإرسال تلقائيًا حتى لا يتكرر.'),{code:'SEND_UNCERTAIN'});
      throw err;
    }
  }
  async replyToMessage(id,message,text){
    const client=await this.ensureReady(id),content=String(text||'').trim();if(!content)return null;
    try{
      if(typeof message?.reply==='function'){const r=await withTimeout(message.reply(content),30000,'الرد');return{result:r,__chatBotAck:{status:'confirmed',mode:'reply'}};}
      const chatId=String(message?.from||message?.to||message?.chatId||'');if(!chatId)throw new Error('تعذر تحديد المحادثة للرد.');
      return this.sendText(id,chatId,content);
    }catch(err){if(err.code==='SEND_TIMEOUT')throw Object.assign(new Error('انتهت مهلة الرد ولم نتأكد من النتيجة.'),{code:'SEND_UNCERTAIN'});throw err;}
  }
  async reactToMessage(id,messageId,emoji){
    const client=await this.ensureReady(id),mid=idSerialized(messageId);if(!mid)throw new Error('معرف الرسالة غير متاح للـReaction.');
    try{
      if(typeof client.sendReaction==='function'){await withTimeout(client.sendReaction(mid,String(emoji||'👍')),15000,'إرسال Reaction');}
      else {const m=await withTimeout(client.getMessageById(mid),12000,'الوصول إلى الرسالة');if(!m?.react)throw new Error('Reaction غير متاح في إصدار WhatsApp الحالي.');await withTimeout(m.react(String(emoji||'👍')),15000,'إرسال Reaction');}
      return{__chatBotAck:{status:'confirmed',mode:'reaction'}};
    }catch(e){throw new Error(`تعذر إرسال Reaction: ${safeError(e)}`)}
  }
  async groupInfoFromChat(chat,{withInvite=false}={}){
    let inviteCode='';if(withInvite){try{if(typeof chat?.getInviteCode==='function')inviteCode=await withTimeout(chat.getInviteCode(),7000,'قراءة رابط المجموعة')}catch{}}
    const gid=normalizeChatId(chat?.id?._serialized||chat?.id||'');
    const participants=Array.isArray(chat?.participants)?chat.participants:Array.isArray(chat?.groupMetadata?.participants)?chat.groupMetadata.participants:[];
    const owner=chat?.owner?._serialized||chat?.owner||chat?.groupMetadata?.owner?._serialized||chat?.groupMetadata?.owner?.$1||chat?.groupMetadata?.owner||'';
    return{gid,name:String(chat?.name||chat?.subject||chat?.groupMetadata?.subject||'مجموعة'),description:String(chat?.description||chat?.groupMetadata?.desc||''),owner:String(owner||''),participantsCount:participants.length||null,inviteCode:String(inviteCode||'')};
  }
  async listGroups(id){
    const sid=this.store.safeSessionId(id),client=await this.ensureReady(sid),e=this.entry(sid),outMap=new Map();
    const add=info=>{if(!info?.gid||!info.gid.endsWith('@g.us'))return;e.liveGroups.set(info.gid,info);outMap.set(info.gid,info);};
    try{
      const chats=await withTimeout(client.getChats(),30000,'قراءة محادثات WhatsApp');
      for(const chat of chats){const rawId=normalizeChatId(chat?.id?._serialized||chat?.id||'');if(!rawId.endsWith('@g.us')&&!chat?.isGroup&&chat?.type!=='group')continue;try{add(await this.groupInfoFromChat(chat));}catch{add({gid:rawId,name:String(chat?.name||chat?.subject||rawId),description:'',owner:'',participantsCount:Array.isArray(chat?.participants)?chat.participants.length:null,inviteCode:''});}}
    }catch(error){this.log(sid,'WARN',`تعذر قراءة قائمة المجموعات كاملة: ${safeError(error)}`);}
    for(const info of e.liveGroups.values())add(info);
    const saved=this.store.loadSession(sid).groups;
    for(const g of saved){const gid=normalizeChatId(g.gid);if(gid&&!outMap.has(gid))outMap.set(gid,{name:g.name,gid,description:g.description,owner:g.owner,participantsCount:g.participantsCount,inviteCode:g.inviteCode});}
    return[...outMap.values()];
  }
  async getGroupInfo(id,gid){
    const client=await this.ensureReady(id),want=normalizeChatId(gid);if(!/^\d+(?:-\d+)*@g\.us$/.test(want))throw new Error('معرف المجموعة غير صالح.');
    try{const chat=await withTimeout(client.getChatById(want),15000,'الوصول إلى المجموعة');if(chat)return this.groupInfoFromChat(chat,{withInvite:true});}catch{}
    try{const chats=await withTimeout(client.getChats(),25000,'البحث عن المجموعة');const chat=chats.find(c=>normalizeChatId(c?.id?._serialized||c?.id||'')===want);if(chat)return this.groupInfoFromChat(chat,{withInvite:true});}catch{}
    const live=this.entry(id).liveGroups.get(want);if(live)return live;
    const saved=this.store.loadSession(id).groups.find(x=>normalizeChatId(x.gid)===want);if(saved)return saved;
    throw new Error('لم أستطع الوصول إلى هذه المجموعة داخل الجلسة الحالية. افتح المجموعة أو أرسل منها رسالة ثم أعد المحاولة.');
  }
  async analyzeGroupInvite(id,code){const client=await this.ensureReady(id),c=String(code||'').trim();if(!c)throw new Error('رمز الدعوة مفقود.');if(typeof client.getInviteInfo!=='function')throw new Error('إصدار whatsapp-web.js الحالي لا يوفّر تحليل الدعوة بهذه الطريقة.');const info=await withTimeout(client.getInviteInfo(c),20000,'تحليل الدعوة');return{gid:String(info?.id?._serialized||info?.id||''),name:String(info?.subject||info?.name||'مجموعة عبر دعوة'),description:String(info?.description||''),participantsCount:Number.isFinite(Number(info?.size))?Number(info.size):null,inviteCode:c,raw:info};}
  async getGroupMessageContext(msg){const chatId=groupFromMessage(msg)||String(msg?.from||msg?.to||'');let chat=null;try{chat=await msg.getChat()}catch{}return{chatId,chat,group:Boolean(groupFromMessage(msg)),gid:groupFromMessage(msg),sender:String(msg?.notifyName||msg?._data?.notifyName||msg?._data?.author||'صديق')};}
  async getGroupInfoFromMessage(id,msg){const ctx=await this.getGroupMessageContext(msg);if(!ctx.group||!ctx.chat)throw new Error('الرسالة الحالية ليست من مجموعة يمكن قراءة معلوماتها.');return this.groupInfoFromChat(ctx.chat,{withInvite:true})}
}
module.exports={WhatsAppManager,safeError,idSerialized,groupFromMessage,remoteId};
