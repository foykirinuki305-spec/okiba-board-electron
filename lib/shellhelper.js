'use strict';
/*
 * Warm shell helper client (v2.2, Job A).
 *
 * Until v2.1 every drag-out cold-spawned PowerShell twice (resolve
 * the drop target, then position the desktop icons) and each spawn
 * paid the full PowerShell + Add-Type startup — that was the lag the
 * user felt in 「デスクトップに移動するのをもっと素早く」.
 *
 * Now the app keeps ONE long-lived PowerShell process running
 * scripts/shell-helper.ps1, which implements resolveDrop,
 * positionIcons and getDesktopPositions behind a JSON-lines
 * protocol: one JSON object per line on stdin, one per line on
 * stdout, matched by `id`. Requests may be pipelined (the helper
 * itself is sequential, so responses stay in order); a per-request
 * timeout resolves { ok:false } WITHOUT killing the helper — its
 * late answer is recognised by id and dropped, and the caller falls
 * back to the v2.1 cold-spawn scripts, so behaviour never regresses.
 * If the helper process dies, in-flight requests fail and the next
 * request lazily respawns it (restart-on-crash). Non-ASCII text is
 * \u-escaped on the wire so Japanese file names survive any console
 * codepage.
 *
 * request() never rejects: it resolves { ok:true, result } or
 * { ok:false, error }. stats() exposes { enabled, spawns, requests,
 * ok, failed } for the E2E hooks (asserting spawns==1 across several
 * operations proves process reuse without flaky timing asserts).
 */
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 4000;
const READY_TIMEOUT_MS = 10000;

// Escape every non-ASCII char as \uXXXX so the request line is pure
// ASCII regardless of the helper's console input codepage.
function escapeLine(json) {
  return json.replace(/[\u0080-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function createShellHelperClient(opts = {}) {
  const enabled = opts.enabled !== false && !!opts.command;
  const command = opts.command || null;
  const args = opts.args || [];
  const spawnFn = opts.spawnFn || spawn;
  const defaultTimeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  let child = null;
  let buffer = '';
  let seq = 0;
  let ready = false;
  let readyWaiters = [];
  let readyTimer = null;
  const pending = new Map(); // id -> { resolve, timer }
  const stats = { spawns: 0, requests: 0, ok: 0, failed: 0 };

  function failAllPending(error) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
      pending.delete(id);
    }
  }

  function setReady() {
    if (ready) return;
    ready = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) w();
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj = null;
    try { obj = JSON.parse(trimmed); } catch { return; }
    if (obj && obj.ready === true) { setReady(); return; }
    if (!obj || typeof obj.id !== 'number') return;
    const p = pending.get(obj.id);
    if (!p) return; // late answer to a timed-out request: drop it
    pending.delete(obj.id);
    clearTimeout(p.timer);
    if (obj.error) {
      stats.failed += 1;
      p.resolve({ ok: false, error: String(obj.error) });
    } else {
      stats.ok += 1;
      p.resolve({ ok: true, result: obj.result });
    }
  }

  function start() {
    if (!enabled || child) return child;
    let proc = null;
    try {
      proc = spawnFn(command, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: opts.env || process.env,
      });
    } catch {
      return null;
    }
    child = proc;
    stats.spawns += 1;
    buffer = '';
    ready = false;
    if (proc.stdout && typeof proc.stdout.on === 'function') {
      if (typeof proc.stdout.setEncoding === 'function') proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleLine(line);
          nl = buffer.indexOf('\n');
        }
      });
    }
    const onGone = () => {
      if (child === proc) child = null;
      failAllPending('helper-exited');
      // Wake queued requesters so they fail over to the cold path
      // rather than waiting for a ready signal that will not come.
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w();
    };
    if (typeof proc.on === 'function') {
      proc.on('exit', onGone);
      proc.on('error', () => {
        // An error (for example a rejected kill) is not proof of exit.
        failAllPending('helper-error');
        if (!proc.pid) onGone();
      });
    }
    // If the ready line never arrives (broken script, AV software
    // eating the spawn...), flush the queue anyway after a grace
    // period and let the per-request timeouts govern; callers fall
    // back to the cold scripts on failure, exactly like v2.1.
    readyTimer = setTimeout(() => { readyTimer = null; setReady(); }, READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === 'function') readyTimer.unref();
    return proc;
  }

  function whenReady() {
    if (ready) return Promise.resolve();
    return new Promise((resolve) => { readyWaiters.push(resolve); });
  }

  async function request(cmd, payload = {}, reqOpts = {}) {
    // Envelope fields belong to the transport, not the caller. Reject before spawn/readiness.
    if (payload != null && ['id', 'cmd'].some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
      return { ok: false, error: 'reserved-payload-field', cmd };
    }
    if (!enabled) return { ok: false, error: 'helper-disabled' };
    const proc = start();
    if (!proc) return { ok: false, error: 'helper-spawn-failed' };
    await whenReady();
    if (child !== proc) return { ok: false, error: 'helper-exited' };
    const id = ++seq;
    stats.requests += 1;
    const timeoutMs = reqOpts.timeoutMs || defaultTimeoutMs;
    const line = escapeLine(JSON.stringify({ ...payload, id, cmd }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          stats.failed += 1;
          resolve({ ok: false, error: 'timeout', cmd });
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, timer });
      try {
        proc.stdin.write(line + '\n');
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        stats.failed += 1;
        resolve({ ok: false, error: 'helper-write-failed' });
      }
    });
  }

  function dispose() {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    failAllPending('helper-disposed');
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  // Strict file rollback must never race a late positioning command.
  async function stopAndWait(timeoutMs = 5000) {
    const proc=child;
    failAllPending('helper-stopping');
    if(!proc || proc.exitCode!==null && proc.exitCode!==undefined || proc.signalCode) return true;
    return new Promise(resolve=>{
      let done=false;
      const finish=ok=>{if(done)return;done=true;clearTimeout(timer);resolve(ok);};
      const timer=setTimeout(()=>finish(false),timeoutMs);
      proc.once('exit',()=>finish(true));
      try {proc.kill();}catch(_){finish(false);}
    });
  }

  return {
    stopAndWait,
    request,
    start,
    dispose,
    stats: () => ({ enabled, ...stats }),
    isEnabled: () => enabled,
  };
}

module.exports = { createShellHelperClient, escapeLine, DEFAULT_TIMEOUT_MS };
