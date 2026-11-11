'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const {buildMixedCopy,ownedCopyDestination}=require('./mixed-lease-copy-builder'),{generateMixedDriver}=require('./mixed-lease-driver-builder');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-mixed-copy-pure-')),copy=path.join(temp,'runtime');
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const originals=['lib/desktop-snap-lease-controller.js','lib/desktop-lease-watchdog.js','scripts/snap-lease.ps1','scripts/shell-helper.ps1'].map(p=>[p,digest(path.join(root,p))]);
try{
 assert.throws(()=>ownedCopyDestination(path.join(root,'runtime')),/owned canonical TEMP/);
 assert.throws(()=>ownedCopyDestination(path.join(temp,'not-runtime')),/owned TEMP runtime/);
 const canonical=path.join(fs.realpathSync.native(temp),'runtime');assert.equal(ownedCopyDestination(copy),canonical);
 if(process.platform==='win32'){
  const code='Add-Type -TypeDefinition \'using System;using System.Text;using System.Runtime.InteropServices;public static class MixedShortPath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode)]public static extern uint GetShortPathName(string p,StringBuilder b,uint n);}\';$b=New-Object Text.StringBuilder 32768;$n=[MixedShortPath]::GetShortPathName($env:OKIBA_SHORT_PARENT,$b,32768);if($n -eq 0){throw "short path unavailable"};$b.ToString()';
  const short=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,OKIBA_SHORT_PARENT:temp},encoding:'utf8'}).trim();assert.equal(ownedCopyDestination(path.join(short,'runtime')),canonical);
 }
 const junction=path.join(path.dirname(temp),'okiba-mixed-copy-pure-'+crypto.randomBytes(8).toString('hex'));
 try{fs.symlinkSync(temp,junction,process.platform==='win32'?'junction':'dir');assert.throws(()=>ownedCopyDestination(path.join(junction,'runtime')),/real owned directory/);}finally{try{if(fs.lstatSync(junction).isSymbolicLink())fs.unlinkSync(junction);}catch(e){if(e.code!=='ENOENT')throw e;}}
 fs.symlinkSync(temp,copy,process.platform==='win32'?'junction':'dir');try{assert.throws(()=>ownedCopyDestination(copy),/already exists/);}finally{assert(fs.lstatSync(copy).isSymbolicLink());fs.unlinkSync(copy);}
 buildMixedCopy(copy);generateMixedDriver(copy,path.join(__dirname,'resident-lease-ci.js'));
 for(const f of ['lib/desktop-snap-lease-controller.js','lib/desktop-lease-watchdog.js','tools/mixed-driver-ci.js','tools/desktop-lease-protocol-host-ci.js'])execFileSync(process.execPath,['--check',path.join(copy,f)]);
 if(process.platform==='win32')for(const file of ['snap-lease.ps1','mixed-lease-native-ci.ps1','shell-helper.ps1'])execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:OKIBA_PARSE_FILE,[ref]$t,[ref]$e);if($e.Count){$e|ConvertTo-Json -Depth 5;exit 1};exit 0"],{windowsHide:true,env:{...process.env,OKIBA_PARSE_FILE:path.join(copy,'scripts',file)}});
 const driver=fs.readFileSync(path.join(copy,'tools/mixed-driver-ci.js'),'utf8');assert(driver.includes("'success32','abort-placed','abort-after-restore','fault-first-move','fault-first-reveal','hang-first-move','owner-death','success-dense','cached-destination','show-hidden-mid-stage'"));assert(driver.includes('length:6'));assert(driver.includes('mode:i.mode'));assert(driver.includes('ShowHidden ON unsupported'));assert(driver.includes('policy.stage.linkCount===3'));assert(driver.includes('Lease must not reset external ShowHidden'));assert(driver.includes("const anchor='# CI-MIXED-AFTER-FIRST-STAGE'"));
 const injectedMatch=driver.match(/const injected=`([\s\S]*?)`;/);assert(injectedMatch);const showInjection=injectedMatch[1].replace('${toggle}',"$proof.setting=[OkibaShowHiddenFixture]::SetForCI($false,$true)");assert(!showInjection.includes('${'));
 const showCopy=path.join(copy,'scripts','show-injection-parse.ps1');fs.writeFileSync(showCopy,fs.readFileSync(path.join(copy,'scripts/mixed-lease-native-ci.ps1'),'utf8').replace('# CI-MIXED-AFTER-FIRST-STAGE','# CI-MIXED-AFTER-FIRST-STAGE'+showInjection));
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:OKIBA_PARSE_FILE,[ref]$t,[ref]$e);if($e.Count){$e|ConvertTo-Json -Depth 5;exit 1};exit 0"],{windowsHide:true,env:{...process.env,OKIBA_PARSE_FILE:showCopy}});
 const native=fs.readFileSync(path.join(copy,'scripts/snap-lease.ps1'),'utf8');for(const n of ['ValidateRecovery','Prepare','RevealPlace','RestoreVerify','Rollback','Release'])assert(native.includes('function Lease-'+n+'-CoreMixedBase('));
 const c=require(path.join(copy,'lib/desktop-snap-lease-controller.js'));
 const snapshot={ok:true,identityVersion:1,autoArrange:false,snap:true,icons:[],areas:[{left:0,top:0,right:800,bottom:600,grid:{gx:0,gy:0,sx:100,sy:70}}]};
 const scope={kind:'mixed-hidden-resident-prototype',desktop:'C:\\Desktop',snapshot,targetAreaIndex:0,metadataPaths:['C:\\Board\\meta.json'],items:[{mode:'hidden-link',path:'C:\\Desktop\\a.txt',destination:'C:\\Desktop\\a.txt',hidden:true,fileIdentity:'a'},{mode:'resident-file',path:'C:\\Board\\b.txt',destination:'C:\\Desktop\\b.txt',fileIdentity:'b'}]};
 assert(c.validateScope(scope));assert(!c.validateScope({...scope,items:[scope.items[0]]}));assert(!c.validateScope({...scope,items:[scope.items[0],{...scope.items[1],destination:scope.items[0].path}]}));
 assert.throws(()=>buildMixedCopy(copy),/already exists/);
 for(const [f,hash]of originals)assert.equal(digest(path.join(root,f)),hash,'Production source changed');
 console.log('mixed copy builder PASS: native not invoked; 10-case driver, scope rejection, source hashes preserved');
}finally{assert(path.basename(temp).startsWith('okiba-mixed-copy-pure-'));fs.rmSync(temp,{recursive:true,force:true});}
