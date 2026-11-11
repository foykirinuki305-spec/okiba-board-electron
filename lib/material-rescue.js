'use strict';
// Recovery changes board references only. It never moves/unhides/deletes media.
const fs=require('fs'),fsp=fs.promises,path=require('path'),crypto=require('crypto');
const guard=require('./board-save-guard');
const HISTORY='.material-rescue.json',MAX_RECORDS=500;
const key=p=>path.resolve(p).toLowerCase();
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0');
function parse(raw){const o=JSON.parse(raw);if(!o||typeof o!=='object'||Array.isArray(o))throw Error('invalid-rescue-data');return o;}
function atomic(file,value){const tmp=file+'.tmp-'+crypto.randomBytes(8).toString('hex');const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,value,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
function validItem(i){return i&&absolute(i.src)&&absolute(i.dest)&&absolute(i.boardFolder)&&typeof i.identity==='string'&&!!i.identity&&typeof i.volume==='string'&&!!i.volume&&typeof i.size==='string'&&/^\d+$/.test(i.size)&&typeof i.mtime==='string'&&/^\d+$/.test(i.mtime)&&['file','directory'].includes(i.type)&&typeof i.operationId==='string'&&!!i.operationId;}
function loadHistory(base){const file=path.join(base,HISTORY);let raw;try{raw=fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return [];throw e;}const d=parse(raw);if(d.version!==1||!Array.isArray(d.items)||d.items.some(i=>!validItem(i)))throw Error('invalid-rescue-history');return d.items.slice(0,MAX_RECORDS);}
function recordMoves(base,{operationId,boardFolder,items,at=new Date().toISOString()}){
 if(!absolute(boardFolder)||typeof operationId!=='string'||!operationId||!Array.isArray(items)||!items.length)throw Error('invalid-rescue-record');
 const next=items.map(i=>({src:i.src,dest:i.dest,identity:i.identity,volume:i.volume,size:i.size,mtime:i.mtime,type:i.type||(i.treeKey?'directory':'file'),kind:i.kind==='resident'?'resident':'linked',col:Number.isInteger(i.col)?i.col:null,row:Number.isInteger(i.row)?i.row:null,boardFolder,operationId,at}));
 if(next.some(i=>!validItem(i)))throw Error('invalid-rescue-record');
 const ids=new Set(next.map(i=>operationId+'|'+key(i.src)));if(ids.size!==next.length)throw Error('duplicate-rescue-record');
 const previous=loadHistory(base).filter(i=>!ids.has(i.operationId+'|'+key(i.src)));
 const result=[...next,...previous].slice(0,MAX_RECORDS);atomic(path.join(base,HISTORY),JSON.stringify({version:1,items:result},null,2));return result;
}
function snapshot(r){if(!r||typeof r.identity!=='string'||!r.identity||typeof r.volume!=='string'||!r.volume||typeof r.size!=='string'||typeof r.mtime!=='string'||r.reparse===true)throw Error('invalid-candidate-identity');return {identity:r.identity,volume:r.volume,size:r.size,mtime:r.mtime,type:r.type||(r.regularFile===false?'directory':'file')};}
const equal=(a,b)=>['identity','volume','size','mtime','type'].every(k=>a[k]===b[k]);
async function safeAncestors(p){let q=path.resolve(p);for(;;){try{const s=await fsp.lstat(q);if(s.isSymbolicLink())throw Error('reparse-path-refused');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}const up=path.dirname(q);if(up===q)break;q=up;}}
async function findMissing({oldPath,boardFolder,roots=[],history=[],probe,cancelled=()=>false,limits={}}){
 if(!absolute(oldPath)||!absolute(boardFolder)||typeof probe!=='function')throw Error('invalid-find-request');
 const maxEntries=Math.min(20000,Math.max(1,limits.maxEntries||5000)),maxDepth=Math.min(8,Math.max(0,limits.maxDepth??3)),maxMs=Math.min(30000,Math.max(1,limits.maxMs||2000));
 const start=Date.now(),seen=new Set(),candidates=[],errors=[],searchedRoots=[];let scanned=0,truncated=false,canceled=false;
 const stop=()=>{if(cancelled()){canceled=true;return true;}if(scanned>=maxEntries||Date.now()-start>=maxMs){truncated=true;return true;}return false;};
 const records=history.filter(i=>validItem(i)&&key(i.boardFolder)===key(boardFolder)&&(key(i.src)===key(oldPath)||key(i.dest)===key(oldPath)));
 const expected=records[0]?snapshot(records[0]):null;
 const exactPaths=new Set(records.map(i=>key(i.dest)));
 async function inspect(p,known=false){if(stop()||seen.has(key(p)))return;seen.add(key(p));scanned++;
  try{await safeAncestors(p);const st=await fsp.lstat(p);if(!st.isFile()&&!st.isDirectory())return;
   if(!expected&&!known&&path.basename(p).toLowerCase()!==path.basename(oldPath).toLowerCase())return;
   const raw=await probe(p);if(!raw)return;const proof=snapshot(raw),strong=!!expected&&equal(proof,expected);
   if(!strong&&!known&&path.basename(p).toLowerCase()!==path.basename(oldPath).toLowerCase())return;
   candidates.push({path:p,proof,match:strong?'identity':'candidate',reason:strong?'recorded-identity-match':known?'recorded-location':'same-name',hidden:raw.hidden===true});
  }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))errors.push({path:p,reason:String(e.message||e)});}
 }
 // A missing reference may have returned since the UI loaded it; never repair it blindly.
 try{await safeAncestors(oldPath);if(await probe(oldPath))return {status:'source-present',candidates:[],searchedRoots:[],scanned:0,truncated:false,canceled:false,errors:[]};}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))return {status:'source-unavailable',candidates:[],searchedRoots:[],scanned:0,truncated:false,canceled:false,errors:[{path:oldPath,reason:String(e.message||e)}]};}
 for(const r of records){await inspect(r.dest,true);if(stop())break;}
 const uniqueRoots=[];for(const r of roots){if(!absolute(r)||/^\\\\/.test(r)||key(r)===key(path.parse(r).root))continue;if(!uniqueRoots.some(x=>key(x)===key(r)))uniqueRoots.push(path.resolve(r));}
 async function walk(dir,depth){if(stop())return;let entries;try{await safeAncestors(dir);entries=await fsp.readdir(dir,{withFileTypes:true});}catch(e){errors.push({path:dir,reason:String(e.message||e)});return;}
  for(const e of entries){if(stop())break;const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;await inspect(p,exactPaths.has(key(p)));if(e.isDirectory()&&depth<maxDepth)await walk(p,depth+1);}
 }
 for(const root of uniqueRoots){if(stop())break;searchedRoots.push(root);await walk(root,0);}
 candidates.sort((a,b)=>(a.match==='identity'?0:1)-(b.match==='identity'?0:1)||a.path.localeCompare(b.path));
 const strong=candidates.filter(c=>c.match==='identity');return {status:canceled?'canceled':strong.length===1?'confirmed':strong.length>1||candidates.length>1?'ambiguous':candidates.length?'candidate':'not-found',candidates,searchedRoots,scanned,truncated,canceled,errors};
}
async function repairReference({boardFolder,oldPath,newPath,expectedRevision,expectedCandidate,probe,confirmedByUser=false}){
 if(!absolute(boardFolder)||!absolute(oldPath)||!absolute(newPath)||typeof probe!=='function'||confirmedByUser!==true)throw Error('repair-confirmation-required');
 if(key(oldPath)===key(newPath))throw Error('repair-same-path');const expected=snapshot(expectedCandidate);
 await safeAncestors(boardFolder);await safeAncestors(newPath);const raw=guard.readRaw(boardFolder);
 if(raw===null||guard.revision(raw)!==expectedRevision)return {saved:false,conflict:true};
 const data=parse(raw);if(!Array.isArray(data.links))throw Error('repair-links-missing');const matches=data.links.filter(l=>typeof l?.path==='string'&&key(l.path)===key(oldPath));
 if(matches.length!==1)throw Error('repair-link-not-unique');if(data.links.some(l=>typeof l?.path==='string'&&key(l.path)===key(newPath)))throw Error('repair-already-linked');
 if(await probe(oldPath))throw Error('repair-source-present');const current=await probe(newPath);if(!current||!equal(snapshot(current),expected))throw Error('repair-candidate-changed');
 const index=data.links.indexOf(matches[0]);data.links[index]={...matches[0],path:newPath};const next=JSON.stringify(data,null,2),target=path.join(boardFolder,'.okiba-board.json'),tmp=target+'.tmp-'+crypto.randomBytes(8).toString('hex');
 if(guard.readRaw(boardFolder)!==raw)return {saved:false,conflict:true};
 const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,next,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{if(guard.readRaw(boardFolder)!==raw)return {saved:false,conflict:true};fs.renameSync(tmp,target);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {saved:true,conflict:false,revision:guard.revision(next)};
}
module.exports={HISTORY,MAX_RECORDS,loadHistory,recordMoves,findMissing,repairReference,snapshot};
