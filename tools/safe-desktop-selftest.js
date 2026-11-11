'use strict';
// Pure planning and transactional adapter tests. Never accesses the real Desktop.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planDesktop, sameSnapshot, executeDesktop } = require('../lib/safe-desktop');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok - ' + name); }
const clone = x => JSON.parse(JSON.stringify(x));
const snapshot = () => ({ok:true,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,
  areas:[{left:0,top:0,right:1000,bottom:800}],origin:{x:0,y:0},icons:[{label:'guard.txt',x:0,y:0}]});
const items = offsets => offsets.map((offset,i)=>({path:'C:\\board\\item'+i+'.txt',name:'item'+i+'.txt',offset}));
const plan = (s=snapshot(), it=items([[0,0],[0,1]]), point={x:350,y:250}, automatic=false) => planDesktop({snapshot:s,items:it,point,automatic});
function denied(name,s,it,p) {check(name,()=>assert.equal(plan(s,it,p).ok,false));}
check('vertical offsets are preserved without wrapping',()=>assert.deepEqual(plan().targets.map(t=>[t.x,t.y]),[[300,200],[300,300]]));
check('sparse relative layout keeps holes',()=>assert.deepEqual(plan(snapshot(),items([[0,0],[2,0],[2,3]])).targets.map(t=>[t.x,t.y]),[[300,200],[500,200],[500,500]]));
check('negative anchor offsets keep selected geometry',()=>assert.deepEqual(plan(snapshot(),items([[-1,0],[0,0],[0,1]])).targets.map(t=>[t.x,t.y]),[[200,200],[300,200],[300,300]]));
check('input snapshots and source offsets are immutable',()=>{const s=snapshot(),it=items([[0,0],[0,1]]),before=JSON.stringify({s,it});plan(s,it);assert.equal(JSON.stringify({s,it}),before);});
check('buffer is free and distinct from every target',()=>{const s=snapshot(),p=plan(s);assert(!p.targets.some(t=>t.x===p.buffer.x&&t.y===p.buffer.y));assert(!s.icons.some(t=>t.x===p.buffer.x&&t.y===p.buffer.y));});
for(const [name,patch] of [['auto-arrange',{autoArrange:true}],['snap unavailable',{snap:false}],['snapshot unavailable',{ok:false}],['zero spacing',{sx:0}],['bad grid',{gx:NaN}],['no work areas',{areas:[]}],['invalid icon coordinate',{icons:[{label:'x',x:NaN,y:0}]}]]) denied(name+' is blocked',Object.assign(snapshot(),patch));
denied('occupied target is blocked, not relocated',snapshot(),items([[0,0]]),{x:50,y:50});
denied('partially offscreen group is blocked, not wrapped',snapshot(),items([[0,0],[0,1]]),{x:350,y:750});
denied('negative drop is blocked, not clamped',snapshot(),items([[0,0]]),{x:-100,y:250});
denied('outside right edge is blocked',snapshot(),items([[0,0]]),{x:1050,y:250});
denied('duplicate offsets are blocked',snapshot(),items([[0,0],[0,0]]));
denied('fractional offsets are blocked',snapshot(),items([[0,0],[0,0.5]]));
denied('missing layout is blocked',snapshot(),[{path:'a',name:'a'}]);
denied('duplicate file path is blocked',snapshot(),[{path:'A',name:'a',offset:[0,0]},{path:'a',name:'b',offset:[1,0]}]);
denied('duplicate destination names are blocked',snapshot(),[{path:'A',name:'a',offset:[0,0]},{path:'B',name:'A',offset:[1,0]}]);
denied('existing full destination name is blocked',snapshot(),[{path:'a',name:'guard.txt',offset:[0,0]}]);
denied('hidden extension collision is blocked',Object.assign(snapshot(),{icons:[{label:'item0',x:0,y:0}]}),items([[0,0]]));
denied('monitor gap is not a valid desktop area',Object.assign(snapshot(),{areas:[{left:0,top:0,right:300,bottom:800},{left:500,top:0,right:1000,bottom:800}]}),items([[0,0]]),{x:350,y:250});
denied('group cannot bridge a monitor gap',Object.assign(snapshot(),{areas:[{left:0,top:0,right:300,bottom:800},{left:500,top:0,right:1000,bottom:800}]}),items([[0,0],[1,0]]),{x:250,y:250});
denied('no spare buffer cell cancels conservatively',Object.assign(snapshot(),{areas:[{left:0,top:0,right:100,bottom:200}],icons:[]}),items([[0,0],[0,1]]),{x:50,y:50});
check('automatic placement keeps relative shape',()=>{const p=plan(snapshot(),items([[0,0],[2,1]]),null,true);assert(p.ok);assert.equal(p.targets[1].x-p.targets[0].x,200);assert.equal(p.targets[1].y-p.targets[0].y,100);});
check('snapshot comparison ignores icon enumeration order',()=>{const a=snapshot();a.icons.push({label:'z',x:200,y:100});const b=clone(a);b.icons.reverse();assert(sameSnapshot(a,b));});
for(const [name,mutate] of [['existing icon moved',s=>s.icons[0].x++],['icon appeared',s=>s.icons.push({label:'new',x:800,y:700})],['origin changed',s=>s.origin.x--],['workarea changed',s=>s.areas[0].right--],['grid changed',s=>s.gx++],['snap changed',s=>s.snap=false]]) check(name+' invalidates preflight',()=>{const a=snapshot(),b=clone(a);mutate(b);assert(!sameSnapshot(a,b));});

const multi=()=>({...snapshot(),icons:[],areas:[
 {left:0,top:71,right:1920,bottom:1103,grid:{sx:101,sy:67,gx:42,gy:6}},
 {left:1920,top:0,right:3840,bottom:1032,grid:{sx:101,sy:67,gx:43,gy:2}},
 {left:3840,top:0,right:5760,bottom:1032,grid:null}]});
check('primary monitor uses its own grid, not left grid',()=>{const p=plan(multi(),items([[0,0],[0,1]]),{x:2110,y:180});assert(p.ok);for(const t of p.targets){assert.equal(t.x%101,43);assert.equal(t.y%67,2);}assert.equal(p.targets[1].y-p.targets[0].y,67);});
check('left monitor uses shifted workarea grid',()=>{const p=plan(multi(),items([[0,0],[1,0]]),{x:350,y:250});assert(p.ok);for(const t of p.targets){assert.equal(t.x%101,42);assert.equal(t.y%67,6);}});
check('unknown empty monitor is blocked without guessing',()=>assert(!plan(multi(),items([[0,0]]),{x:4100,y:300}).ok));
check('empty monitor with evidenced derived grid is permitted',()=>{const s=multi();s.areas[2].grid={sx:101,sy:67,gx:44,gy:2};assert(plan(s,items([[0,0]]),{x:4100,y:300}).ok);});
check('monitor crossing is rejected rather than moved to another grid',()=>assert(!plan(multi(),items([[0,0],[1,0]]),{x:1890,y:200}).ok));
check('all targets and spare buffer stay inside the chosen monitor',()=>{const s=multi(),p=plan(s,items([[0,0],[0,1]]),{x:2110,y:180});assert(p.ok);for(const t of [...p.targets,p.buffer])assert(t.x>=1920&&t.x+101<=3840&&t.y>=0&&t.y+67<=1032);});
check('negative-coordinate monitor has valid relative placement',()=>{const s=multi();s.areas=[{left:-1920,top:-200,right:0,bottom:900,grid:{sx:100,sy:80,gx:-1870,gy:-170}}];const p=plan(s,items([[0,0],[1,2]]),{x:-1500,y:100});assert(p.ok);assert.equal(p.targets[1].x-p.targets[0].x,100);assert.equal(p.targets[1].y-p.targets[0].y,160);});
check('different monitor spacing is respected',()=>{const s=multi();s.areas[1].grid={sx:150,sy:100,gx:1970,gy:20};const p=plan(s,items([[0,0],[1,1]]),{x:2300,y:300});assert(p.ok);assert.equal(p.targets[1].x-p.targets[0].x,150);assert.equal(p.targets[1].y-p.targets[0].y,100);});
check('mixed new schema does not fall back to global for missing grid',()=>{const s=multi();delete s.areas[1].grid;assert(!plan(s,items([[0,0]]),{x:2300,y:300}).ok);});
check('monitor grid change invalidates preflight',()=>{const a=multi(),b=clone(a);b.areas[1].grid.gy++;assert(!sameSnapshot(a,b));});
check('automatic skips unknown area and uses known area',()=>{const s=multi();s.areas[0].grid=null;const p=plan(s,items([[0,0],[0,1]]),null,true);assert(p.ok);assert(p.targets.every(t=>t.x>=1920&&t.x<3840));});

for(const key of ['viewDpi','folderFlags','shellAutoArrange','explorerPid','explorerStarted','listviewHwnd'])check(key+' change invalidates snapshot before moving',()=>{const a=snapshot(),b=clone(a);a[key]=1;b[key]=2;assert(!sameSnapshot(a,b));});
async function transactions() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-safe-unit-'));
  try {
    const source=path.join(root,'source'),dest=path.join(root,'destination');fs.mkdirSync(source);fs.mkdirSync(dest);
    const metadata=path.join(root,'.okiba-board.json'),history=path.join(root,'.move-history.json');
    const originals={metadata:'{"positions":{"item0.txt":{"col":2,"row":3}},"links":[]}',history:'[]'};
    const reset=()=>{fs.writeFileSync(metadata,originals.metadata);fs.writeFileSync(history,originals.history);for(let i=0;i<2;i++){const a=path.join(source,'item'+i+'.txt'),b=path.join(dest,'item'+i+'.txt');if(fs.existsSync(b))fs.renameSync(b,a);fs.writeFileSync(a,'source-'+i);}};
    const it=items([[0,0],[0,1]]).map((i,n)=>({...i,path:path.join(source,i.name),dest:path.join(dest,i.name)}));
    const s=snapshot(),p=plan(s,it);let calls=[];
    const adapter=overrides=>Object.assign({snapshot:async()=>clone(s),move:async i=>{calls.push('move');fs.renameSync(i.path,i.dest);},position:async()=>{calls.push('position');return {ok:true};},commit:async()=>{calls.push('commit');fs.writeFileSync(metadata,'committed');},rollback:async i=>{calls.push('rollback');if(fs.existsSync(i.dest))fs.renameSync(i.dest,i.path);}},overrides);
    const unchanged=()=>{assert.equal(fs.readFileSync(metadata,'utf8'),originals.metadata);assert.equal(fs.readFileSync(history,'utf8'),originals.history);for(const [n,i]of it.entries()){assert.equal(fs.readFileSync(i.path,'utf8'),'source-'+n);assert(!fs.existsSync(i.dest));}};
    reset();calls=[];let calibratedPlan={...p,targets:p.targets.map(t=>({...t,x:t.x+100}))};let c=await executeDesktop({items:it,plan:{ok:true,calibrationPending:true},snapshot:s,adapter:adapter({completePlanAfterFirstMove:async probe=>{calls.push('calibrate');assert.equal(probe.path,it[0].path);assert(fs.existsSync(it[0].dest));assert(fs.existsSync(it[1].path));return calibratedPlan;},position:async(_s,actual)=>{calls.push('position');assert.deepEqual(actual,calibratedPlan);return {ok:true};}})});check('probe calibration precedes remaining moves and final placement',()=>{assert(c.ok);assert.deepEqual(calls,['move','calibrate','move','position','commit']);});
    reset();calls=[];c=await executeDesktop({items:it,plan:{ok:true,calibrationPending:true},snapshot:s,adapter:adapter({completePlanAfterFirstMove:async()=>{calls.push('calibrate');return {ok:false,reason:'calibration-failed'};}})});check('failed calibration restores probe without moving remaining files',()=>{assert(!c.ok);assert.deepEqual(calls,['move','calibrate','rollback']);unchanged();});
    reset();calls=[];c=await executeDesktop({items:it,plan:{ok:true,calibrationPending:true},snapshot:s,adapter:adapter({completePlanAfterFirstMove:async()=>({ok:false,unsafe:true})})});check('unsafe calibration helper state forbids rollback and further moves',()=>{assert.equal(c.reason,'helper-not-stopped');assert.deepEqual(calls,['move']);assert.equal(c.recovery.length,1);assert(fs.existsSync(it[0].dest));assert(fs.existsSync(it[1].path));});
    reset();calls=[];c=await executeDesktop({items:it,plan:{ok:true,calibrationPending:true},snapshot:s,adapter:adapter({completePlanAfterFirstMove:async()=>{throw Error('bad-calibration-evidence');}})});check('calibration evidence exception restores probe',()=>{assert.equal(c.reason,'bad-calibration-evidence');assert.deepEqual(calls,['move','rollback']);unchanged();});
    reset();calls=[];c=await executeDesktop({items:it,plan:{ok:true,calibrationPending:true},snapshot:s,adapter:adapter({completePlanAfterFirstMove:async()=>({ok:false,reason:'occupied-or-outside'})})});check('group that cannot fit after calibration is rolled back without repacking',()=>{assert.equal(c.reason,'occupied-or-outside');assert.deepEqual(calls,['move','rollback']);unchanged();});
    reset();calls=[];let r=await executeDesktop({items:it,plan:{ok:false,reason:'occupied'},snapshot:s,adapter:adapter()});check('invalid plan performs zero move/position/commit calls',()=>{assert(!r.ok&&r.blocked);assert.deepEqual(calls,[]);unchanged();});
    reset();calls=[];r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({snapshot:async()=>({...s,icons:[...s.icons,{label:'raced',x:900,y:700}]})})});check('desktop race cancels before any mutation',()=>{assert(!r.ok&&r.blocked);assert.deepEqual(calls,[]);unchanged();});
    reset();calls=[];r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({snapshot:async()=>{throw Error('snapshot failed');}})});check('snapshot exception blocks before every mutation',()=>{assert(!r.ok&&r.blocked);assert.deepEqual(calls,[]);unchanged();});
    reset();calls=[];r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({position:async()=>({ok:false,unsafe:true})})});check('unconfirmed helper exit prevents rollback and surfaces destinations',()=>{assert(!r.ok);assert.equal(r.reason,'helper-not-stopped');assert.equal(r.recovery.length,2);assert.deepEqual(calls,['move','move']);assert.deepEqual(r.recovery.map(x=>x.path),it.map(x=>x.dest));assert.equal(fs.readFileSync(metadata,'utf8'),originals.metadata);assert.equal(fs.readFileSync(history,'utf8'),originals.history);for(const i of it){assert(fs.existsSync(i.dest));assert(!fs.existsSync(i.path));}});
    reset();calls=[];const detail={ok:false,reason:'existing-icon-changed',phase:'arrival',detail:'test',changed:{label:'guard',before:{x:0,y:0},after:[{x:100,y:0}]}};r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({position:async()=>detail})});check('helper phase and changed coordinates survive rollback',()=>{assert.deepEqual(r.position,detail);unchanged();});
    reset();calls=[];r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({position:async()=>({ok:false,reason:'unstable'})})});check('failed placement rolls back every source and preserves metadata/history',()=>{assert(!r.ok);assert.equal(r.recovery.length,0);unchanged();});
    reset();calls=[];let moved=0;r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({move:async i=>{fs.renameSync(i.path,i.dest);if(++moved===2)throw Error('injected move failure');}})});check('partial move failure rolls back including the throwing item',()=>{assert(!r.ok);unchanged();});
    reset();calls=[];r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter()});check('metadata commits only after successful strict placement',()=>{assert(r.ok);assert.deepEqual(calls,['move','move','position','commit']);assert.equal(fs.readFileSync(metadata,'utf8'),'committed');});
    reset();r=await executeDesktop({items:it,plan:p,snapshot:s,adapter:adapter({position:async()=>({ok:false}),rollback:async()=>{throw Error('injected rollback failure');}})});check('rollback failure is surfaced, never reported as success',()=>{assert(!r.ok);assert.equal(r.recovery.length,2);});
  } finally {const resolved=path.resolve(root);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('okiba-safe-unit-'));fs.rmSync(resolved,{recursive:true,force:true});}
}
transactions().then(()=>console.log('safe-desktop selftest: '+checks+' checks passed')).catch(e=>{console.error(e);process.exitCode=1;});
