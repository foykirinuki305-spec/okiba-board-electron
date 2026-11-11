'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows only');
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),{buildMixedCopy}=require('./mixed-lease-copy-builder'),{generateMixedDriver}=require('./mixed-lease-driver-builder');
const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-mixed-runtime-'))),copy=path.join(temp,'runtime');let status=1;
try{if(process.env.OKIBA_FORMAL_MIXED_CI==='1'){require('./mixed-lease-formal-copy').buildFormalMixedCopy(copy);}else{buildMixedCopy(copy);generateMixedDriver(copy,path.join(__dirname,'resident-lease-ci.js'));}const r=spawnSync(process.execPath,[path.join(copy,'tools/mixed-driver-ci.js'),process.argv[2]],{stdio:'inherit',windowsHide:true,timeout:600000});status=r.status??1;if(r.error)console.error(r.error);}
finally{
 const trace=path.join(copy,'scripts/mixed-trace.jsonl');if(fs.existsSync(trace))fs.copyFileSync(trace,path.join(root,'mixed-trace.jsonl'));
 for(const name of ['mixed-lease-ci.json','mixed-lease-ci-journals','copy-manifest.json']){const f=path.join(copy,name);if(fs.existsSync(f))fs.cpSync(f,path.join(root,name),{recursive:true});}
 // Retain private runtime on uncertain recovery. Disposable runner cleanup only.
 const f=path.join(copy,'mixed-lease-ci.json');if(fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8')).cleanupVerified===true){assert.equal(fs.realpathSync.native(temp),temp);assert.equal(path.dirname(temp).toLowerCase(),fs.realpathSync.native(os.tmpdir()).toLowerCase());assert(/^okiba-mixed-runtime-[A-Za-z0-9]+$/.test(path.basename(temp)));assert(!fs.lstatSync(temp).isSymbolicLink());fs.rmSync(temp,{recursive:true,force:true});}
}
process.exitCode=status;
