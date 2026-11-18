'use strict';
// D-resident board transactions. Existing C board/link data is read-only here.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const bf=require('./boardfs'),registry=require('./external-boards'),placement=require('./placement');
const {atomic}=require('./folder-return');
const key=p=>path.resolve(p).toLowerCase();
const overlap=(a,b)=>{a=key(a);b=key(b);return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);};
function createStorageBoardService({base,storageRoot,stagingRootForSource,onProgress=()=>{},engineFactory}){
 const transfers=(engineFactory||require('./storage-transfer').createStorageTransfer)({journalDir:storageRoot||path.join(path.dirname(base),'.okiba-storage-transfers'),stagingRootForSource,onProgress});
 let busy=false;
 function descriptor(id){const b=registry.resolve(base,id);if(!b||!b.external||b.missing||b.invalid)throw Error('D保管ボードを確認できません。保存先を確認してください。');return b;}
 function checkRecord(record){const m=record.metadata;if(!m||!['intake','return'].includes(m.mode)||typeof m.beforeRaw!=='string'||typeof m.afterRaw!=='string')throw Error('invalid-storage-metadata');const b=descriptor(m.boardId);if(key(b.folder)!==key(m.boardFolder))throw Error('storage-board-changed');JSON.parse(m.beforeRaw);JSON.parse(m.afterRaw);return path.join(b.folder,bf.BOARD_FILENAME);}
 function inspectCommit(record){try{const raw=fs.readFileSync(checkRecord(record),'utf8');return raw===record.metadata.afterRaw?'committed':raw===record.metadata.beforeRaw?'pending':'conflict';}catch(_){return 'conflict';}}
 function commit(record){const file=checkRecord(record),state=inspectCommit(record);if(state==='committed')return;if(state!=='pending')throw Error('ボードの変更が競合しました。素材は保護しています。');atomic(file,record.metadata.afterRaw);}
 function ensureUnshared(sources,own){const boards=[...bf.listBoards(base).map(id=>({id,folder:path.join(base,id)})),...registry.list(base)];for(const b of boards){if(b.missing||b.invalid)throw Error('確認できないボードがあります。共有素材の保護のため停止しました。');const p=path.join(b.folder,bf.BOARD_FILENAME);if(!fs.existsSync(p)){if(b.external)throw Error('board-metadata-missing');continue;}const data=JSON.parse(fs.readFileSync(p,'utf8'));for(const l of data.links||[])if(sources.some(src=>overlap(src,l.path)))throw Error('この素材は別のボードから参照されています。元の場所は変更していません。');if(b.id!==own&&sources.some(src=>overlap(src,b.folder)))throw Error('ボード自体や他のボードの素材は移動できません。');}}
 async function withLock(work){if(busy)throw Error('移動中です。完了まで待ってください。');busy=true;try{return await work();}finally{busy=false;}}
 async function recover(){return withLock(()=>transfers.recoverAll({commit,inspectCommit}));}
 async function run(mode,id,sources,destDir,opts={}){return withLock(async()=>{
  const recovery=await transfers.recoverAll({commit,inspectCommit});if(recovery?.blocked||recovery?.ok===false)throw Error('中断した移動の確認が必要です。履歴の元の場所と移動先を確認してください。');
  const b=descriptor(id);if(!Array.isArray(sources)||!sources.length)throw Error('素材を選んでください。');sources=sources.map(p=>path.resolve(p));if(mode==='return'&&sources.some(p=>key(path.dirname(p))!==key(b.folder)))throw Error('board-membership-mismatch');if(mode==='intake'&&sources.some(p=>overlap(p,b.folder)))throw Error('保存先と重なる素材は移動できません。');ensureUnshared(sources,id);
  const file=path.join(b.folder,bf.BOARD_FILENAME),beforeRaw=fs.readFileSync(file,'utf8'),data=JSON.parse(beforeRaw);data.positions=data.positions||{};
  if(mode==='intake'){
   const loaded=bf.loadBoard(b.folder),rows=opts.rows||8,anchor=opts.anchor||[0,0];const {occupied}=placement.computeCells({entries:bf.scanFolder(b.folder),positions:loaded.positions,notes:loaded.notes,links:loaded.links,rowsPerCol:rows});const cells=placement.placeItems({occupied,anchor,offsets:opts.offsets||null,count:sources.length,rowsPerCol:rows});sources.forEach((p,i)=>{data.positions[path.basename(p)]={col:cells[i][0],row:cells[i][1]};});
  }else sources.forEach(p=>delete data.positions[path.basename(p)]);
  const metadata={boardId:id,boardFolder:b.folder,mode,beforeRaw,afterRaw:JSON.stringify(data,null,2)};
  const result=await transfers.run({sources,destDir,metadata},{commit,inspectCommit});return {...result,boardId:id,mode};
 });}
 return {get busy(){return busy;},intake:(id,sources,opts)=>run('intake',id,sources,descriptor(id).folder,opts),takeout:(id,sources,dest)=>run('return',id,sources,dest),recover,status:()=>transfers.status(),inspectCommit,commit};
}
module.exports={createStorageBoardService};
