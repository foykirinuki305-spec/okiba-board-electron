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
  if (req.cmd === 'positionIcons') {
    send({
      id: req.id,
      result: { status: 'ok', positioned: Array.isArray(req.names) ? req.names.length : 0 },
    });
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
