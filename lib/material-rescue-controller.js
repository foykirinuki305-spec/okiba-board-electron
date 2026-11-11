'use strict';
const crypto=require('crypto'),path=require('path');
const rescue=require('./material-rescue'),guard=require('./board-save-guard');
const TTL=5*60*1000,MAX_TOKENS=50;
const key=p=>path.resolve(p).toLowerCase();
function createController({base,guardBoard,roots,probe,notify=()=>{},isBusy=()=>false,withLock}){
 if(typeof base!=='string'||!path.isAbsolute(base)||[guardBoard,roots,probe,withLock].some(f=>typeof f!=='function'))throw Error('invalid-rescue-controller');
 const tokens=new Map();let finding=false;
 function prune(){const now=Date.now();for(const [t,v] of tokens)if(v.expires<=now)tokens.delete(t);}
 async function checkedBoard(name){const folder=await guardBoard(name);if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('invalid-rescue-board');return folder;}
 async function find(boardName,oldPath){
  if(typeof oldPath!=='string'||!path.isAbsolute(oldPath)||oldPath.includes('\0'))throw Error('invalid-rescue-path');
  if(finding)throw Error('rescue-search-busy');finding=true;
  try{
   const boardFolder=await checkedBoard(boardName);if(await isBusy(boardFolder))throw Error('rescue-board-busy');
   const raw=guard.readRaw(boardFolder);if(raw===null)throw Error('rescue-board-missing');const data=JSON.parse(raw);
   if(!Array.isArray(data.links)||data.links.filter(l=>typeof l?.path==='string'&&key(l.path)===key(oldPath)).length!==1)throw Error('rescue-link-not-unique');
   const expectedRevision=guard.revision(raw);
   const result=await rescue.findMissing({oldPath,boardFolder,roots:await roots(boardFolder,oldPath),history:rescue.loadHistory(base),probe});
   if(guard.readRaw(boardFolder)!==raw)return {...result,status:'board-changed',candidates:[]};
   prune();for(const [t,v] of tokens)if(key(v.boardFolder)===key(boardFolder)&&key(v.oldPath)===key(oldPath))tokens.delete(t);
   const candidates=result.candidates.slice(0,MAX_TOKENS).map(c=>{
    while(tokens.size>=MAX_TOKENS)tokens.delete(tokens.keys().next().value);
    const token=crypto.randomBytes(24).toString('hex');tokens.set(token,{boardName,boardFolder,oldPath,newPath:c.path,expectedCandidate:{...c.proof},expectedRevision,expires:Date.now()+TTL});
    return {token,path:c.path,match:c.match,reason:c.reason,hidden:c.hidden};
   });
   return {...result,candidates,truncated:result.truncated||result.candidates.length>MAX_TOKENS};
  }finally{finding=false;}
 }
 // Only the explicit UI action selecting a returned token should call repair.
 async function repair(token){
  prune();if(typeof token!=='string'||!tokens.has(token))throw Error('rescue-token-expired');
  const item=tokens.get(token);if(await isBusy(item.boardFolder))throw Error('rescue-board-busy');
  return withLock(item.boardFolder,async()=>{
   prune();if(tokens.get(token)!==item)throw Error('rescue-token-expired');
   const boardFolder=await checkedBoard(item.boardName);if(key(boardFolder)!==key(item.boardFolder))throw Error('rescue-board-changed');
   if(await isBusy(boardFolder))throw Error('rescue-board-busy');
   tokens.delete(token); // One attempt only; a changed candidate needs a new search.
   const result=await rescue.repairReference({...item,probe,confirmedByUser:true});
   if(result.saved){for(const [t,v] of tokens)if(key(v.boardFolder)===key(boardFolder))tokens.delete(t);try{await notify(boardFolder);}catch(e){return {...result,notificationFailed:true};}}
   return result;
  });
 }
 return {find,repair};
}
module.exports={createController,TTL,MAX_TOKENS};
