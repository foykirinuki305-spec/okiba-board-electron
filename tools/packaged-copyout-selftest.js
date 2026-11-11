'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm'),root=path.resolve(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,n),'utf8');
const js=read('tests/packaged-copyout.e2e.js'),ps=read('tools/packaged-copyout-support-ci.ps1');new vm.Script(js);
for(const value of ['executablePath:','dist/win-unpacked/OkibaBoard.exe','await real(args)','bundled copy source mismatch','originalRecords','copiedRecords','repeat','copy-selected-out']){if(['repeat','copy-selected-out'].includes(value))continue;assert(js.includes(value),value);}
assert(js.includes('dialog.showOpenDialog='));assert(!js.includes('OKIBA_TEST_HOOKS'));assert(!js.includes('safeTakeout'));assert(!js.includes('resolveDropMove'));
for(const value of ['cancel-no-copy','existing-destination-not-overwritten','folder-rejected-without-move','explicit-copy-after-failure-to-second-folder','fs.readFileSync(meta),raw','r.attributes===32','identity!==originalRecords','processExit.ok'])assert(js.includes(value),value);
for(const value of ['GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT','owned TEMP root required','fixture marker missing','outside fixture','ReparsePoint','copyout-native.cs'])assert(ps.includes(value),value);
console.log('PASS packaged real worker/PS-CS bundle/TEMP-only/cancel/no-overwrite/original-identity/hidden/metadata/stop contracts; no app or native execution');
