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
 * line. Since v1.3.1 NO positioning failure is silent: the script
 * reports a precise status (ok / partial / autoarrange /
 * no-listview / no-item / set-unverified / script-error:<detail>),
 * the app shows one short suffix for any non-ok result and appends
 * the full result to <base>\okiba.log. A positioning failure can
 * never turn into a move failure — the move already happened.
 *
 * The pure helpers (screen->client conversion, the column layout
 * rule, the auto-arrange decision, output parsing) live here so
 * tools/selftest.js can cover them without a Windows shell; the
 * PowerShell script implements the same layout rule with the real
 * listview metrics.
 */
const { execFile } = require('child_process');

const POSITION_TIMEOUT_MS = 15000;
const LVS_AUTOARRANGE = 0x0100; // commctrl.h listview style bit
// (v1.3.0 wrongly used 0x1000 — that is LVS_OWNERDATA, which is
// set in the stock desktop listview style, so the position script
// reported "autoarrange" on machines where auto-arrange was OFF.)

const AUTO_ARRANGE_NOTE =
  'デスクトップの自動整列がオンのため、位置は合わせられませんでした';

// One short status-line suffix per non-ok positioning status. The
// user must always be able to tell WHY the icon is not where he
// dropped it — silent failure is what made v1.3.0's bug invisible.
const STATUS_NOTES = {
  autoarrange: AUTO_ARRANGE_NOTE,
  partial: '一部のアイコンは位置を合わせられませんでした',
  'no-listview': '位置は合わせられませんでした（デスクトップ未検出）',
  'no-item': '位置は合わせられませんでした（アイコン未検出）',
  'set-unverified': '位置は合わせられませんでした（位置が固定できませんでした）',
  'script-error': '位置は合わせられませんでした（エラー）',
};

// ------------------------------------------------------------ decisions
function isAutoArrange(style) {
  return (Number(style) & LVS_AUTOARRANGE) !== 0;
}

function statusNoteFor(positionResult) {
  if (!positionResult) return '';
  return STATUS_NOTES[positionResult.status] || '';
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
// Anything unrecognised becomes script-error with a detail, never
// a bare "failed" — the whole point of v1.3.1 is that a positioning
// failure must say what it was.
const KNOWN_STATUS = new Set([
  'ok', 'partial', 'autoarrange',
  'no-listview', 'no-item', 'set-unverified', 'script-error',
]);
function parsePositionOutput(stdout) {
  const bad = (detail) => ({ status: 'script-error', positioned: 0, detail });
  try {
    const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return bad('no output from position script');
    const data = JSON.parse(lines[lines.length - 1]);
    if (!data || typeof data !== 'object') return bad('non-object output');
    if (!KNOWN_STATUS.has(data.status)) return bad('unknown status: ' + String(data.status));
    return {
      status: data.status,
      positioned: Number.isFinite(data.positioned) ? data.positioned : 0,
      detail: typeof data.detail === 'string' ? data.detail : '',
      // Optional diagnostics preserve old/cold result shapes.
      ...(Number.isFinite(data.appearMs) && data.appearMs >= 0 ? { appearMs: data.appearMs } : {}),
      ...(Number.isFinite(data.workMs) && data.workMs >= 0 ? { workMs: data.workMs } : {}),
    };
  } catch (e) {
    return bad('unparseable output');
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
          if (err) {
            const detail = (err.killed || err.signal)
              ? 'position script timed out'
              : String((err && err.message) || err).split(/\r?\n/)[0].slice(0, 200);
            return finish({ status: 'script-error', positioned: 0, detail });
          }
          finish(parsePositionOutput(stdout));
        });
      } catch (e) {
        return finish({
          status: 'script-error', positioned: 0,
          detail: String((e && e.message) || e).slice(0, 200),
        });
      }
      setTimeout(() => {
        try { if (child) child.kill(); } catch (e) {}
        finish({ status: 'script-error', positioned: 0, detail: 'position script timed out' });
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
  STATUS_NOTES,
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
