// Synthetic sizing only; no Desktop API or files created.
'use strict';const assert=require('assert/strict'),crypto=require('crypto');const sha=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');const ascii=s=>s.replace(/[^\x00-\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const icons=Array.from({length:202},(_,n)=>({identity:'PIDL-'+n+'-'+('ab'.repeat(2048)),x:n%20*78,y:Math.floor(n/20)*98}));
// Canonical serialization stands in for the Shell's full stable PIDL/coordinate key.
const canonical=JSON.stringify(icons),geometry=JSON.stringify({width:3840,height:2160,scale:150}),binding={token:'a'.repeat(32),probeId:'C:\\Users\\fixture\\Desktop\\証拠 日本語.txt',geometryKey:sha(geometry),iconsKey:sha(canonical)};
const samples=Array.from({length:44},(_,id)=>({...binding,id,axis:id<22?'x':'y',pass:id%22<12?'candidate':id%22<17?'forward':'reverse',requestX:400,requestY:400,x:405,y:394}));
const p={proof:{binding,samples,maxSpacing:{x:160,y:160},center:{x:400,y:400},patch:{left:0,top:0,right:800,bottom:800}},items:[{path:binding.probeId,cell:[0,0]}],anchorPath:binding.probeId,requestedAnchor:{x:400,y:400},area:{left:0,top:0,right:3840,bottom:2160},old:icons.map(i=>({x:i.x,y:i.y,w:78,h:98}))};
const bytes=Buffer.byteLength(ascii(JSON.stringify(p)));assert(bytes<1048576);assert(bytes<65536);assert.equal(binding.iconsKey.length,64);assert.equal(binding.geometryKey.length,64);
const legacy=JSON.parse(JSON.stringify(p));legacy.proof.binding.iconsKey=canonical;for(const sample of legacy.proof.samples)sample.iconsKey=canonical;const legacyBytes=Buffer.byteLength(ascii(JSON.stringify(legacy)));assert(legacyBytes>1048576);
const changed=icons.map(i=>({...i}));changed[201].x+=1;assert.notEqual(sha(JSON.stringify(changed)),binding.iconsKey);assert.notEqual(sha(canonical+'changed'),binding.iconsKey);
console.log(JSON.stringify({passed:true,icons:202,pidlChars:icons[0].identity.length,samples:44,inputBytes:bytes,legacyInputBytes:legacyBytes,limit:1048576,scope:'synthetic size and digest binding, not native proof'}));
