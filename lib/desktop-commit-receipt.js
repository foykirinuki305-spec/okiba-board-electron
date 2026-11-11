'use strict';
// No filesystem writes: the independent watchdog supplies bytes read after owner exit.
const path=require('path');
const crypto=require('crypto');
const key=p=>typeof p==='string'&&path.win32.isAbsolute(p)?path.win32.normalize(p).toLowerCase():null;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function validReceipts(receipts,allowed){
 if(!Array.isArray(receipts)||!receipts.length||!Array.isArray(allowed)||receipts.length!==allowed.length)return false;
 const keys=allowed.map(key);if(keys.some(k=>!k)||new Set(keys).size!==keys.length)return false;
 const seen=new Set();return receipts.every(r=>{const k=key(r?.path);if(!k||!keys.includes(k)||seen.has(k))return false;seen.add(k);return /^[a-f0-9]{64}$/.test(r.beforeHash)&&/^[a-f0-9]{64}$/.test(r.afterHash)&&r.beforeHash!==r.afterHash;});
}
function classifyReceipt({receipts,allowedPaths,current,ownerExited}){
 if(!validReceipts(receipts,allowedPaths))return {action:'blocked',reason:'invalid-receipts'};
 // Timeout or a missing heartbeat is NOT proof that the metadata writer exited.
 if(ownerExited!==true)return {action:'wait',reason:'owner-not-confirmed-exited'};
 if(!Array.isArray(current)||current.length!==receipts.length)return {action:'blocked',reason:'receipt-unreadable'};
 const seen=new Set();const states=[];
 for(const r of receipts){const matches=current.filter(c=>key(c.path)===key(r.path));if(matches.length!==1||seen.has(key(r.path)))return {action:'blocked',reason:'receipt-ambiguous'};seen.add(key(r.path));const h=matches[0].hash;states.push(h===r.beforeHash?'before':h===r.afterHash?'after':'unknown');}
 if(states.every(s=>s==='before'))return {action:'rollback-selected'};
 if(states.every(s=>s==='after'))return {action:'keep-visible'};
 return {action:'blocked',reason:states.includes('unknown')?'receipt-changed':'receipt-mixed'};
}
module.exports={key,hash,validReceipts,classifyReceipt};
