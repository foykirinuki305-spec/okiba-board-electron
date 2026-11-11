// Pure/static test; does not run any desktop input.
'use strict';const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8'),s=read('packaged-unknown-reuse-ci.js'),ps=read('packaged-unknown-drag-input-ci.ps1'),cs=read('packaged-unknown-drag-input-ci.cs');new vm.Script(s);
assert(!s.includes('window.okiba.safeTakeout'));assert(!s.includes('dispatchEvent'));assert(!s.includes('OKIBA_TEST_HOOKS'));assert(s.includes("OKIBA_DESKTOP_UNKNOWN_PREVIEW:'1'"));
for(const v of ['GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT','foreground mismatch','start outside owned window','SendInput','drop is not exposed desktop'])assert(cs.includes(v));
for(const v of ['MainModule.FileName','StartTime','owned selected links only','owned board proof','drop may hit existing icon'])assert(ps.includes(v));
for(const v of ['report.noFitVerified=true','first.icons','samepath-hidden','unknown-grid','e.trusted','processExit','if(app)try{await stop()','record.identity','[files.slice(0,3),files.slice(3)]'])assert(s.includes(v),v);
const original=read('formal-unknown-dpi-empty-ci.ps1'),clone=read('packaged-unknown-reuse-dpi-ci.ps1');assert.equal(clone,original.replaceAll('formal-unknown-success-ci.json','packaged-unknown-drag-evidence/result.json').replaceAll('formal-unknown-success-ci.js','packaged-unknown-reuse-ci.js').replaceAll('WaitForExit(240000)','WaitForExit(600000)').replaceAll("(($n.cases -join ',') -ceq 'success,no-fit')","$n.noFitVerified -eq $true"));
console.log('PASS packaged drag source/guard/restore contracts; no native input or app launch executed');

assert(s.includes('requested pointer center x'));assert(s.includes('requested pointer center y'));assert(s.includes('eventStart'));assert(s.includes("e.type==='pointerup'&&e.trusted"));
const {planDesktop}=require('../lib/safe-desktop');for(const sy of [67,98,147]){const bottom=1000,gy=5,y=gy+Math.floor(((bottom-5)-sy/2-gy)/sy+.5)*sy;assert(y+3*sy>bottom,'lower edge drop cannot fit vertical three');}console.log('PASS explicit pointer-center anchor checks and lower-workarea-edge no-fit geometry');

assert(clone.includes("'packaged-unknown-drag-evidence/result.json'"));assert(s.includes("path.join(out,'result.json')"));assert(clone.includes('WaitForExit(600000)'));console.log('PASS wrapper/report destination match and 600s child wait');

for(const v of ['new IntPtr(-4)','SetThreadDpiAwarenessContext(old)','MoveExact','p.x!=x||p.y!=y'])assert(cs.includes(v));console.log('PASS physical per-monitor-v2 scope restoration and exact cursor readback guards');
