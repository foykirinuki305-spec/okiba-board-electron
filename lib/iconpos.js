'use strict';
/*
 * Desktop icon positioning for drag-out drops that land on the
 * Windows Desktop (v1.3).
 *
 * The v1.2 drag-out MOVES the real files into the Desktop folder —
 * the user confirmed that works on his PC. But Explorer then puts
 * the new icons wherever it wants (usually the first free slot), not
 * where he actually dropped them. After a successful move to the
 * Desktop, main runs scripts/position-desktop-icons.ps1, which
 * drives the desktop's SysListView32 directly
 * (LVM_SETITEMPOSITION) and places each moved file's icon at the
 * drop point.
 *
 * Positioning is strictly POST-move and best-effort: if the desktop
 * has "auto-arrange icons" ON, positions will not stick, so the
 * script reports that and the app adds one short note to the status
 * line; every other failure is silent. A positioning failure can
 * never turn into a move failure — the move already happened.
 *
 * The pure helpers (screen->client conversion, the column layout
 * rule, the auto-arrange decision, output parsing) live here so
 * tools/selftest.js can cover them without a Windows shell; the
 * PowerShell script implements the same layout rule with the real
 * listview metrics.
 */
const { execFile } = require('child_process');

const POSITION_TIMEOUT_MS = 5000;
const LVS_AUTOARRANGE = 0x1000; // listview window style bit

const AUTO_ARRANGE_NOTE =
  'デスクトップの自動整列がオンのため、位置は合わせられませんでした';

// ------------------------------------------------------------ decisions
function isAutoArrange(style) {
  return (Number(style) & LVS_AUTOARRANGE) !== 0;
}

// Only the auto-arrange case deserves a user-facing note (the icons
// visibly landed somewhere else). Everything else stays silent.
function statusNoteFor(positionResult) {
  if (positionResult && positionResult.status === 'autoarrange') {
    return AUTO_ARRANGE_NOTE;
  }
  return '';
}

// ------------------------------------------------------------- geometry
// ScreenToClient expressed in plain math: client coordinates are
// the screen point minus the client area's origin on screen.
function screenToClient(pt, clientOrigin) {
  return { x: pt.x - clientOrigin.x, y: pt.y - clientOrigin.y };
}

// A desktop icon's visible text may hide a known extension, so an
// item is matched against the full file name first, then the name
// without its extension.
function nameCandidates(fileName) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot > 0) return [name, name.slice(0, dot)];
  return [name];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Layout rule (position-desktop-icons.ps1 implements the same rule
// with live listview metrics):
//   - the first icon's top-left is the drop point centred on one
//     grid cell (anchor minus half the icon spacing), clamped into
//     the client area;
//   - further icons fill a vertical column from there (desktop
//     style) and wrap to the next column when the column runs out
//     of room;
//   - every position is clamped so icons never land off-screen.
function layoutIconPositions(opts) {
  const spacingX = Math.max(1, opts.spacingX | 0);
  const spacingY = Math.max(1, opts.spacingY | 0);
  const clientWidth = Math.max(0, opts.clientWidth | 0);
  const clientHeight = Math.max(0, opts.clientHeight | 0);
  const count = Math.max(0, opts.count | 0);
  const maxX = Math.max(0, clientWidth - spacingX);
  const maxY = Math.max(0, clientHeight - spacingY);
  const ax = clamp(Math.round(opts.anchor.x - spacingX / 2), 0, maxX);
  const ay = clamp(Math.round(opts.anchor.y - spacingY / 2), 0, maxY);
  const rowsPerCol = Math.max(1, Math.floor((clientHeight - ay) / spacingY) || 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const col = Math.floor(i / rowsPerCol);
    const row = i % rowsPerCol;
    out.push({
      x: clamp(ax + col * spacingX, 0, maxX),
      y: clamp(ay + row * spacingY, 0, maxY),
    });
  }
  return out;
}

// --------------------------------------------------------------- parsing
// Same defensive parse as dropmove.parseResolveOutput: the last
// non-empty line must be a JSON object with a recognised status.
const KNOWN_STATUS = new Set(['ok', 'partial', 'autoarrange', 'notfound', 'failed']);
function parsePositionOutput(stdout) {
  try {
    const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return { status: 'failed', positioned: 0 };
    const data = JSON.parse(lines[lines.length - 1]);
    if (!data || typeof data !== 'object') return { status: 'failed', positioned: 0 };
    return {
      status: KNOWN_STATUS.has(data.status) ? data.status : 'failed',
      positioned: Number.isFinite(data.positioned) ? data.positioned : 0,
    };
  } catch (e) {
    return { status: 'failed', positioned: 0 };
  }
}

// ------------------------------------------------------------ positioner
// Default positioner: run the bundled PowerShell script. The point
// is passed as plain integer arguments and each file name as its own
// argument (never interpolated into the script text); a hard
// timeout turns any hang into a silent "failed".
function createPowerShellPositioner(scriptPath) {
  return function positionViaPowerShell(x, y, names) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          String(Math.round(x)), String(Math.round(y)),
          ...(names || []).map((n) => String(n)),
        ], { windowsHide: true, timeout: POSITION_TIMEOUT_MS }, (err, stdout) => {
          if (err) return finish({ status: 'failed', positioned: 0 });
          finish(parsePositionOutput(stdout));
        });
      } catch (e) {
        return finish({ status: 'failed', positioned: 0 });
      }
      setTimeout(() => {
        try { if (child) child.kill(); } catch (e) {}
        finish({ status: 'failed', positioned: 0 });
      }, POSITION_TIMEOUT_MS + 1000).unref();
    });
  };
}

// Test hook: OKIBA_TEST_POSITIONER=stub replaces the shell work with
// a success report (main still logs the invocation into the drop
// log, so the GUI E2E can verify the wiring end to end).
function testPositionerFromEnv(env) {
  env = env || process.env;
  if (env.OKIBA_TEST_POSITIONER !== 'stub') return null;
  return async (_x, _y, names) => ({
    status: 'ok',
    positioned: (names || []).length,
  });
}

function createPositioner(opts) {
  opts = opts || {};
  if (typeof opts.position === 'function') return opts.position;
  const fromTest = testPositionerFromEnv(opts.env);
  if (fromTest) return fromTest;
  return createPowerShellPositioner(opts.scriptPath);
}

module.exports = {
  POSITION_TIMEOUT_MS,
  LVS_AUTOARRANGE,
  AUTO_ARRANGE_NOTE,
  isAutoArrange,
  statusNoteFor,
  screenToClient,
  nameCandidates,
  layoutIconPositions,
  parsePositionOutput,
  createPowerShellPositioner,
  testPositionerFromEnv,
  createPositioner,
};
