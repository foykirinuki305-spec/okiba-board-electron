'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const m=require('../lib/material-rescue'),g=require('../lib/board-save-guard');
let checks=0;const ok=v=>{assert(v);checks++;},eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++;};
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-rescue-test-')),base=path.join(root,'base'),board=path.join(base,'board'),dest=path.join(root,'return');fs.mkdirSync(board,{recursive:true});fs.mkdirSync(dest);
 const old=path.join(root,'absent','画像.lnk'),target=path.join(dest,'画像.lnk');fs.writeFileSync(target,'shortcut-test');
 const proof={identity:'A:1',volume:'A',size:'13',mtime:'100',type:'file',hidden:true};
 const proofs=new Map([[target,proof]]);const probe=async p=>proofs.get(p)||null;
 const before={version:6,unknown:{keep:1},positions:{resident:{col:1,row:2,extra:'yes'}},links:[{path:old,col:5,row:0,wasHidden:false,extra:{keep:2}},{path:path.join(root,'other'),col:4,row:5}],notes:[{id:'x',text:'note'}]};
 const reset=()=>fs.writeFileSync(path.join(board,'.okiba-board.json'),JSON.stringify(before));reset();
 eq(m.loadHistory(base),[]);
 m.recordMoves(base,{operationId:'one',boardFolder:board,items:[{src:old,dest:target,...proof,col:5,row:0}]});
 eq(m.loadHistory(base).length,1);eq(m.loadHistory(base)[0].col,5);
 m.recordMoves(base,{operationId:'one',boardFolder:board,items:[{src:old,dest:target,...proof}]});eq(m.loadHistory(base).length,1);
 let r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:m.loadHistory(base),probe});eq(r.status,'confirmed');eq(r.candidates.length,1);eq(r.candidates[0].hidden,true);
 const metadata=fs.readFileSync(path.join(board,'.okiba-board.json'),'utf8');
 r=await m.repairReference({boardFolder:board,oldPath:old,newPath:target,expectedRevision:g.revision(metadata),expectedCandidate:proof,probe,confirmedByUser:true});ok(r.saved);
 const after=JSON.parse(g.readRaw(board));eq(after.links[0],{...before.links[0],path:target});eq(after.links[1],before.links[1]);eq(after.positions,before.positions);eq(after.unknown,before.unknown);eq(after.notes,before.notes);eq(fs.readFileSync(target,'utf8'),'shortcut-test');
 reset();await assert.rejects(m.repairReference({boardFolder:board,oldPath:old,newPath:target,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proof,probe}),/confirmation/);checks++;
 r=await m.repairReference({boardFolder:board,oldPath:old,newPath:target,expectedRevision:'old',expectedCandidate:proof,probe,confirmedByUser:true});eq(r,{saved:false,conflict:true});
 await assert.rejects(m.repairReference({boardFolder:board,oldPath:old,newPath:target,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:{...proof,identity:'changed'},probe,confirmedByUser:true}),/candidate-changed/);checks++;
 proofs.set(old,proof);await assert.rejects(m.repairReference({boardFolder:board,oldPath:old,newPath:target,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proof,probe,confirmedByUser:true}),/source-present/);checks++;
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:[],probe});eq(r.status,'source-present');proofs.delete(old);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:[],probe});eq(r.status,'candidate');
 const sub=path.join(dest,'sub');fs.mkdirSync(sub);const other=path.join(sub,'画像.lnk');fs.writeFileSync(other,'different');proofs.set(other,{...proof,identity:'A:2'});
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:[],probe});eq(r.status,'ambiguous');eq(r.candidates.length,2);
 proofs.set(target,{...proof,mtime:'200'});r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:m.loadHistory(base),probe});ok(r.candidates.every(c=>c.match==='candidate'));proofs.set(target,proof);
 // A renamed recorded file is still found by native identity.
 const renamed=path.join(dest,'renamed.lnk');fs.renameSync(target,renamed);proofs.delete(target);proofs.set(renamed,proof);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],history:m.loadHistory(base),probe});eq(r.status,'confirmed');eq(r.candidates[0].path,renamed);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],probe,limits:{maxEntries:1}});ok(r.truncated);ok(r.scanned<=1);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],probe,cancelled:()=>true});ok(r.canceled);eq(r.scanned,0);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[path.parse(root).root],probe});eq(r.searchedRoots,[]);
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[dest],probe:async()=>{throw Error('access denied');}});eq(r.status,'source-unavailable');
 // Concurrent metadata mutation after a probe cannot be overwritten.
 reset();let changed=false;const concurrent=async p=>{if(p===renamed&&!changed){changed=true;fs.writeFileSync(path.join(board,'.okiba-board.json'),JSON.stringify({...before,unknown:{newer:1}}));}return proofs.get(p)||null;};
 r=await m.repairReference({boardFolder:board,oldPath:old,newPath:renamed,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proof,probe:concurrent,confirmedByUser:true});eq(r,{saved:false,conflict:true});eq(JSON.parse(g.readRaw(board)).unknown,{newer:1});
 // Directory candidates retain the saved cell, and only the path is repaired.
 reset();proofs.set(sub,{identity:'A:D',volume:'A',size:'0',mtime:'300',regularFile:false});r=await m.repairReference({boardFolder:board,oldPath:old,newPath:sub,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proofs.get(sub),probe,confirmedByUser:true});ok(r.saved);eq(JSON.parse(g.readRaw(board)).links[0].col,5);
 reset();const duplicate={...before,links:[...before.links,{path:renamed,col:0,row:0}]};fs.writeFileSync(path.join(board,'.okiba-board.json'),JSON.stringify(duplicate));await assert.rejects(m.repairReference({boardFolder:board,oldPath:old,newPath:renamed,expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proof,probe,confirmedByUser:true}),/already-linked/);checks++;
 // No following junctions outside the chosen scope.
 const outside=path.join(root,'outside');fs.mkdirSync(outside);const secret=path.join(outside,'画像.lnk');fs.writeFileSync(secret,'outside');proofs.set(secret,proof);const junction=path.join(dest,'junction');fs.symlinkSync(outside,junction,'junction');
 r=await m.findMissing({oldPath:old,boardFolder:board,roots:[junction],probe});eq(r.candidates.length,0);ok(r.errors.some(e=>e.reason==='reparse-path-refused'));
 await assert.rejects(m.repairReference({boardFolder:board,oldPath:old,newPath:path.join(junction,'画像.lnk'),expectedRevision:g.revision(g.readRaw(board)),expectedCandidate:proof,probe,confirmedByUser:true}),/reparse/);checks++;
 fs.unlinkSync(junction);
 fs.writeFileSync(path.join(base,m.HISTORY),'{broken');assert.throws(()=>m.loadHistory(base));checks++;
 // Remove only this newly generated, verified TEMP root.
 ok(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('okiba-rescue-test-'));fs.rmSync(root,{recursive:true,force:true});
 console.log('material-rescue: '+checks+' checks PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
