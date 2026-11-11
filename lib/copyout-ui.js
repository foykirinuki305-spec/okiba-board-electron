'use strict';
const path=require('path');
const key=p=>{if(typeof p!=='string'||!path.isAbsolute(p))throw Error('invalid-source-path');return path.resolve(p).toLowerCase();};
function selectedSources(payload,{folder,entries,links}){
 if(!payload||!Array.isArray(payload.paths)||!Array.isArray(payload.linkedPaths))throw Error('invalid-selection');
 const resident=new Set(entries.map(e=>key(path.join(folder,e.name)))),linked=new Set(links.map(l=>key(l.path)));
 const out=[],seen=new Set();
 for(const [values,allowed]of [[payload.paths,resident],[payload.linkedPaths,linked]])for(const value of values){const k=key(value);if(!allowed.has(k))throw Error('selection-no-longer-in-board');if(seen.has(k))throw Error('duplicate-source');seen.add(k);out.push(value);}
 if(!out.length)throw Error('no-files-selected');return out;
}
function copySummary(r){
 if(r.cancelled)return '';
 if(r.error)return 'コピーを開始できませんでした: '+r.error;
 const copied=r.copied||[],skipped=r.skipped||[],failed=r.failed||[],partial=r.partial||[];
 let text='コピー完了 '+copied.length+'件。原本・ボード配置は変更していません。';
 if(skipped.length)text+=' スキップ '+skipped.length+'件。';
 if(failed.length||partial.length)text+=' 未完了 '+(failed.length+partial.length)+'件。';
 if(r.unresolved||partial.length)text+=' 未完了のコピーが残っている可能性があります。保存先を確認するまで再実行しないでください。';
 const details=[...partial,...failed,...skipped].slice(0,3).map(i=>path.basename(i.src||'')+': '+(i.reason||'確認できません')+(i.partialPath?'（作成先に残っています: '+i.partialPath+'。確認前に再実行しないでください）':''));
 return text+(details.length?'\n'+details.join('\n'):'');
}
function createCopyOutHandler({selectionState,chooseDirectory,copyFiles,forbiddenDestinations=()=>[],canonicalDirectory=p=>path.resolve(p)}){
 let busy=false;
 return async payload=>{
  if(busy)return {copied:[],skipped:[],failed:[],error:'copy-already-running',message:'コピー処理中です。完了までお待ちください。'};
  busy=true;
  try{
   selectedSources(payload,selectionState(payload.boardName));
   const choice=await chooseDirectory();
   if(choice.canceled||!Array.isArray(choice.filePaths)||choice.filePaths.length!==1)return {cancelled:true,copied:[],skipped:[],failed:[]};
   const destKey=key(canonicalDirectory(choice.filePaths[0]));
   if(forbiddenDestinations().some(p=>key(canonicalDirectory(p))===destKey))throw Error('デスクトップ直下にはコピーできません。保存先のフォルダを選んでください。');
   const sources=selectedSources(payload,selectionState(payload.boardName));
   const result=await copyFiles({sources,destDir:choice.filePaths[0]});
   return {...result,message:copySummary(result)};
  }catch(e){const result={copied:[],skipped:[],failed:[],error:String(e.message||e)};return {...result,message:copySummary(result)};}
  finally{busy=false;}
 };
}
// A completed move must remain in moved even if visibility restoration failed.
function noteMovedVisibility(result,source,one){
 if(one.moved&&one.unhidden===false){
  (result.partial??=[]).push({path:source,dest:one.dest,reason:'destination-visibility-unverified',moved:true});
  result.warningText='移動済みですが、'+result.partial.length+'件の非表示属性を解除できませんでした。移動先を確認してください。元の操作を繰り返さないでください。';
 }
}
module.exports={selectedSources,copySummary,createCopyOutHandler,noteMovedVisibility};
