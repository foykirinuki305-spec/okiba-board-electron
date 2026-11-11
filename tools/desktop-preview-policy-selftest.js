'use strict';
// Pure policy and actual helper factory VM tests: no process launch or Desktop IO.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const policy=require('../lib/desktop-preview-policy');let n=0;const ok=v=>{assert(v);n++;};
for(const isPackaged of [false,true])for(const platform of ['win32','linux'])for(const flag of [undefined,'','0','1','true'])ok(policy.enabled({isPackaged,platform,env:{OKIBA_DESKTOP_SAFE_PREVIEW:flag}})===(isPackaged&&platform==='win32'&&flag==='1'));
const dirty={OKIBA_DESKTOP_SAFE_PREVIEW:'1',OKIBA_TEST_HOOKS:'1',OKIBA_TEST_HELPER:'fake',OKIBA_TEST_SNAPSHOT:'{}',OKIBA_FAKE_LEASE:'1',OKIBA_UNKNOWN_GRID_CI:'1',OKIBA_MIXED_FAULT:'kill',OKIBA_HELPER_MODE:'off',OKIBA_SNAP_LEASE:'1',PATH:'kept'};
const cleaned=policy.nativeEnv(dirty);ok(cleaned.PATH==='kept'&&cleaned.OKIBA_DESKTOP_SAFE_PREVIEW==='1');ok(dirty.OKIBA_TEST_HELPER==='fake');for(const k of Object.keys(dirty).filter(k=>k!=='PATH'&&k!=='OKIBA_DESKTOP_SAFE_PREVIEW'))ok(cleaned[k]==='');
const aliases={okiba_test_helper:'fake',OkIbA_FaKe_Lease:'1',okiba_snap_lease:'bad',OKIBA_SNAP_LEASE:'bad2',OkIbA_Helper_Mode:'off'};
const sanitized=policy.nativeEnv(aliases);
for(const key of Object.keys(aliases)){ok(sanitized[key]==='');ok(sanitized[key.toUpperCase()]==='');}
// Watchdog overlays dedicated native flag last. Windows spawn uses the first
// lexicographically sorted spelling for duplicate case-insensitive env keys.
const effective={...aliases,...sanitized,OKIBA_SNAP_LEASE:'1'},seen=new Set(),windows={};
for(const key of Object.keys(effective).sort()){const k=key.toUpperCase();if(!seen.has(k)){seen.add(k);windows[k]=effective[key];}}
ok(windows.OKIBA_SNAP_LEASE==='1');ok(windows.OKIBA_TEST_HELPER==='');ok(windows.OKIBA_FAKE_LEASE==='');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const leaseFactory=source.slice(source.indexOf('  function leaseClient(){'),source.indexOf('  const desktopCalibration ='));
const shellFactory=source.slice(source.indexOf('  function createShellHelper() {'),source.indexOf('  shellHelper = createShellHelper();'));
for(const preview of [false,true]){
 let captured;
 const ctx={desktopLeaseClient:null,desktopLeasePending:false,leasePreview:()=>preview,unknownLeasePreview:()=>false,leaseOptIn:()=>true,process:{env:dirty,platform:'win32',execPath:'electron.exe',pid:123},path,app:{getPath:()=>'/private',once:()=>{}},__dirname:'/app',bundledScriptPath:()=>'/installed/scripts/shell-helper.ps1',desktopPreviewPolicy:policy,
 require:()=>({createDesktopLeaseClient:options=>{captured=options;return {};}})};
 vm.runInNewContext(leaseFactory+';leaseClient();',ctx);
 if(preview){ok(captured.helper.command==='powershell.exe');ok(!captured.helper.args.some(a=>String(a).includes('fake-helper')));ok(captured.helper.env.OKIBA_TEST_HELPER==='');}
 else ok(captured.helper.command==='electron.exe');
 captured=undefined;
 ctx.fs={existsSync:()=>true};ctx.sh={createShellHelperClient:options=>{captured=options;return {};}};
 const result=vm.runInNewContext(shellFactory+';createShellHelper();',ctx);
 if(preview){ok(captured.command==='powershell.exe');ok(captured.env.OKIBA_TEST_HOOKS==='');}
 else ok(result===null); // Existing helper-mode off behavior is untouched.
}
const transaction=source.slice(source.indexOf('  async function safeDesktopMove('),source.indexOf("  ipcMain.handle('safe-takeout'"));
ok(transaction.indexOf("if(leasePreview()&&!leaseTransaction)return desktopBlocked('safe-preview-scope-not-supported')")<transaction.indexOf('const tx=leaseTransaction||await safeDesk.executeDesktop'));
console.log('desktop preview policy/native helper isolation '+n+' checks PASS');

for(const isPackaged of [false,true])for(const platform of ['win32','linux'])for(const safe of [undefined,'0','1','true'])for(const unknown of [undefined,'0','1','true'])assert.equal(policy.unknownEnabled({isPackaged,platform,env:{OKIBA_DESKTOP_SAFE_PREVIEW:safe,OKIBA_DESKTOP_UNKNOWN_PREVIEW:unknown}}),isPackaged&&platform==='win32'&&safe==='1'&&unknown==='1');
console.log('unknown preview strict opt-in 64 cases PASS');
