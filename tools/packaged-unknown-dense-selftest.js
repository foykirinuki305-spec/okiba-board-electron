'use strict';
const fs=require('fs'),assert=require('assert/strict'),vm=require('vm'),{densePlan}=require('./packaged-unknown-dense-plan-ci');
const area={left:0,top:0,right:1920,bottom:1008,scale:150},grid={sx:113,sy:161,gx:20,gy:2},first={x:230,y:202},second={x:653,y:202};
const p=densePlan(area,grid,first,second);assert.equal(p.capacity,96);assert.equal(p.groups.flat().length,48);assert.equal(p.oldCount,51);
assert.throws(()=>densePlan({...area,right:1280},grid,first,second));assert.throws(()=>densePlan({...area,bottom:768},grid,first,second));assert.throws(()=>densePlan(area,grid,{x:1000,y:80},second));assert.throws(()=>densePlan({...area,scale:100},grid,first,second));
const read=n=>fs.readFileSync(require('path').join(__dirname,n),'utf8'),s=read('packaged-unknown-dense-ci.js');new vm.Script(s);
for(const v of ['seeded.icons.length,51','baseline=seeded','sameSnapshot(seeded,nofit)','for(const old of seeded.icons)','permitDurable','firstCalibrationTimings','finalActualTimings','scrollIntoViewIfNeeded','count(),group.length','await drag(group,target)','baseline=report.baseline','length:18'])assert(s.includes(v),v);
assert(!s.includes('window.okiba.resolveDropMove'));assert(!s.includes('window.okiba.safeTakeout'));assert(s.includes('files.slice(3,6)'));assert(s.includes('packaged-unknown-dense-input-ci.ps1'));
const input=read('packaged-unknown-dense-input-ci.ps1');assert(input.includes('Count -notin @(3,24)'));assert(read('packaged-unknown-drag-input-ci.ps1').includes('Count -ne 3'));
const wrapper=read('packaged-unknown-dense-dpi-ci.ps1');assert(wrapper.includes('packaged-unknown-dense-evidence/result.json'));assert(wrapper.includes('packaged-unknown-dense-ci.js'));
const support=read('packaged-unknown-dense-support-ci.ps1');assert(support.includes('three owned records required'));assert(support.includes('5[0-4]'));
console.log('PASS dense capacity/overlap/unsupported geometry and 51-old actual-drag metadata/identity/cleanup contracts; no native execution');

assert(s.includes('selection/scroll changed metadata'));assert(s.includes('selection/scroll changed source layout'));assert(s.includes('sourceLayoutUnchanged:true'));console.log('PASS selection/scroll preserves complete source cells and rendered positions');
