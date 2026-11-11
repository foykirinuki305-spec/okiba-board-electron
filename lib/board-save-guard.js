'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const filename=folder=>path.join(folder,'.okiba-board.json');
function readRaw(folder){try{return fs.readFileSync(filename(folder),'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function revision(raw){return crypto.createHash('sha256').update(raw===null?'missing\0':'present\0'+raw).digest('hex');}
function loadSnapshot(folder,load){for(let n=0;n<3;n++){const raw=readRaw(folder),data=load(folder);if(raw===readRaw(folder))return {data,revision:revision(raw)};}throw Error('board-changing-during-load');}
function save(folder,{positions,notes,sizePercent,links,expectedRevision},{allowMissingRevision=false}={}){
 const raw=readRaw(folder),currentRevision=revision(raw),conflict=()=>({saved:false,conflict:true,currentRevision:revision(readRaw(folder))});
 if(expectedRevision!==currentRevision&&!(allowMissingRevision&&expectedRevision===undefined))return conflict();
 const old=raw===null?{}:JSON.parse(raw);if(!old||typeof old!=='object'||Array.isArray(old))throw Error('invalid-board-metadata');
 if(!positions||typeof positions!=='object'||Array.isArray(positions)||!Array.isArray(notes)||!Array.isArray(links))throw Error('invalid-board-save');
 const cell=(v,nullable=false)=>{if(nullable&&(v===null||v===undefined))return null;if(!Number.isInteger(v)||v<0)throw Error('invalid-board-cell');return v;};
 const oldLinks=new Map((old.links||[]).filter(l=>typeof l?.path==='string').map(l=>[path.resolve(l.path).toLowerCase(),l]));
 const seen=new Set(),nextLinks=links.map(l=>{if(!l||typeof l.path!=='string'||!path.isAbsolute(l.path))throw Error('invalid-link');const k=path.resolve(l.path).toLowerCase();if(seen.has(k))throw Error('duplicate-link');seen.add(k);const prev=oldLinks.get(k);if(!prev&&!allowMissingRevision)throw Error('link-not-in-current-board');return {...prev,path:l.path,wasHidden:prev?!!prev.wasHidden:!!l.wasHidden,col:cell(l.col,true),row:cell(l.row,true)};});
 const oldNotes=new Map((old.notes||[]).map(n=>[n.id,n]));
 const nextPositions=Object.fromEntries(Object.entries(positions).map(([name,c])=>{if(!Array.isArray(c)||c.length!==2)throw Error('invalid-position');return [name,{...(old.positions?.[name]||{}),col:cell(c[0]),row:cell(c[1])}];}));
 let percent=parseInt(sizePercent,10);if(Number.isNaN(percent))percent=100;percent=Math.max(10,Math.min(percent,200));
 const data={...old,version:old.version||6,size_percent:percent,positions:nextPositions,links:nextLinks,notes:notes.map(n=>{if(!n||typeof n.id!=='string'||typeof n.text!=='string')throw Error('invalid-note');return {...oldNotes.get(n.id),id:n.id,text:n.text,col:cell(n.col),row:cell(n.row)};})};
 const next=JSON.stringify(data,null,2),target=filename(folder),tmp=target+'.tmp-'+crypto.randomBytes(8).toString('hex');
 const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,next);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{if(readRaw(folder)!==raw)return conflict();fs.renameSync(tmp,target);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {saved:true,conflict:false,revision:revision(next)};
}
module.exports={save,loadSnapshot,readRaw,revision};
