'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm'),r=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
const cs=r('shell-drag-loop-ci.cs'),ps=r('shell-drag-loop-ci.ps1'),js=r('shell-drop-native-ci.js');new vm.Script(js);
for(const s of ['DoDragDrop(data,new OkibaDropSourceCI(),2','SHCreateDataObject','Shell Object Offsets','new[]{x,y,0,0,sx,sy,2*sx,2*sy}','SetAsyncMode(false)','InOperation','Performed DropEffect','Logical Performed DropEffect','GetForegroundWindow()!=hwnd','not exposed Desktop','hosted CI only','owned fixture names only'])assert(cs.includes(s),s);
assert(!cs.includes('IDropTarget'));assert(!js.includes('unlinkSync'));assert(!js.includes('renameSync'));assert(!js.includes('positionDesktopPlan'));assert(js.includes('EXISTING ICON MOVED; no restoration attempted'));
assert(js.includes("if(kind==='hidden')"));assert(js.includes("hidden:true"));assert(!js.includes('hidden:false'));
for(const s of ['GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT','fixture marker mismatch','source fixture mismatch','Suspend-RunnerTerminal','Resume-RunnerTerminal'])assert(ps.includes(s));
console.log('PASS Shell native loop/owned-case/async-disabled/no-delete/no-old-write research contracts; no native execution');

for(const key of ['areas','origin','viewDpi','sx','sy','gx','gy','snap','autoArrange','shellAutoArrange','explorerPid','identityVersion'])assert(js.includes("'"+key+"'"));assert(js.includes("assert.deepEqual(s[key],baseline[key],'Desktop geometry/state changed: '+key)"));const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/shell-drop-research.yml'),'utf8');assert(workflow.includes('  push:'));assert(workflow.includes('kind: [resident, hidden, cancel]'));console.log('PASS complete geometry guards and working-branch path-triggered three-case workflow');
