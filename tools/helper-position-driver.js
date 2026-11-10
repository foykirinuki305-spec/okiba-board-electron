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

async function main() {
  const [name, xs, ys] = process.argv.slice(2);
  const client = sh.createShellHelperClient({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'scripts', 'shell-helper.ps1')],
    timeoutMs: 30000,
  });
  try {
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
