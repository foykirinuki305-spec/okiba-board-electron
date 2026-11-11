'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const key=p=>path.resolve(p).toLowerCase();
const ascii=x=>JSON.stringify(x).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
// One worker per script. A failed or timed-out operation is NEVER replayed.
const nativeWorkers=new Map();
function nativeCall(scriptPath,request){
 let line;try{line=ascii(request);if(typeof line!=='string'||line.length>4194304)throw Error('request-overflow');}catch(e){return Promise.reject(e);}
 const k=path.resolve(scriptPath);let w=nativeWorkers.get(k);
 if(!w){
  const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',k,'-Persistent'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  w={p,queue:[],active:null,out:'',err:'',dead:false,timer:null,idle:null};nativeWorkers.set(k,w);
  const refs=on=>{for(const x of [p,p.stdin,p.stdout,p.stderr])if(typeof x[on?'ref':'unref']==='function')x[on?'ref':'unref']();};
  w.fail=e=>{if(w.dead)return;w.dead=true;clearTimeout(w.timer);clearTimeout(w.idle);if(nativeWorkers.get(k)===w)nativeWorkers.delete(k);if(w.active)w.active.reject(e);for(const q of w.queue)q.reject(e);w.queue=[];w.active=null;try{p.kill();}catch(_){};};
  w.next=()=>{
   if(w.dead||w.active)return;clearTimeout(w.idle);
   if(!w.queue.length){refs(false);return;}
   refs(true);w.active=w.queue.shift();w.timer=setTimeout(()=>w.fail(Error('native-timeout-recovery-required')),60000);
   p.stdin.write(w.active.line+'\n',e=>{if(e)w.fail(e);});
  };
  p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
  p.stdout.on('data',b=>{w.out+=b;if(w.out.length>8*1024*1024){w.fail(Error('response-overflow'));return;}let n;
   while((n=w.out.indexOf('\n'))>=0){const line=w.out.slice(0,n).replace(/^\uFEFF/,'').trim();w.out=w.out.slice(n+1);if(!line)continue;
    if(!w.active){w.fail(Error('unexpected-native-response'));return;}let r;try{r=JSON.parse(line);if(!r||typeof r.ok!=='boolean')throw Error('invalid-native-response');}catch(e){w.fail(e);return;}
    clearTimeout(w.timer);const q=w.active;w.active=null;if(r.ok)q.resolve(r);else q.reject(Error(r.reason||'native-failed'));w.next();
   }
  });
  p.stderr.on('data',b=>{if(w.err.length<2048)w.err+=b;});p.stdin.on('error',e=>w.fail(e));p.on('error',e=>w.fail(e));p.on('close',code=>w.fail(Error('native-exited-'+code+(w.err?': '+w.err:''))));
 }
 return new Promise((resolve,reject)=>{w.queue.push({line,resolve,reject});w.next();});
}
function stopNative(){for(const w of [...nativeWorkers.values()])w.fail(Error('native-shutdown-recovery-required'));}
function atomic(file,raw){const tmp=file+'.tmp-'+crypto.randomBytes(8).toString('hex');const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch(_){}throw e;}}
function object(raw){const x=JSON.parse(raw);if(!x||typeof x!=='object'||Array.isArray(x))throw Error('invalid-board');return x;}
function transform(raw,items){const data=object(raw);const moved=new Set(items.map(i=>key(i.src)));data.links=(data.links||[]).filter(l=>!moved.has(key(l.path)));if(data.positions){for(const i of items)if(i.kind==='resident')delete data.positions[path.basename(i.src)];}return JSON.stringify(data,null,2);}
function selection(folder,raw,payload){
 const data=object(raw),all=[];const seen=new Set();
 for(const [kind,list] of [['resident',payload.paths||[]],['linked',payload.linkedPaths||[]]]){
  if(!Array.isArray(list))throw Error('invalid-selection');for(const src of list){if(typeof src!=='string'||!path.isAbsolute(src)||seen.has(key(src)))throw Error('invalid-selection');seen.add(key(src));
   if(kind==='resident'){if(key(path.dirname(src))!==key(folder)||path.basename(src)==='.okiba-board.json')throw Error('not-board-resident');}
   else if(!(data.links||[]).some(l=>key(l.path)===key(src)))throw Error('not-board-linked');
   all.push({src,kind});
  }
 }
 if(!all.length||all.length>1000)throw Error('invalid-selection-count');return all;
}
function overlaps(a,b){a=key(a);b=key(b);return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);}
function sharedElsewhere(base,board,src){for(const name of fs.readdirSync(base)){const folder=path.join(base,name);if(key(folder)===key(board))continue;let st;try{st=fs.lstatSync(folder);}catch(_){continue;}if(!st.isDirectory()||st.isSymbolicLink())continue;const f=path.join(folder,'.okiba-board.json');if(!fs.existsSync(f))continue;const data=object(fs.readFileSync(f,'utf8'));if((data.links||[]).some(l=>overlaps(l.path,src)))return true;}return false;}
function finishMessage(r){
 if(!r.failed.length&&!r.skipped.length)return;
 const reasons=(r.details||[]).map(x=>String(x.reason||''));let why=[];
 if(reasons.some(x=>/shared|参照/.test(x)))why.push('別のボードや項目からも参照されています');
 if(reasons.some(x=>/name-occupied|duplicate-destination/.test(x)))why.push('戻し先に同名のものがあります');
 if(reasons.some(x=>/cross-volume/.test(x)))why.push('別のドライブには移動できません');
 if(reasons.some(x=>/kind-mismatch|attributes|reparse|single-link/.test(x)))why.push('この種類・属性の項目は安全に移動できません');
 r.warningText=(r.moved.length?'一部だけ移動しました。':'移動していません。')+(why.length?why.join('。')+'。':'使用中や保存先の状態を確認してください。');
}
function createFolderReturn({base,guardBoard,destination,forbidden=[],scriptPath,callNative=r=>nativeCall(scriptPath,r),onDone=()=>{},onRecord=async()=>{}}){
 let busy=false;
 const blank=()=>({moved:[],destinations:[],skipped:[],failed:[],details:[],metadataCommitted:true,position:{status:'not-applicable'},returnFolder:destination});
 const journalFile=path.join(base,'.folder-return-pending.json');
 function save(j){atomic(journalFile,JSON.stringify(j,null,2));}
 function commit(j,done){
  if(!done.length)return;
  const current=fs.readFileSync(j.metadata,'utf8'),desired=transform(j.before,done);
  const prior=transform(j.before,j.items.filter(i=>(j.results||[]).some(r=>r.src===i.src&&r.moved&&r.visible)));
  if(current!==j.before&&current!==desired&&current!==prior)throw Error('board-changed-recovery-required');
  if(current!==desired)atomic(j.metadata,desired);
 }
 async function recover(){
  if(!fs.existsSync(journalFile))return;
  const j=object(fs.readFileSync(journalFile,'utf8'));
  if(j.version!==1||typeof j.boardName!=='string'||j.metadata!==path.join(guardBoard(j.boardName),'.okiba-board.json')||key(j.destination)!==key(destination)||!Array.isArray(j.items))throw Error('invalid-recovery-record');
  const probe=await callNative({action:'probe',items:j.items});if(!Array.isArray(probe.results)||probe.results.length!==j.items.length)throw Error('recovery-count');
  for(let n=0;n<j.items.length;n++){const v=probe.results[n],i=j.items[n];if(!v||key(v.src)!==key(i.src)||key(v.dest)!==key(i.dest)||v.identity!==i.identity)throw Error('recovery-mismatch');}
  const invisible=probe.results.map((r,n)=>r.state==='destination'&&!r.visible?j.items[n]:null).filter(Boolean);
  if(invisible.length){const fin=await callNative({action:'finalize',items:invisible});if(!Array.isArray(fin.results)||fin.results.some(r=>!r.moved||!r.visible))throw Error('recovery-visibility-required');const again=await callNative({action:'probe',items:j.items});probe.results=again.results;}
  const done=[];for(let n=0;n<j.items.length;n++){const r=probe.results[n],i=j.items[n];if(!r||key(r.src)!==key(i.src)||key(r.dest)!==key(i.dest)||r.identity!==i.identity)throw Error('recovery-mismatch');if(r.state==='source')continue;if(r.state==='destination'&&r.visible===true){done.push(i);continue;}throw Error('recovery-required');}
  commit(j,done);await onRecord(j,done);fs.unlinkSync(journalFile);
 }
 return async function run(payload){
  const r=blank();if(busy){r.error='移動処理中です。完了まで待ってください。';return r;}busy=true;
  try{
   await recover();
   const folder=guardBoard(payload?.boardName),metadata=path.join(folder,'.okiba-board.json');const before=fs.readFileSync(metadata,'utf8'),chosen=selection(folder,before,payload);
   if(forbidden.some(p=>key(destination)===key(p)))throw Error('desktop-root-refused');
   // An app-owned normal Documents subfolder, not a Desktop icon. Created only on an explicit drop.
   fs.mkdirSync(destination,{recursive:true});
   for(let a=0;a<chosen.length;a++)for(let b=a+1;b<chosen.length;b++)if(overlaps(chosen[a].src,chosen[b].src))throw Error('親フォルダとその中身は同時に選ばず、親フォルダだけ選んでください');
   const current=object(before);
   const eligible=[];for(const i of chosen){if(overlaps(i.src,base)&&key(path.dirname(i.src))!==key(folder))throw Error('ボードの保存場所を含むフォルダは移動できません');if(sharedElsewhere(base,folder,i.src)||(current.links||[]).some(l=>key(l.path)!==key(i.src)&&overlaps(l.path,i.src))){r.failed.push(i.src);r.details.push({src:i.src,reason:'他のボードも参照しているため移動しませんでした'});}else eligible.push(i);}
   if(!eligible.length)return r;
   const prepared=await callNative({action:'prepare',sources:eligible.map(i=>i.src),destDir:destination});
   if(!Array.isArray(prepared.items)||!Array.isArray(prepared.failed))throw Error('prepare-invalid');
   const mapping=new Map(eligible.map(i=>[key(i.src),i]));const seen=new Set();
   for(const f of prepared.failed){if(!mapping.has(key(f.src))||seen.has(key(f.src)))throw Error('prepare-source-mismatch');seen.add(key(f.src));if(String(f.reason).includes('name-occupied'))r.skipped.push(f.src);else r.failed.push(f.src);r.details.push(f);}
   let items=prepared.items.map(i=>{if(!mapping.has(key(i.src))||seen.has(key(i.src))||key(path.dirname(i.dest))!==key(destination)||path.basename(i.dest)!==path.basename(i.src)||!i.identity)throw Error('prepare-item-mismatch');seen.add(key(i.src));return {...i,kind:mapping.get(key(i.src)).kind};});
   if(seen.size!==eligible.length)throw Error('prepare-incomplete');
   const destSeen=new Set();items=items.filter(i=>{if(destSeen.has(key(i.dest))){r.skipped.push(i.src);r.details.push({src:i.src,reason:'duplicate-destination'});return false;}destSeen.add(key(i.dest));return true;});if(!items.length)return r;
   if(fs.readFileSync(metadata,'utf8')!==before)throw Error('board-changed');
   const j={version:1,operationId:crypto.randomBytes(16).toString('hex'),boardName:payload.boardName,metadata,destination,before,items,phase:'prepared'};save(j);
   const executed=await callNative({action:'execute',items});
   if(!Array.isArray(executed.results)||executed.results.length!==items.length)throw Error('execute-incomplete');
   const done=[];let pending=false;
   for(let n=0;n<items.length;n++){const i=items[n],v=executed.results[n];if(!v||key(v.src)!==key(i.src)||key(v.dest)!==key(i.dest)||v.identity!==i.identity)throw Error('execute-mismatch');
    r.details.push(v);if(v.moved&&v.visible){done.push(i);r.moved.push(i.src);r.destinations.push(i.dest);}else if(v.moved){pending=true;r.failed.push(i.src);}else if(v.skipped)r.skipped.push(i.src);else r.failed.push(i.src);
   }
   j.results=executed.results;j.phase='executed';save(j);commit(j,done);await onRecord(j,done);
   if(pending){r.error='ファイルは移動しましたが表示を確認できません。再操作せず確認してください。';r.pendingVerification=true;}else fs.unlinkSync(journalFile);
   if(r.moved.length){r.warningText='戻し先フォルダへ移動しました。そこからデスクトップに並べてください。';await onDone(destination,r);}
   if(r.skipped.length||r.failed.length)r.warningText=(r.warningText||'')+' 一部は移動していません。同名・使用中・別ドライブなどを確認してください。';
  }catch(e){r.error='移動を完了できませんでした。'+String(e.message||e);r.pendingVerification=fs.existsSync(journalFile);}
  finally{busy=false;finishMessage(r);}return r;
 };
}
module.exports={stopNative,warmNative:scriptPath=>nativeCall(scriptPath,{action:'ping'}),createFolderReturn,nativeCall,selection,transform,sharedElsewhere,atomic};
