'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {validateScope}=require('../lib/desktop-snap-lease-controller');
const snap={ok:true,identityVersion:1,autoArrange:false,snap:true,icons:[],areas:[{left:0,top:0,right:800,bottom:600,grid:{gx:0,gy:0,sx:100,sy:70}}]};
const link={mode:'hidden-link',path:'C:\\Desktop\\a.txt',destination:'C:\\Desktop\\a.txt',hidden:true,fileIdentity:'A:01'},resident={mode:'resident-file',path:'C:\\Board\\b.txt',destination:'C:\\Desktop\\b.txt',fileIdentity:'A:02'};
const scope={kind:'mixed-hidden-resident',desktop:'C:\\Desktop',snapshot:snap,targetAreaIndex:0,metadataPaths:['C:\\Board\\meta.json'],items:[resident,link]};let checks=0;
const old=process.env.OKIBA_MIXED_LEASE;
(async()=>{try{
 delete process.env.OKIBA_MIXED_LEASE;assert(!validateScope(scope));checks++;
 process.env.OKIBA_MIXED_LEASE='1';assert(!validateScope(scope));assert(validateScope(scope,{allowMixed:true}));checks++;
 for(const items of [[resident],[link],[link,{...resident,fileIdentity:'a:01'}],[link,{...resident,path:link.path}],[link,{...resident,mode:'unknown'}],[{...link,hidden:false},resident]]){assert(!validateScope({...scope,items},{allowMixed:true}));checks++;}
 for(const [kind,items]of [['samepath-hidden',[link]],['resident-archive-samevolume',[resident]]]){delete process.env.OKIBA_MIXED_LEASE;assert(validateScope({...scope,kind,items}));process.env.OKIBA_MIXED_LEASE='1';assert(validateScope({...scope,kind,items}));checks++;}
 const code=fs.readFileSync(path.join(__dirname,'../lib/desktop-lease-watchdog.js'),'utf8'),a=code.indexOf(" if(method==='prepareScope'&&args[0]?.kind==='mixed-hidden-resident')"),b=code.indexOf(" if(method==='prepareScope'){",a);assert(a>=0&&b>a);
 const execute=new (Object.getPrototypeOf(async function(){}).constructor)('method','args','native','matchLeaseFileRecords','validateScope','config',code.slice(a,b));
 const calls=[],native=async(command,{paths})=>{calls.push({command,paths});return {records:paths.map(p=>({path:p,identity:p===link.path?'A:01':'A:02'}))};};
 const matcher=(items,records,unused,includeNative)=>items.map(i=>({...i,fileIdentity:records.find(r=>r.path===i.path).identity,...(includeNative?{nativeFile:{attributes:32}}:{})}));
 const result=await execute('prepareScope',[scope],native,matcher,validateScope,{allowMixed:true});assert(result.ok);assert.deepEqual(result.scope.items.map(i=>i.mode),['resident-file','hidden-link']);assert.equal(result.scope.items[0].nativeFile.attributes,32);assert.equal(result.scope.items[1].nativeFile.attributes,32);assert.deepEqual(calls.map(c=>c.command),['leaseReadResidentFiles','leaseReadResidentFiles']);checks++;
 delete process.env.OKIBA_MIXED_LEASE;let nativeCalls=0;await assert.rejects(execute('prepareScope',[scope],async()=>{nativeCalls++},matcher,validateScope,{allowMixed:false}),/disabled/);assert.equal(nativeCalls,0);checks++;
 process.env.OKIBA_MIXED_LEASE='1';await assert.rejects(execute('prepareScope',[{...scope,items:[link]}],native,matcher,validateScope,{allowMixed:true}));checks++;
 assert.equal((code.match(/active.scope.kind==='mixed-hidden-resident'\?'mixed-restored'/g)||[]).length,2);checks++;
 const actualMatcher=require('../lib/desktop-lease-file-records').matchLeaseFileRecords;
 const canonicalMatcher=(items,records,unused,includeNative)=>actualMatcher(items,records,p=>p.toLowerCase(),includeNative);
 const nativeRecords=async(command,{paths})=>({records:paths.map(p=>({path:p.toUpperCase(),identity:p===link.path?'A:01':'A:02',attributes:p===link.path?34:32,regularFile:true,reparse:false,linkCount:1})).reverse()});
 const verified=await execute('prepareScope',[scope],nativeRecords,canonicalMatcher,validateScope,{allowMixed:true});assert.deepEqual(verified.scope.items.map(i=>i.fileIdentity),['A:02','A:01']);assert.deepEqual(verified.scope.items.map(i=>i.nativeFile.attributes),[32,34]);checks++;
 const controller=require('../lib/desktop-snap-lease-controller');const refused=await controller.runLease({scope,receipts:[],adapter:new Proxy({},{get(){throw Error('adapter must not run')}})});assert.equal(refused.phase,'preflight');checks++;
 const envCode=code.slice(code.indexOf('function mixedHelperEnv('),code.indexOf('function makeHelper('));const buildEnv=new Function(envCode+';return mixedHelperEnv')();
 for(const enabled of [false,undefined,true,'1']){const env=buildEnv({OKIBA_MIXED_LEASE:'1',okiba_mixed_lease:'1'},{Okiba_Mixed_Lease:'1'},enabled);assert.equal(env.OKIBA_MIXED_LEASE,enabled===true?'1':'');assert.equal(Object.keys(env).filter(k=>/^OKIBA_MIXED_LEASE$/i.test(k)).length,1);checks++;}
 console.log('formal mixed dispatch '+checks+' PASS; no native calls');
 }finally{if(old===undefined)delete process.env.OKIBA_MIXED_LEASE;else process.env.OKIBA_MIXED_LEASE=old;}})().catch(e=>{console.error(e);process.exitCode=1});
