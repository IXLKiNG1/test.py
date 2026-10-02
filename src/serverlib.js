"use strict";
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {MIME,MEDIA_EXT,nextImageName,safePath}=require('./media');
function logFactory(store){return (id,level,message,extra=null)=>{const line=`[${new Date().toISOString()}] [${level}] ${message}${extra?` ${JSON.stringify(extra)}`:''}`;console.log(id?`[${id}] ${line}`:line);if(id&&store.listSessionIds().includes(store.safeSessionId(id))){const s=store.loadSession(id);s.logs=[...s.logs,{at:new Date().toISOString(),level,message,extra}].slice(-400);store.saveSession(s);try{fs.appendFileSync(store.getPaths(id).logFile,line+'\n','utf8')}catch{}}else{try{fs.appendFileSync(path.join(store.DATA_DIR,'system.log'),line+'\n','utf8')}catch{}}}}
function replyError(res,e,status=400){res.status(status).json({ok:false,error:String(e?.message||e||'خطأ غير معروف')})}
function randomId(){return crypto.randomUUID()}
module.exports={logFactory,replyError,randomId,MIME,MEDIA_EXT,nextImageName,safePath};
