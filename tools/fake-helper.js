'use strict';
/*
 * Fake warm helper for tests (self-test + GUI E2E). A small Node
 * script speaking the same JSON-lines protocol as
 * scripts/shell-helper.ps1, driven by env so tests stay
 * deterministic:
 *
 *   OKIBA_FAKE_LANDING    folder resolveDrop reports (absent →
 *                         { type:'unknown' })
 *   OKIBA_FAKE_TYPE       'desktop' | 'explorer' (default explorer)
 *   OKIBA_FAKE_POSITIONS  JSON map name -> {x, y} for
 *                         getDesktopPositions
 *   OKIBA_FAKE_CURSOR     JSON array of {x, y, lbtn} served by
 *                         cursorState (v2.2.2): one entry per
 *                         request, the last entry repeats forever.
 *                         Absent → { x:0, y:0, lbtn:false }.
 *   OKIBA_FAKE_POSITION_DELAY_MS
 *                         positionIcons answers only after this
 *                         many ms (v2.2.2 optimistic-UI test: the
 *                         card must be gone long before it lands)
 *
 * Special requests:
 *   cmd 'hang'      → never answered (client timeout tests)
 *   payload.boom    → the process exits immediately (crash tests)
 */
const readline = require('readline');

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

send({ ready: true });

// Scripted cursor sequence for cursorState (v2.2.2 pre-resolve
// tests): consumed one entry per request; once exhausted, the
// last state repeats (a resting cursor keeps reporting itself).
let cursorSeq = null;
try {
  const parsed = JSON.parse(process.env.OKIBA_FAKE_CURSOR || 'null');
  if (Array.isArray(parsed) && parsed.length) cursorSeq = parsed;
} catch { cursorSeq = null; }
let cursorIdx = 0;
const calibrationFake=process.env.OKIBA_FAKE_CALIBRATION==='1';
let calibratedGrid=null,placedIcons=[];
const calibrationFs=require('fs');
function recordCalibration(req){if(!calibrationFake||!process.env.OKIBA_FAKE_COMMAND_LOG)return;calibrationFs.appendFileSync(process.env.OKIBA_FAKE_COMMAND_LOG,JSON.stringify({cmd:req.cmd,probe:req.probe,calibration:req.calibration,targets:req.targets,source:req.source,destination:req.destination,files:calibrationFs.readdirSync(process.env.OKIBA_FAKE_LANDING)})+'\n');}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req = null;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || typeof req.id !== 'number') return;
  if (req.boom) process.exit(3);
  if (req.cmd === 'hang') return; // never answered
  recordCalibration(req);
  if (req.cmd === 'resolveDrop') {
    const landing = process.env.OKIBA_FAKE_LANDING || '';
    if (!landing) {
      send({ id: req.id, result: { type: 'unknown' } });
    } else {
      send({
        id: req.id,
        result: {
          type: process.env.OKIBA_FAKE_TYPE || 'explorer',
          path: landing,
          echo: req.x,
        },
      });
    }
    return;
  }
  if (req.cmd === 'cursorState') {
    let st = { x: 0, y: 0, lbtn: false };
    if (cursorSeq) {
      st = cursorSeq[Math.min(cursorIdx, cursorSeq.length - 1)];
      cursorIdx++;
    }
    send({
      id: req.id,
      result: { x: st.x | 0, y: st.y | 0, lbtn: !!st.lbtn },
    });
    return;
  }
  if (req.cmd === 'moveNoReplace') {
    const fs=require('fs');
    let result;
    try {
      if(fs.existsSync(req.destination))result={ok:false,errorCode:183,reason:'destination-exists'};
      else {fs.renameSync(req.source,req.destination);result={ok:true,errorCode:0,reason:''};}
    } catch(e) {result={ok:false,errorCode:e.code==='EXDEV'?17:1,reason:String(e.message)};}
    send({id:req.id,result});return;
  }
  if(req.cmd==='exportDesktopCalibration'&&calibrationFake){send({id:req.id,result:{ok:true,version:1,entries:calibratedGrid?[{fakeShellIdentity:'unchanged-shell',grid:calibratedGrid,icons:placedIcons}]:[]}});return;}
  if(req.cmd==='importDesktopCalibration'&&calibrationFake){const entries=req.entries||[];const e=entries[0];const valid=e&&e.fakeShellIdentity==='unchanged-shell'&&e.grid?.sx===100&&e.grid?.sy===100&&Array.isArray(e.icons);if(valid){calibratedGrid=e.grid;placedIcons=e.icons;}send({id:req.id,result:{ok:true,accepted:valid?1:0,rejected:entries.length-(valid?1:0)}});return;}
  if (req.cmd === 'desktopSnapshot') {
    let result = {ok:true,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,
      origin:{x:0,y:0},areas:[{left:-5000,top:-5000,right:10000,bottom:10000}],icons:[]};
    try { if (process.env.OKIBA_TEST_DESKTOP_SNAPSHOT) result=JSON.parse(process.env.OKIBA_TEST_DESKTOP_SNAPSHOT); }
    catch (_) { result={ok:false,reason:'invalid-test-snapshot'}; }
    if(calibrationFake){result=JSON.parse(JSON.stringify(result));if(calibratedGrid)result.areas[1].grid=calibratedGrid;result.icons.push(...placedIcons);if(!calibratedGrid){const leftovers=calibrationFs.readdirSync(process.env.OKIBA_FAKE_LANDING).filter(n=>n.endsWith('.txt')&&n!=='sentinel.txt');result.icons.push(...leftovers.map((label,i)=>({label,x:2200+i*100,y:300})));}}
    send({id:req.id,result}); return;
  }
  if(req.cmd==='calibrateDesktopGrid'&&calibrationFake){
    if(process.env.OKIBA_FAKE_CALIBRATION_FAIL==='1'){send({id:req.id,result:{ok:false,reason:'injected-calibration-failure'}});return;}
    const p=req.plan;const samples=p.requests.map(r=>({id:r.id,probeId:p.probeId,geometryKey:p.geometryKey,iconsKey:p.iconsKey,requestX:r.x,requestY:r.y,x:Math.round(r.x/100)*100,y:Math.round(r.y/100)*100}));
    if(process.env.OKIBA_FAKE_CALIBRATION_BAD_SAMPLE==='1')samples[0].geometryKey='changed';
    send({id:req.id,result:{ok:true,token:'fake-evidence-token',samples}});return;
  }
  if (req.cmd === 'positionDesktopPlan') {
    if(calibrationFake&&process.env.OKIBA_FAKE_PLAN_FAIL!=='1'){if(req.calibration)calibratedGrid=req.calibration.grid;placedIcons.push(...(req.targets||[]).map(t=>({label:t.name,x:t.x,y:t.y})));}
    const answer=()=>send({id:req.id,result:process.env.OKIBA_FAKE_PLAN_FAIL === '1'
      ? {ok:false,reason:'injected-position-failure',positioned:0}
      : {ok:true,reason:'',positioned:Array.isArray(req.targets)?req.targets.length:0}});
    const delayMs=parseInt(process.env.OKIBA_FAKE_POSITION_DELAY_MS || '0',10);
    if(delayMs>0)setTimeout(answer,delayMs);else answer();return;
  }
  if (req.cmd === 'positionIcons') {
    const answer = () => send({
      id: req.id,
      result: { status: 'ok', positioned: Array.isArray(req.names) ? req.names.length : 0 },
    });
    const delayMs = parseInt(process.env.OKIBA_FAKE_POSITION_DELAY_MS || '0', 10);
    if (delayMs > 0) setTimeout(answer, delayMs);
    else answer();
    return;
  }
  if (req.cmd === 'getDesktopPositions') {
    let positions = {};
    try { positions = JSON.parse(process.env.OKIBA_FAKE_POSITIONS || '{}'); } catch { positions = {}; }
    send({ id: req.id, result: { positions, sx: 78, sy: 98 } });
    return;
  }
  send({ id: req.id, error: 'unknown-cmd' });
});
