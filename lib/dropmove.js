'use strict';
/*
 * Drag-out, third approach: self-implemented MOVE on outside release.
 *
 * Why not webContents.startDrag (v1.0/v1.1): on the user's real PC the
 * handoff silently did nothing (confirmed: neither a copy nor a
 * "download" appeared). The renderer pointer drag owns the gesture but
 * only fires pointermove/pointerup INSIDE the window (pointer capture
 * keeps reporting even when the OS pointer leaves — coordinates just
 * clamp/stop at the edge in practice), and startDrag is only honoured
 * inside a native dragstart event handler, which a pointer-driven
 * drag never produces. So the "exit the window" detection was
 * unreliable and the native call could be dropped without a sound.
 *
 * This module is the main-process half of the replacement:
 *   1. the renderer reports an outside release with the pointer's
 *      screen coordinates;
 *   2. resolveDropTarget(x, y) finds the folder under that point:
 *      a bundled PowerShell script maps the screen point to the top
 *      window (user32 WindowFromPoint) — Progman/WorkerW means the
 *      Desktop, otherwise the Explorer window registered in
 *      Shell.Application's ShellWindows with that HWND gives its
 *      folder path. Anything else is "unknown" and NOTHING is moved.
 *   3. moveItemsOut moves each real file/folder into the resolved
 *      folder with the intake rules (never overwrite — " (2)").
 *
 * The PowerShell resolver is injectable so tools/selftest.js and the
 * GUI E2E can stub it (no Windows shell needed to test the logic).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bf = require('./boardfs');

const RESOLVE_TIMEOUT_MS = 3000;

// ------------------------------------------------------------ parsing
// The PowerShell script prints exactly one JSON object on its last
// line. Parse defensively: last non-empty line, JSON.parse, shape
// check. Any deviation -> { type: 'unknown' }.
function parseResolveOutput(stdout) {
  try {
    const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return { type: 'unknown' };
    const data = JSON.parse(lines[lines.length - 1]);
    if (!data || typeof data !== 'object') return { type: 'unknown' };
    if (data.type === 'desktop') {
      const p = (typeof data.path === 'string' && data.path) ? data.path
        : bf.desktopDir();
      return { type: 'desktop', path: p };
    }
    if (data.type === 'explorer' && typeof data.path === 'string' && data.path) {
      return { type: 'explorer', path: data.path };
    }
    return { type: 'unknown' };
  } catch (e) {
    return { type: 'unknown' };
  }
}

// ------------------------------------------------------------ resolver
// Default resolver: run the bundled PowerShell script. The point is
// passed as plain integer arguments (never interpolated into the
// script text), the script path ships with the app, and a hard
// timeout turns any hang into "unknown".
function createPowerShellResolver(scriptPath) {
  return function resolveViaPowerShell(x, y) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath, String(Math.round(x)), String(Math.round(y)),
        ], { windowsHide: true, timeout: RESOLVE_TIMEOUT_MS }, (err, stdout) => {
          if (err) return finish({ type: 'unknown' });
          finish(parseResolveOutput(stdout));
        });
      } catch (e) {
        return finish({ type: 'unknown' });
      }
      // execFile's timeout kills the child, but belt-and-braces:
      setTimeout(() => {
        try { if (child) child.kill(); } catch (e) {}
        finish({ type: 'unknown' });
      }, RESOLVE_TIMEOUT_MS + 500).unref();
    });
  };
}

// Test hook: OKIBA_TEST_RESOLVER_DIR makes every resolution succeed
// with that folder (still goes through parseResolveOutput, so the
// JSON plumbing is exercised).
function testResolverFromEnv(env) {
  env = env || process.env;
  const dir = env.OKIBA_TEST_RESOLVER_DIR;
  if (!dir) return null;
  return async () => parseResolveOutput(JSON.stringify({ type: 'explorer', path: dir }));
}

function createResolver(opts) {
  opts = opts || {};
  if (typeof opts.resolve === 'function') return opts.resolve;
  const fromTest = testResolverFromEnv(opts.env);
  if (fromTest) return fromTest;
  return createPowerShellResolver(opts.scriptPath);
}

// -------------------------------------------------------------- moving
// Move real files/folders into targetDir. Rules mirror intake:
// never overwrite (" (2)" suffix), items already directly inside the
// target stay put (counted as skipped, not as moved), missing items
// are skipped. Cross-drive falls back to copy+remove inside
// boardfs.placeDroppedItems. Returns per-item results.
function moveItemsOut(paths, targetDir) {
  const moved = [];
  const skipped = [];
  const failed = [];
  const clean = [];
  for (const p of paths || []) {
    if (!p || !fs.existsSync(p)) { if (p) failed.push(p); continue; }
    if (path.resolve(path.dirname(p)) === path.resolve(targetDir)) {
      skipped.push(p);
      continue;
    }
    clean.push(p);
  }
  if (clean.length) {
    let placed = [];
    try { placed = bf.placeDroppedItems(clean, targetDir); }
    catch (e) { placed = []; }
    for (const src of clean) {
      // placeDroppedItems returns the destination paths it created.
      const hit = placed.find((d) => path.basename(d) === path.basename(src) ||
        path.basename(d).startsWith(path.basename(src).replace(/(\.[^.]*)$/, '') + ' ('));
      if (hit || !fs.existsSync(src)) moved.push(src);
      else failed.push(src);
    }
  }
  return { moved, skipped, failed };
}

module.exports = {
  RESOLVE_TIMEOUT_MS,
  parseResolveOutput,
  createPowerShellResolver,
  testResolverFromEnv,
  createResolver,
  moveItemsOut,
};
