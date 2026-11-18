'use strict';
const fs=require('fs'),path=require('path');
const bf=require('./boardfs'),registry=require('./external-boards'),engine=require('./storage-transfer');
const {atomic}=require('./folder-return');
const key=p=>path.resolve(p).toLowerCase();
const overlap=(a,b)=>{a=key(a);b=key(b);return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);};
function createBoardMigrationService({base,storageRoot,stagingRootForSource,onProgress=()=>{},engineFactory=engine.createStorageTransfer,checkpoint=async()=>{},freeBytes=p=>{const s=fs.statfsSync(p,{bigint:true});return s.bavail*s.bsize;}}){
 if(!storageRoot)throw Error('migration-storage-root-required');
 const transfer=engineFactory({journalDir:storageRoot,stagingRootForSource,onProgress});let busy=false;
 function descriptor(id){const b=registry.resolve(base,id);if(b.missing||b.invalid)throw Error('board-unavailable');return b;}
 function read(b){const file=path.join(b.folder,bf.BOARD_FILENAME),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('board-metadata-not-ordinary');const raw=fs.readFileSync(file,'utf8'),data=JSON.parse(raw);if(data.version!==6)throw Error('migration-requires-v6');return {id:b.id,folder:b.folder,identity:registry.validateDirectory(b.folder).identity,file,raw,data};}
 function recordSides(record){const m=record.metadata;if(m?.mode!=='board-migration'||!Array.isArray(m.boards)||m.boards.length!==2||m.boards[0].id===m.boards[1].id)throw Error('migration-metadata-invalid');return m.boards.map(s=>{const b=descriptor(s.id);if(key(b.folder)!==key(s.folder)||registry.validateDirectory(b.folder).identity!==s.identity)throw Error('migration-board-replaced');const x=read(b);JSON.parse(s.beforeRaw);JSON.parse(s.afterRaw);return {...s,file:x.file,current:x.raw};});}
 function inspectCommit(record){try{const sides=recordSides(record);if(sides.some(s=>s.current!==s.beforeRaw&&s.current!==s.afterRaw))return 'conflict';return sides.every(s=>s.current===s.afterRaw)?'committed':'pending';}catch(_){return 'conflict';}}
 async function commit(record){if(inspectCommit(record)==='conflict')throw Error('migration-metadata-conflict');for(let i=0;i<2;i++){const s=recordSides(record)[i];if(s.current===s.afterRaw)continue;if(inspectCommit(record)==='conflict')throw Error('migration-metadata-conflict');atomic(s.file,s.afterRaw);await checkpoint('metadata-'+i,record);}if(inspectCommit(record)!=='committed')throw Error('migration-commit-unverified');}
 async function plan(sourceId,destId){
  if(sourceId===destId)throw Error('same-board');const source=descriptor(sourceId),dest=descriptor(destId);if(source.external===dest.external)throw Error('migration-requires-C-D-pair');
  const a=read(source),b=read(dest);if(overlap(a.folder,b.folder))throw Error('board-overlap');
  const names=fs.readdirSync(a.folder).filter(n=>n!==bf.BOARD_FILENAME);
  if(fs.readdirSync(b.folder).some(n=>n!==bf.BOARD_FILENAME)||(b.data.links||[]).length||(b.data.notes||[]).length||Object.keys(b.data.positions||{}).length)throw Error('destination-not-empty');
  if(source.external&&(a.data.links||[]).length)throw Error('external-links-ambiguous');
  const items=names.map(n=>({src:path.join(a.folder,n),name:n,cell:a.data.positions?.[n]}));
  for(const l of a.data.links||[]){if(typeof l.path!=='string'||!path.isAbsolute(l.path))throw Error('invalid-link');items.push({src:l.path,name:path.basename(l.path),cell:{col:l.col,row:l.row},link:true});}
  if(!items.length)throw Error('no-materials-to-migrate');
  const usedNames=new Set(),cells=new Set(),sources=[];
  function claimCell(c){if(!c||!Number.isInteger(c.col)||!Number.isInteger(c.row)||c.col<0||c.row<0)throw Error('unsaved-or-invalid-position');const k=c.col+','+c.row;if(cells.has(k))throw Error('ambiguous-position-overlap');cells.add(k);}
  for(const item of items){if(usedNames.has(item.name.toLowerCase()))throw Error('basename-collision');usedNames.add(item.name.toLowerCase());claimCell(item.cell);if(sources.some(p=>overlap(p,item.src)))throw Error('duplicate-or-parent-child-source');if(overlap(item.src,b.folder))throw Error('source-destination-overlap');sources.push(item.src);}
  for(const name of Object.keys(a.data.positions||{}))if(!names.includes(name))throw Error('stale-or-ambiguous-position');
  const noteIds=new Set();for(const note of a.data.notes||[]){if(!note.id||noteIds.has(note.id))throw Error('ambiguous-note-id');noteIds.add(note.id);claimCell(note);}
  if(items.some(i=>i.link&&overlap(i.src,a.folder)))throw Error('linked-source-overlaps-own-board');
  const all=[...bf.listBoards(base).map(id=>descriptor(id)),...registry.list(base)];
  for(const board of all){if(board.missing||board.invalid)throw Error('shared-reference-check-unavailable');if(board.id===sourceId)continue;const other=read(board);if(sources.some(p=>overlap(p,board.folder)))throw Error('other-board-source');for(const l of other.data.links||[])if(sources.some(p=>overlap(p,l.path)))throw Error('shared-source-reference');}
  let bytes=0n;for(const p of sources){const tree=await engine.inspect(p,onProgress);for(const e of tree)bytes+=BigInt(e.size);}
  const requiredBytes=bytes+16n*1024n*1024n;if(BigInt(await freeBytes(b.folder))<requiredBytes)throw Error('insufficient-destination-space');
  const next={...a.data,positions:Object.fromEntries(items.map(i=>[i.name,i.cell])),links:[],notes:a.data.notes||[]};delete next.externalBoardId;if(b.data.externalBoardId)next.externalBoardId=b.data.externalBoardId;
  const empty={...a.data,positions:{},links:[],notes:[]};
  const metadata={mode:'board-migration',boards:[{id:b.id,folder:b.folder,identity:b.identity,beforeRaw:b.raw,afterRaw:JSON.stringify(next,null,2)},{id:a.id,folder:a.folder,identity:a.identity,beforeRaw:a.raw,afterRaw:JSON.stringify(empty,null,2)}]};
  return {sourceId,destId,sources,destDir:b.folder,items,bytes:String(bytes),requiredBytes:String(requiredBytes),metadata};
 }
 async function locked(fn){if(busy)throw Error('migration-busy');busy=true;try{return await fn();}finally{busy=false;}}
 async function migrate(sourceId,destId){return locked(async()=>{const r=await transfer.recoverAll({commit,inspectCommit});if(r?.ok===false||r?.blocked)throw Error('migration-recovery-required');const p=await plan(sourceId,destId);if(inspectCommit(p)!=='pending')throw Error('migration-plan-conflict');return transfer.run(p,{commit,inspectCommit});});}
 return {get busy(){return busy;},plan,migrate,recover:()=>locked(()=>transfer.recoverAll({commit,inspectCommit})),status:()=>transfer.status()};
}
module.exports={createBoardMigrationService};
