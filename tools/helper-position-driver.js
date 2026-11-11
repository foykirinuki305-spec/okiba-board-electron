'use strict';
/*
 * CI driver for the HELPER-path desktop position test
 * (tools/helper-position-test.ps1): starts a LIVE
 * scripts/shell-helper.ps1 process through the app's own client
 * (lib/shellhelper.js — the exact code path main.js uses) and asks
 * it to position one desktop icon.
 *
 *   node tools/helper-position-driver.js <fileName> <screenX> <screenY>
 *
 * Prints ONE JSON line: the helper's positionIcons result
 * ({ status, positioned, detail }) — or a script-error object when
 * the helper transport itself failed. Always exits 0; the .ps1
 * wrapper judges the result.
 */
const path = require('path');
const sh = require('../lib/shellhelper');
const ip = require('../lib/iconpos');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function coldRead(name) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, '..', 'scripts', 'position-desktop-icons.ps1'),
    '-GetPosition', '0', '0', name,
  ], { windowsHide: true, timeout: 30000 });
  const line = stdout.split(/\r?\n/).filter(s => /^\s*\{/.test(s)).pop();
  if (!line) throw new Error('independent cold read produced no JSON');
  return JSON.parse(line);
}

// Two placements in ONE helper lifetime; verify EVERY icon via the
// independent cold path after EACH placement. No speed assertion:
// startup and stage durations are diagnostics, not flaky CI limits.
async function batchTest(client, args, once = false) {
  const [sxs, sys, widths, heights, originXs, originYs, ...names] = args;
  const sx = Number(sxs), sy = Number(sys);
  const rounds = [];
  const anchors = once ? [{x:420,y:100}] : [{x:420,y:100}, {x:650,y:100}];
  for (const anchor of anchors) {
    const t = performance.now();
    const reply = await client.request('positionIcons', { ...anchor, names }, { timeoutMs: 30000 });
    const elapsedMs = Math.round(performance.now() - t);
    if (!reply.ok || !reply.result) throw new Error('batch helper transport failure: ' + reply.error);
    const result = reply.result;
    if (result.status !== 'ok' || result.positioned !== names.length) {
      throw new Error('batch incomplete: ' + JSON.stringify(result));
    }
    const clientAnchor = ip.screenToClient(anchor, { x:Number(originXs), y:Number(originYs) });
    const expected = ip.layoutIconPositions({ anchor:clientAnchor, spacingX:sx, spacingY:sy,
      clientWidth:Number(widths), clientHeight:Number(heights), count:names.length });
    const reads = [];
    for (let i=0; i<names.length; i++) {
      const back = await coldRead(names[i]);
      if (back.status !== 'ok' || Math.abs(back.x-expected[i].x)>sx || Math.abs(back.y-expected[i].y)>sy) {
        throw new Error('cold batch verification: ' + JSON.stringify({name:names[i],expected:expected[i],back}));
      }
      reads.push({name:names[i],expected:expected[i],back});
    }
    rounds.push({ anchor, elapsedMs, result, reads });
  }
  return { status:'ok', positioned:names.length, rounds };
}

async function main() {
  const args = process.argv.slice(2);
  const [name, xs, ys] = args;
  const client = sh.createShellHelperClient({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', process.env.OKIBA_TEST_HELPER_SCRIPT || path.join(__dirname, '..', 'scripts', 'shell-helper.ps1')],
    timeoutMs: 30000,
  });
  try {
    if (name === '--batch' || name === '--batch-once') {
      console.log(JSON.stringify(await batchTest(client, args.slice(1), name === '--batch-once')));
      return;
    }
    const r = await client.request('positionIcons',
      { x: parseInt(xs, 10), y: parseInt(ys, 10), names: [name] },
      { timeoutMs: 30000 });
    if (!r.ok || !r.result) {
      console.log(JSON.stringify({
        status: 'script-error', positioned: 0,
        detail: 'helper transport: ' + (r.error || 'no result'),
      }));
      return;
    }
    console.log(JSON.stringify(r.result));
  } finally {
    client.dispose();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log(JSON.stringify({
      status: 'script-error', positioned: 0,
      detail: String((e && e.message) || e).slice(0, 200),
    }));
    process.exit(0);
  });
