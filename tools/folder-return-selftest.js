'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');const {createFolderReturn,transform}=require('../lib/folder-return');
let count=0;const check=(v,m)=>{assert(v,m);count++;};
async function test(mode){const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-folder-return-unit-'));try{
 const base=path.join(root,'base'),folder=path.join(base,'board'),dest=path.join(root,'out');fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(dest);const a=path.join(folder,'a.mp4'),b=path.join(root,mode==='duplicate'?'a.mp4':'b.mp4');fs.writeFileSync(a,'aaa');fs.writeFileSync(b,'bbb');
 const data={version:6,unknown:{keep:12},positions:{'a.mp4':{col:2,row:3},other:{col:9,row:8}},links:[{path:b,col:4,row:5,wasHidden:false,unknown:7}],theme:'same'};const meta=path.join(folder,'.okiba-board.json'),raw=JSON.stringify(data);fs.writeFileSync(meta,raw);let calls=[];const hidden=new Set();let editedRaw=null;
 const native=async r=>{calls.push(r.action);if(r.action==='prepare')return {ok:true,items:r.sources.map(src=>({src,dest:path.join(dest,path.basename(src)),identity:src,attributes:32})),failed:[]};
 if(r.action==='probe')return {ok:true,results:r.items.map(i=>({...i,state:fs.existsSync(i.src)?'source':'destination',visible:!hidden.has(i.dest)}))};
 if(r.action==='finalize'){check(r.items.every(i=>hidden.has(i.dest)&&!fs.existsSync(i.src)),'finalize only moved hidden destination');return {ok:true,results:r.items.map(i=>{hidden.delete(i.dest);return {...i,moved:true,visible:true};})};}
 const results=[];for(const i of r.items){if(mode==='skip'&&i.src===b){results.push({...i,moved:false,visible:false,skipped:true});continue;}if(mode==='failed'&&i.src===b){results.push({...i,moved:false,visible:false,skipped:false,reason:'locked'});continue;}fs.renameSync(i.src,i.dest);if(mode==='invisible')hidden.add(i.dest);if(mode==='concurrent'){editedRaw=JSON.stringify({...data,unknown:{keep:12,concurrent:'must remain'},positions:{...data.positions,other:{col:17,row:18}}});fs.writeFileSync(meta,editedRaw);}results.push({...i,moved:true,visible:mode!=='invisible',skipped:false});if(mode==='crash')throw Error('lost-response');}return {ok:true,results};};
 const run=createFolderReturn({base,guardBoard:n=>{if(n!=='board')throw Error('bad board');return folder;},destination:dest,callNative:native});const payload={boardName:'board',paths:[a],linkedPaths:[b]};
 const r=await run(payload);check(r.metadataCommitted===true,'authoritative');check(JSON.parse(fs.readFileSync(meta)).unknown.keep===12,'unknown preserved');check(JSON.parse(fs.readFileSync(meta)).positions.other.col===(mode==='concurrent'?17:9),'other cell preserved');
 if(mode==='ok'){check(r.moved.length===2);check(!fs.existsSync(a)&&!fs.existsSync(b));const d=JSON.parse(fs.readFileSync(meta));check(!d.positions['a.mp4']&&d.links.length===0);check(!fs.existsSync(path.join(base,'.folder-return-pending.json')));}
 if(mode==='skip'||mode==='failed'){check(r.moved.length===1);check(fs.existsSync(b));check(JSON.parse(fs.readFileSync(meta)).links[0].unknown===7);check((mode==='skip'?r.skipped:r.failed).includes(b));}
 if(mode==='crash'){check(r.pendingVerification===true);check(fs.existsSync(path.join(dest,'a.mp4')));check(fs.readFileSync(meta,'utf8')===raw);await run({...payload,paths:[],linkedPaths:[]});const d=JSON.parse(fs.readFileSync(meta));check(!d.positions['a.mp4']&&d.links.length===1,'recovery only moved');check(!fs.existsSync(path.join(base,'.folder-return-pending.json')));}
  if(mode==='invisible'){
  check(r.pendingVerification===true);check(fs.readFileSync(meta,'utf8')===raw);check(hidden.size===2);
  const beforeCalls=calls.length;await run({...payload,paths:[],linkedPaths:[]});
  check(calls.slice(beforeCalls).join(',')==='probe,finalize,probe','hidden recovery probes, finalizes and verifies without repeated execute');
  check(hidden.size===0);const d=JSON.parse(fs.readFileSync(meta));check(!d.positions['a.mp4']&&d.links.length===0,'hidden recovery commits only proven visible moves');
  check(!fs.existsSync(path.join(base,'.folder-return-pending.json')),'recovery clears journal');
  check(fs.readFileSync(path.join(dest,'a.mp4'),'utf8')==='aaa'&&fs.readFileSync(path.join(dest,'b.mp4'),'utf8')==='bbb','recovered contents unchanged');
 }
 if(mode==='duplicate'){
  check(r.moved.length===1&&r.moved[0]===a,'first same-basename selection moved');check(r.skipped.length===1&&r.skipped[0]===b,'later same-basename selection skipped');
  check(fs.readFileSync(path.join(dest,'a.mp4'),'utf8')==='aaa'&&fs.readFileSync(b,'utf8')==='bbb','no overwrite or suffix copy');
  const d=JSON.parse(fs.readFileSync(meta));check(!d.positions['a.mp4']&&d.links[0].path===b&&d.links[0].unknown===7,'only successful duplicate selection removed');
  check(!fs.existsSync(path.join(base,'.folder-return-pending.json')),'duplicate does not strand journal');
 }
 if(mode==='concurrent'){
  check(r.pendingVerification===true&&r.error.includes('board-changed-recovery-required'),'concurrent edit stops commit');
  check(fs.readFileSync(meta,'utf8')===editedRaw,'concurrent metadata exactly preserved');
  const beforeCalls=calls.length;const retry=await run({...payload,paths:[],linkedPaths:[]});
  check(retry.pendingVerification===true&&retry.error.includes('board-changed-recovery-required'),'recovery also refuses to overwrite concurrent edit');
  check(fs.readFileSync(meta,'utf8')===editedRaw,'retry preserves concurrent metadata');check(calls.slice(beforeCalls).join(',')==='probe','retry probes only, no second rename');
  check(fs.existsSync(path.join(base,'.folder-return-pending.json')),'unresolved journal retained');
  check(fs.readFileSync(path.join(dest,'a.mp4'),'utf8')==='aaa'&&fs.readFileSync(path.join(dest,'b.mp4'),'utf8')==='bbb','moved originals retained for recovery');
 }
 }finally{if(!path.basename(root).startsWith('okiba-folder-return-unit-'))throw Error('bad cleanup');fs.rmSync(root,{recursive:true,force:true});}}
async function blockedTest(mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-folder-return-unit-'));
 try{
  const base=path.join(root,'boards'),folder=path.join(base,'board'),other=path.join(base,'other'),dest=path.join(root,'out'),parent=path.join(root,'source'),child=path.join(parent,'nested','child.txt');
  for(const d of [folder,other,dest,path.dirname(child)])fs.mkdirSync(d,{recursive:true});fs.writeFileSync(child,'unchanged child');
  const childSelected=mode.endsWith('ancestor'),selected=childSelected?child:parent,reference=childSelected?parent:child;
  const data={version:6,positions:{unchanged:{col:9,row:8}},links:[{path:selected,col:2,row:3,future:4}],future:{keep:true}};
  const otherData={version:6,positions:{},links:[],future:{keep:true}};
  if(mode.startsWith('same-')||mode==='parent-child')data.links.push({path:reference,col:5,row:7});
  if(mode.startsWith('other-'))otherData.links.push({path:reference,col:4,row:1});
  if(mode==='sibling-prefix')otherData.links.push({path:parent+'-sibling',col:4,row:1});
  const meta=path.join(folder,'.okiba-board.json'),otherMeta=path.join(other,'.okiba-board.json'),raw=JSON.stringify(data),otherRaw=JSON.stringify(otherData);fs.writeFileSync(meta,raw);fs.writeFileSync(otherMeta,otherRaw);const calls=[];
  const native=async req=>{calls.push(req.action);if(req.action==='prepare'){
   if(mode==='execute-failed'||mode==='execute-skipped')return {ok:true,items:req.sources.map(src=>({src,dest:path.join(dest,path.basename(src)),identity:src,attributes:32})),failed:[]};
   return {ok:true,items:[],failed:req.sources.map(src=>({src,reason:mode==='prepare-failed'?'return-cross-volume-refused':'resident-name-occupied'}))};
  }if(req.action==='execute')return {ok:true,results:req.items.map(i=>({...i,moved:false,visible:false,skipped:mode==='execute-skipped',reason:mode==='execute-skipped'?'resident-name-occupied':'locked'}))};throw Error('unexpected native '+req.action);};
  const run=createFolderReturn({base,guardBoard:n=>{if(n!=='board')throw Error('bad board');return folder;},destination:dest,callNative:native});
  const r=await run({boardName:'board',paths:[],linkedPaths:mode==='parent-child'?[parent,child]:[selected]});
  check(r.metadataCommitted===true,'blocked authoritative');check(r.moved.length===0,'blocked does not move');
  check(fs.readFileSync(meta,'utf8')===raw&&fs.readFileSync(otherMeta,'utf8')===otherRaw,'blocked metadata exactly unchanged');
  check(fs.readFileSync(child,'utf8')==='unchanged child'&&fs.readdirSync(dest).length===0,'blocked materials unchanged');
  check(!fs.existsSync(path.join(base,'.folder-return-pending.json')),'blocked no pending journal');
  if(mode==='parent-child'){check(Boolean(r.error),'parent-child selection rejected');check(calls.length===0,'parent-child never calls native');}
  else{
   check(typeof r.warningText==='string'&&r.warningText.length>0,'all-failed/all-skipped visible user warning');
   if(mode.startsWith('same-')||mode.startsWith('other-')){check(r.failed.includes(selected),'overlapping reference refused');check(calls.length===0,'overlapping reference never calls native');}
   else{check(calls.join(',')===(mode.startsWith('execute-')?'prepare,execute':'prepare'),'correct refusal stage');check((mode.endsWith('failed')?r.failed:r.skipped).includes(selected),'failure/skip classification');}
  }
 }finally{if(!path.basename(root).startsWith('okiba-folder-return-unit-'))throw Error('bad cleanup');fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{for(const m of ['ok','skip','failed','crash','invisible','duplicate','concurrent'])await test(m);for(const m of ['other-ancestor','other-descendant','same-ancestor','same-descendant','parent-child','sibling-prefix','prepare-failed','prepare-skipped','execute-failed','execute-skipped'])await blockedTest(m);const x={positions:{a:{col:1}},links:[],custom:42};check(JSON.parse(transform(JSON.stringify(x),[])).custom===42);console.log('folder-return selftest '+count+' PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
