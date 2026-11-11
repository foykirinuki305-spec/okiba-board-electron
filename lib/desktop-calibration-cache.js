'use strict';
const fs=require('fs'),path=require('path');
const MAX_BYTES=1024*1024,MAX_ENTRIES=4;
function validate(value){return value&&value.version===1&&Array.isArray(value.entries)&&value.entries.length<=MAX_ENTRIES&&value.entries.every(e=>e&&typeof e==='object'&&!Array.isArray(e));}
function load(file){try{const st=fs.statSync(file);if(!st.isFile()||st.size>MAX_BYTES)return null;const value=JSON.parse(fs.readFileSync(file,'utf8'));return validate(value)?{version:1,entries:value.entries}:null;}catch{return null;}}
function save(file,value){
 if(!validate(value))return false;
 let encoded;try{encoded=JSON.stringify({version:1,entries:value.entries});}catch{return false;}
 if(Buffer.byteLength(encoded,'utf8')>MAX_BYTES)return false;
 const tmp=file+'.'+process.pid+'-'+Date.now()+'.tmp';
 try{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(tmp,encoded,{encoding:'utf8',flag:'wx'});fs.renameSync(tmp,file);return true;}
 catch{return false;}finally{try{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catch{}}
}
module.exports={load,save,validate,MAX_BYTES,MAX_ENTRIES};
