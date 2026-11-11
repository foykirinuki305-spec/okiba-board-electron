 'use strict';
const path=require('path');
const fs=require('fs');
const {spawn}=require('child_process');
const {StringDecoder}=require('string_decoder');
function asciiJson(value){return JSON.stringify(value).replace(/[\u0080-\uffff]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));}
// Only explicitly selected files. No board metadata or source mutations.
async function copyFilesOut({sources,destDir,scriptPath,spawnImpl=spawn,canonicalize=fs.realpathSync.native}){
 if(!Array.isArray(sources)||!sources.length||sources.length>1000||sources.some(x=>typeof x!=='string'||!path.isAbsolute(x))||typeof destDir!=='string'||!path.isAbsolute(destDir))throw Error('copy-invalid-request');
 if(new Set(sources.map(x=>path.resolve(x).toLowerCase())).size!==sources.length)throw Error('copy-duplicate-source');
 if(process.platform!=='win32')throw Error('copy-windows-only');
 const requestLine=asciiJson({sources,destDir});if(requestLine.length>1048576)throw Error('copy-request-overflow');
 const result={copied:[],skipped:[],failed:[],partial:[]};
 const script=scriptPath||path.join(__dirname,'..','scripts','copyout.ps1');
 return new Promise(resolve=>{
  let out='',err='',bad=false,child,settled=false;const decoder=new StringDecoder('utf8');
  const uncertain=reason=>{if(settled)return;settled=true;result.failed=sources.map(src=>({src,reason,unresolved:true}));result.unresolved=true;resolve(result);};
  try{child=spawnImpl('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(e){return uncertain('copy-worker-start-failed:'+e.message);}
  child.stdout.on('data',b=>{if(out.length+b.length>4*1024*1024){bad=true;return;}out+=decoder.write(b);});
  child.stderr.on('data',b=>{if(err.length<4096)err+=b.toString('utf8');});
  child.on('error',e=>uncertain('copy-worker-error:'+e.message));
  child.on('close',code=>{
   if(settled)return;try{
    out+=decoder.end();if(bad)throw Error('copy-response-overflow');const data=JSON.parse(out.replace(/^\uFEFF/,''));
    if(code!==0||!data.ok||!Array.isArray(data.results)||data.results.length!==sources.length)throw Error(data.reason||'copy-worker-incomplete');
    data.results.forEach((r,i)=>{
     if(!r||r.src!==sources[i])throw Error('copy-response-mismatch:source');
     if(typeof r.copied!=='boolean'||typeof r.skipped!=='boolean'||typeof r.cleanupVerified!=='boolean')throw Error('copy-response-mismatch:flags');
     if(r.copied){
      if(r.skipped||!r.cleanupVerified||r.partialPath)throw Error('copy-response-mismatch:completion');
      if(typeof r.sha256!=='string'||!/^[0-9A-F]{64}$/.test(r.sha256))throw Error('copy-response-mismatch:hash');
      // Compare actual filesystem spellings only here. Never rewrite worker inputs:
      // doing so would erase a reparse ancestor before native rejects it.
      const canonicalFolder=canonicalize(destDir),canonicalSource=canonicalize(sources[i]);
      const expected=path.resolve(canonicalFolder,path.basename(canonicalSource));
      if(typeof r.dest!=='string'||path.resolve(canonicalize(r.dest)).toLowerCase()!==expected.toLowerCase())throw Error('copy-response-mismatch:destination');
     }
    });
    for(const r of data.results){if(r.copied)result.copied.push(r);else if(r.skipped)result.skipped.push(r);else if(!r.cleanupVerified||r.partialPath)result.partial.push(r);else result.failed.push(r);}
    settled=true;resolve(result);
   }catch(e){uncertain(e.message);}
  });
  child.stdin.on('error',()=>{});child.stdin.end(requestLine+'\n');
 });
}
module.exports={copyFilesOut,asciiJson};
