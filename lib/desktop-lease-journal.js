'use strict';
const {durableRename}=require('./durable-rename');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function createLeaseJournal(dir){
 dir=path.resolve(dir);fs.mkdirSync(dir,{recursive:true});
 const file=token=>{if(!/^[a-f0-9]{32}$/.test(token))throw Error('invalid-journal-token');return path.join(dir,token+'.json');};
 return {dir,write(record){const dest=file(record.token),tmp=dest+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}durableRename(tmp,dest);let d;try{d=fs.openSync(dir,'r');fs.fsyncSync(d);}catch(e){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','EBADF','EACCES'].includes(e.code))throw e;}finally{if(d!==undefined)fs.closeSync(d);}return dest;},
 pending(){const names=fs.readdirSync(dir);if(names.some(n=>n.endsWith('.tmp')))throw Error('unresolved-journal-temp');const records=names.filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>{const r=JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));if(n!==r.token+'.json')throw Error('journal-token-mismatch');return r;});const terminal=records.filter(r=>['released','aborted'].includes(r.phase)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));for(const r of terminal.slice(10))fs.unlinkSync(file(r.token));return records.filter(r=>!['released','aborted'].includes(r.phase));}};
}
module.exports={createLeaseJournal};
