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

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req = null;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || typeof req.id !== 'number') return;
  if (req.boom) process.exit(3);
  if (req.cmd === 'hang') return; // never answered
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
  if (req.cmd === 'desktopSnapshot') {
    let result = {ok:true,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,
      origin:{x:0,y:0},areas:[{left:-5000,top:-5000,right:10000,bottom:10000}],icons:[]};
    try { if (process.env.OKIBA_TEST_DESKTOP_SNAPSHOT) result=JSON.parse(process.env.OKIBA_TEST_DESKTOP_SNAPSHOT); }
    catch (_) { result={ok:false,reason:'invalid-test-snapshot'}; }
    send({id:req.id,result}); return;
  }
  if (req.cmd === 'positionDesktopPlan') {
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
