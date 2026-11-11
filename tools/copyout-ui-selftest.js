'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),ui=require('../lib/copyout-ui');
const folder=path.resolve('isolated-board'),resident=path.join(folder,'clip.mp4'),linked=path.resolve('isolated-original.mp4'),payload={boardName:'Board',paths:[resident],linkedPaths:[linked]},state={folder,entries:[{name:'clip.mp4'}],links:[{path:linked,unknown:'preserve'}]};
(async()=>{
assert.deepEqual(ui.selectedSources(payload,state),[resident,linked]);
assert.throws(()=>ui.selectedSources({...payload,paths:[linked]},state));
assert.throws(()=>ui.selectedSources({...payload,linkedPaths:[linked,linked]},state));
assert.throws(()=>ui.selectedSources({...payload,paths:['relative']},state));
let copies=0,reads=0,choiceCalls=0;const original=JSON.stringify(state);
const cancelled=ui.createCopyOutHandler({selectionState:()=>{reads++;return state;},chooseDirectory:async()=>{choiceCalls++;assert.equal(copies,0);return {canceled:true};},copyFiles:async()=>{copies++;}});
assert((await cancelled(payload)).cancelled);assert.equal(copies,0);assert.equal(choiceCalls,1);assert.equal(reads,1);
const selected=ui.createCopyOutHandler({selectionState:()=>state,chooseDirectory:async()=>({canceled:false,filePaths:[path.resolve('isolated-dest')]}),copyFiles:async args=>{copies++;assert.deepEqual(args.sources,[resident,linked]);return {copied:[{src:resident,dest:path.join(args.destDir,'clip.mp4')}],skipped:[{src:linked,reason:'destination-exists'}],failed:[]};}});
const success=await selected(payload);assert.equal(copies,1);assert.equal(success.copied.length,1);assert(success.message.includes('スキップ 1件'));assert.equal(JSON.stringify(state),original);
let live=state;const changed=ui.createCopyOutHandler({selectionState:()=>live,chooseDirectory:async()=>{live={...state,links:[]};return {filePaths:['unused']};},copyFiles:()=>{throw Error('must not copy');}});assert.equal((await changed(payload)).error,'selection-no-longer-in-board');
const forbidden=path.resolve('isolated-desktop'),publicDesktop=path.resolve('isolated-public-desktop'),alias=path.resolve('desktop-alias');
for(const destination of [forbidden,publicDesktop,alias]){let called=false;const handler=ui.createCopyOutHandler({selectionState:()=>state,chooseDirectory:async()=>({filePaths:[destination]}),copyFiles:async()=>{called=true;},forbiddenDestinations:()=>[forbidden,publicDesktop],canonicalDirectory:p=>p===alias?forbidden:p});assert((await handler(payload)).error.includes('デスクトップ直下'));assert(!called);}
let subfolderCopied=false;const nested=ui.createCopyOutHandler({selectionState:()=>state,chooseDirectory:async()=>({filePaths:[path.join(forbidden,'folder')]}),copyFiles:async()=>{subfolderCopied=true;return {copied:[],skipped:[],failed:[]};},forbiddenDestinations:()=>[forbidden,publicDesktop]});await nested(payload);assert(subfolderCopied);
let release;const held=ui.createCopyOutHandler({selectionState:()=>state,chooseDirectory:()=>new Promise(r=>{release=r;}),copyFiles:()=>{throw Error('unexpected');}}),first=held(payload);assert.equal((await held(payload)).error,'copy-already-running');release({canceled:true});await first;
const partial=ui.copySummary({copied:[],skipped:[],failed:[{src:linked,reason:'visibility-unverified',partialPath:'own-dest'}]});assert(partial.includes('コピー完了 0件'));assert(partial.includes('未完了 1件'));assert(partial.includes('再実行しない'));
assert(ui.copySummary({copied:[],partial:[{src:linked,reason:'unknown',partialPath:'owned-partial'}]}).includes('未完了 1件'));assert(ui.copySummary({copied:[],failed:[{src:linked}],unresolved:true}).includes('確認するまで再実行しない'));
const moved={moved:[linked],failed:[]};ui.noteMovedVisibility(moved,linked,{moved:true,unhidden:false,dest:'dest'});assert.deepEqual(moved.moved,[linked]);assert.deepEqual(moved.failed,[]);assert.equal(moved.partial[0].moved,true);assert(moved.warningText.includes('移動済み'));const clean={moved:[resident]};ui.noteMovedVisibility(clean,resident,{moved:true,unhidden:true});assert(!clean.partial);
const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),renderer=fs.readFileSync(path.join(__dirname,'../renderer/app.js'),'utf8'),preload=fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8');
assert(main.includes("properties:['openDirectory']"));assert(main.includes("defaultPath:app.getPath('desktop')"));assert(main.includes("copyUi.noteMovedVisibility(result,lp,one)"));assert(preload.includes("ipcRenderer.invoke('copy-selected-out', payload)"));
assert.equal(renderer.split("label: '原本を残してコピー…'").length-1,3);
const body=renderer.slice(renderer.indexOf('async function copySelectionOut()'),renderer.indexOf('async function takeOutSelection()'));assert(!body.includes('persistBoard'));assert(!body.includes('refreshBoard'));assert(!body.includes('cells.delete'));
const selection=new Set(['file:clip.mp4','link:'+linked,'note:one']),boardData={name:'Board',unknown:{keep:1}},before=JSON.stringify({selection:[...selection],boardData}),toasts=[];
const context={selection,boardData,pathOfKey:()=>resident,api:{copySelectedOut:async p=>{assert.deepEqual(JSON.parse(JSON.stringify(p)),payload);return {message:'copy-report'};}},toast:t=>toasts.push(t)};vm.createContext(context);vm.runInContext(body,context);await context.copySelectionOut();assert.deepEqual(toasts,['保存先のフォルダを選んでください。原本は残ります。','copy-report']);assert.equal(JSON.stringify({selection:[...selection],boardData}),before);
console.log('PASS copy UI membership/cancel/no-side-effect/choice recheck/concurrency/partial visibility and renderer VM regressions');
})().catch(e=>{console.error(e);process.exitCode=1;});
