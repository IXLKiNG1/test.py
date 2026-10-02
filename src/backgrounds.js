"use strict";
const MODES=new Set(['aurora','nebula','meteor','matrix','cyber-grid','plasma','starfield','vortex','galaxy','ocean']);
const DEFAULT={speed:1,density:1,glow:.6,intensity:1,interactive:true,trail:true};
function normalize(mode,settings,opacity){const m=MODES.has(mode)?mode:'aurora',s={...DEFAULT,...(settings||{})};for(const k of ['speed','density','glow','intensity'])if(!Number.isFinite(Number(s[k])))s[k]=DEFAULT[k];s.speed=Math.max(.1,Math.min(3,+s.speed));s.density=Math.max(.2,Math.min(2,+s.density));s.glow=Math.max(0,Math.min(1,+s.glow));s.intensity=Math.max(.2,Math.min(1.8,+s.intensity));return {mode:m,settings:s,opacity:Math.max(.05,Math.min(.75,Number(opacity)||.22))}}
module.exports={MODES,DEFAULT,normalize};
