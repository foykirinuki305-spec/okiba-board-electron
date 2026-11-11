'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const {createController,TTL,MAX_TOKENS}=require('../lib/material-rescue-controller');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-rescue-controller-'));
 let n=0;const ok=(v)=>{assert(v);n++;};const rejects=async(f,re)=>{await assert.rejects(f,re);n++;};
 try{
  const board=path.join(root,'board'),dest=path.join(root,'dest'),old=path.join(root,'missing.txt'),target=path.join(dest,'missing.txt');fs.mkdirSync(board);fs.mkdirSync(dest);fs.writeFileSync(target,'x');
  const file=path.join(board,'.okiba-board.json');const initial={links:[{path:old,col:3,row:2,wasHidden:true,custom:7}],notes:[]};const reset=()=>fs.writeFileSync(file,JSON.stringify(initial));reset();
  const proof={identity:'12345678:0000000000000001',volume:'12345678',size:'1',mtime:'1',type:'file'};
  let busy=false,notify=0,locks=0,valid=true,probeHook=null;
  const options={base:root,guardBoard:async name=>{if(name!=='b'||!valid)throw Error('bad-board');return board;},roots:()=>[dest],probe:async p=>{if(probeHook)await probeHook(p);return fs.existsSync(p)?proof:null;},notify:()=>{notify++;},isBusy:()=>busy,withLock:async(folder,fn)=>{assert.strictEqual(folder,board);locks++;return fn();}};
  const c=createController(options);
  await rejects(()=>c.find('b',target),/link-not-unique/);await rejects(()=>c.find('bad',old),/bad-board/);
  let r=await c.find('b',old);ok(r.candidates.length===1);ok(!('proof' in r.candidates[0]));ok(r.candidates[0].match==='candidate');
  await rejects(()=>c.repair('arbitrary'),/token-expired/);
  busy=true;await rejects(()=>c.repair(r.candidates[0].token),/board-busy/);busy=false;
  let done=await c.repair(r.candidates[0].token);ok(done.saved);ok(notify===1&&locks===1);const saved=JSON.parse(fs.readFileSync(file));ok(saved.links[0].path===target&&saved.links[0].custom===7&&saved.links[0].col===3);ok(fs.existsSync(target)&&!fs.existsSync(old));await rejects(()=>c.repair(r.candidates[0].token),/token-expired/);
  reset();r=await c.find('b',old);fs.writeFileSync(file,JSON.stringify({...initial,theme:'new'}));done=await c.repair(r.candidates[0].token);ok(done.conflict&&!done.saved);
  reset();r=await c.find('b',old);valid=false;await rejects(()=>c.repair(r.candidates[0].token),/bad-board/);valid=true;
  reset();r=await c.find('b',old);const now=Date.now;try{Date.now=()=>now()+TTL+1;await rejects(()=>c.repair(r.candidates[0].token),/token-expired/);}finally{Date.now=now;}
  reset();const first=(await c.find('b',old)).candidates[0].token;await c.find('b',old);await rejects(()=>c.repair(first),/token-expired/);
  reset();let changed=false;probeHook=async p=>{if(p===target&&!changed){changed=true;fs.writeFileSync(file,JSON.stringify({...initial,theme:'during-find'}));}};r=await c.find('b',old);ok(r.status==='board-changed'&&r.candidates.length===0);probeHook=null;
  reset();for(let i=0;i<55;i++){const dir=path.join(dest,'d'+i);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'missing.txt'),'x');}r=await c.find('b',old);ok(r.candidates.length===MAX_TOKENS&&r.truncated);ok(new Set(r.candidates.map(x=>x.token)).size===MAX_TOKENS);
  const siblingToken=r.candidates[1].token;done=await c.repair(r.candidates[0].token);ok(done.saved);await rejects(()=>c.repair(siblingToken),/token-expired/);
  reset();const failureNotice=createController({...options,notify:()=>{throw Error('notify failed');}});r=await failureNotice.find('b',old);done=await failureNotice.repair(r.candidates[0].token);ok(done.saved&&done.notificationFailed);
  console.log('material-rescue-controller: '+n+' checks PASS');
 }finally{
  const resolved=path.resolve(root),parent=path.resolve(os.tmpdir());if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('okiba-rescue-controller-'))throw Error('unsafe-cleanup');fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
