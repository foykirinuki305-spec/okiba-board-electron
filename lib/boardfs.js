'use strict';
/*
 * OkibaBoard shared filesystem logic.
 *
 * This module mirrors the data rules of the Tk version (v7,
 * ~/workspace/deskboard-exe/OkibaBoard.py) so the Electron rebuild
 * reads and writes the exact same on-disk format:
 *
 *   base = <SystemDrive>\OkibaBoards          (OKIBA_BASE overrides)
 *   board = a real folder directly under the base
 *   <base>\.home.json        {"positions": {board: {col,row}}, "theme": name}
 *   <board>\.okiba-board.json {"version":6, "size_percent":N,
 *                              "positions": {name: {col,row}},
 *                              "links": [{path, col, row, wasHidden}],
 *                              "notes": [{id,text,col,row}]}
 *
 * Two kinds of file items live on a board (v2.0 "link + hide" model):
 *   - resident: a real file/folder physically inside the board folder.
 *     These are NOT listed in the json — they are found by scanning the
 *     folder, and "positions" maps their names to cells. Every json
 *     written before v2.0 (version <= 5, no "links") migrates to this:
 *     all its items are resident, positions untouched, zero file ops.
 *   - linked: a file/folder that stays at its ORIGINAL absolute path
 *     (e.g. on the Desktop) so other apps (AviUtl) keep finding it.
 *     Only a reference {path, col, row, wasHidden} is stored; the app
 *     sets the Windows Hidden attribute on the original while it is
 *     linked so it visually disappears from its home location.
 *
 * Pure Node (fs/path/os only) so tools/selftest.js can unit-test it
 * without Electron.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BOARD_FILENAME = '.okiba-board.json';
const HOME_FILENAME = '.home.json';
const BASE_DIR_NAME = 'OkibaBoards';
const DEFAULT_BOARD_NAME = 'ボード1';
const BASE_ENV_VAR = 'OKIBA_BASE';
const OLD_BASE_ENV_VAR = 'OKIBA_OLD_BASE';

const PERCENT_CHOICES = [25, 30, 40, 50, 60, 70, 80, 90, 100, 125];
const DEFAULT_PERCENT = 100;
const LEGACY_SIZE_PERCENT = { '小': 70, '中': 100, '大': 125 };
// Base (100%) grid cell used to convert legacy v3 pixel positions.
const BASE_CELL_W = 166;
const BASE_CELL_H = 104;
const ORIGIN = 16;

const THEME_ORDER = ['紺', '黒グレー', '深緑', '紫夜', '焦げ茶'];
const DEFAULT_THEME = '紺';

// ---------------------------------------------------------------- grid
function posToCell(x, y, cellW, cellH) {
  const col = Math.round((x - ORIGIN) / cellW);
  const row = Math.round((y - ORIGIN) / cellH);
  return [Math.max(col, 0), Math.max(row, 0)];
}

function cellFromAny(value, cellW, cellH) {
  if (!value || typeof value !== 'object') return null;
  if ('col' in value && 'row' in value) {
    const c = parseInt(value.col, 10);
    const r = parseInt(value.row, 10);
    if (Number.isNaN(c) || Number.isNaN(r)) return null;
    return [Math.max(c, 0), Math.max(r, 0)];
  }
  if ('x' in value && 'y' in value) {
    const x = parseInt(value.x, 10);
    const y = parseInt(value.y, 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return posToCell(x, y, cellW, cellH);
  }
  return null;
}

function rowsPerColumn(viewHeight, cellH) {
  const usable = Math.max(viewHeight - ORIGIN, cellH);
  return Math.max(1, Math.floor(usable / cellH));
}

function nextFreeCell(occupied, rowsPerCol, start) {
  // occupied: Set of "col,row" strings. Column-fill order.
  let started = !start;
  for (let col = 0; ; col++) {
    for (let row = 0; row < rowsPerCol; row++) {
      if (!started) {
        if (col === start[0] && row === start[1]) started = true;
        else continue;
      }
      if (!occupied.has(col + ',' + row)) return [col, row];
    }
  }
}

// cells: Map key -> [col,row]. Move key to target; swap occupant.
// Returns swapped key or null. If key had no cell and target is taken,
// nothing moves (returns null) — same rule as v7.
function moveToCell(cells, key, target) {
  target = [target[0], target[1]];
  const old = cells.get(key) || null;
  if (old && old[0] === target[0] && old[1] === target[1]) return null;
  let other = null;
  for (const [k, v] of cells.entries()) {
    if (k !== key && v[0] === target[0] && v[1] === target[1]) { other = k; break; }
  }
  if (other !== null) {
    if (!old) return null;
    cells.set(other, old);
  }
  cells.set(key, target);
  return other;
}

// ---------------------------------------------------------------- base
function oldBaseDir(env) {
  env = env || process.env;
  if (env[OLD_BASE_ENV_VAR]) return env[OLD_BASE_ENV_VAR];
  return path.join(os.homedir(), 'Documents', BASE_DIR_NAME);
}

function defaultBaseDir(env) {
  env = env || process.env;
  if (env[BASE_ENV_VAR]) return env[BASE_ENV_VAR];
  if (process.platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    return path.join(drive + path.sep, BASE_DIR_NAME);
  }
  return path.join(os.homedir(), BASE_DIR_NAME);
}

function listBoards(base) {
  try {
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
    return fs.readdirSync(base)
      .filter((n) => {
        try { return fs.statSync(path.join(base, n)).isDirectory(); }
        catch (e) { return false; }
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch (e) {
    return [];
  }
}

function mergeLegacyBoards(oldBase, newBase) {
  let moved = 0;
  try {
    if (path.resolve(oldBase) === path.resolve(newBase)) return 0;
    if (!fs.existsSync(oldBase)) return 0;
    fs.mkdirSync(newBase, { recursive: true });
    for (const name of listBoards(oldBase)) {
      const dest = path.join(newBase, name);
      if (fs.existsSync(dest)) continue; // keep both, touch none
      try {
        fs.renameSync(path.join(oldBase, name), dest);
        moved++;
      } catch (e) {
        try { // cross-volume fallback
          copyDirSync(path.join(oldBase, name), dest);
          fs.rmSync(path.join(oldBase, name), { recursive: true, force: true });
          moved++;
        } catch (e2) { /* legacy board stays intact */ }
      }
    }
  } catch (e) { /* return what we have */ }
  return moved;
}

function resolveBase(env) {
  const oldBase = oldBaseDir(env);
  const newBase = defaultBaseDir(env);
  let moved = 0;
  if (path.resolve(oldBase) === path.resolve(newBase)) {
    return { base: newBase, moved: 0 };
  }
  if (!fs.existsSync(newBase)) {
    const legacy = listBoards(oldBase);
    if (legacy.length) {
      try {
        fs.renameSync(oldBase, newBase);
        return { base: newBase, moved: legacy.length };
      } catch (e) {
        try {
          copyDirSync(oldBase, newBase);
          fs.rmSync(oldBase, { recursive: true, force: true });
          return { base: newBase, moved: legacy.length };
        } catch (e2) {
          return { base: oldBase, moved: 0 }; // never lose data
        }
      }
    }
    return { base: newBase, moved: 0 };
  }
  moved = mergeLegacyBoards(oldBase, newBase);
  return { base: newBase, moved };
}

function ensureBase(base) {
  fs.mkdirSync(base, { recursive: true });
  if (!listBoards(base).length) {
    fs.mkdirSync(path.join(base, DEFAULT_BOARD_NAME), { recursive: true });
  }
  return base;
}

// ---------------------------------------------------------------- names
const INVALID_CHARS = '\\/:*?"<>|';
function validateBoardName(name) {
  const cleaned = (name || '').trim();
  if (!cleaned) throw new Error('ボード名が空です');
  const bad = [...new Set([...cleaned].filter((ch) => INVALID_CHARS.includes(ch)))];
  if (bad.length) {
    throw new Error('名前に使えない文字が含まれています: ' + bad.join(' ') +
      '\nフォルダ名には \\ / : * ? " < > | は使えません');
  }
  if (cleaned.endsWith('.')) throw new Error('ボード名の最後に「.」は使えません');
  return cleaned;
}

function createBoard(base, name) {
  const cleaned = validateBoardName(name);
  const dest = path.join(base, cleaned);
  if (fs.existsSync(dest)) throw new Error('同じ名前のボードがあります');
  fs.mkdirSync(dest, { recursive: true });
  return cleaned;
}

function renameBoard(base, oldName, newName) {
  const cleaned = validateBoardName(newName);
  if (cleaned === oldName) return cleaned;
  const src = path.join(base, oldName);
  const dest = path.join(base, cleaned);
  if (!fs.existsSync(src)) throw new Error('元のボードがありません');
  if (fs.existsSync(dest)) throw new Error('同じ名前のボードがあります');
  fs.renameSync(src, dest);
  return cleaned;
}

// ---------------------------------------------------------------- home
function homePath(base) { return path.join(base, HOME_FILENAME); }

function loadHome(base) {
  const result = { positions: {}, theme: null };
  const p = homePath(base);
  if (!fs.existsSync(p)) return result;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [name, value] of Object.entries(data.positions || {})) {
      const cell = cellFromAny(value, BASE_CELL_W, BASE_CELL_H);
      if (cell) result.positions[name] = cell;
    }
    if (typeof data.theme === 'string') result.theme = data.theme;
  } catch (e) { /* corrupted home file -> defaults */ }
  return result;
}

function saveHome(base, positions, theme) {
  if (theme === undefined || theme === null) {
    theme = loadHome(base).theme;
  }
  const data = {
    positions: Object.fromEntries(
      Object.entries(positions).map(([n, c]) => [n, { col: c[0], row: c[1] }])),
  };
  if (theme !== null && theme !== undefined) data.theme = theme;
  fs.writeFileSync(homePath(base), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// ---------------------------------------------------------------- board
function boardPath(folder) { return path.join(folder, BOARD_FILENAME); }

function scanFolder(folder) {
  return fs.readdirSync(folder)
    .filter((n) => n !== BOARD_FILENAME)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => {
      let isDir = false;
      try { isDir = fs.statSync(path.join(folder, name)).isDirectory(); } catch (e) {}
      return { name, isDir };
    });
}

function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.path !== 'string' || !raw.path) return null;
  const link = { path: raw.path, col: null, row: null, wasHidden: !!raw.wasHidden };
  // col/row come as numbers in v6; tolerate a legacy {col,row} or
  // pixel {x,y} shape if one ever appears.
  const cell = cellFromAny(raw, BASE_CELL_W, BASE_CELL_H);
  if (cell) { link.col = cell[0]; link.row = cell[1]; }
  return link;
}

function saveBoard(folder, positions, notes, sizePercent, links) {
  let percent = parseInt(sizePercent, 10);
  if (Number.isNaN(percent)) percent = DEFAULT_PERCENT;
  percent = Math.max(10, Math.min(percent, 200));
  const data = {
    version: 6,
    size_percent: percent,
    positions: Object.fromEntries(
      Object.entries(positions).map(([n, c]) => [n, { col: c[0], row: c[1] }])),
    links: (links || []).map((l) => {
      const out = { path: l.path, wasHidden: !!l.wasHidden };
      const c = (l.col !== null && l.col !== undefined) ? l.col : null;
      const r = (l.row !== null && l.row !== undefined) ? l.row : null;
      out.col = c; out.row = r;
      return out;
    }),
    notes: (notes || []).map((n) => ({
      id: n.id, text: n.text, col: n.col, row: n.row,
    })),
  };
  fs.writeFileSync(boardPath(folder), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function loadBoard(folder) {
  const result = {
    version: 6, positions: {}, notes: [], links: [], sizePercent: DEFAULT_PERCENT,
  };
  const p = boardPath(folder);
  if (!fs.existsSync(p)) return result;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return result; }
  if (data.size_percent !== undefined && data.size_percent !== null) {
    const v = parseInt(data.size_percent, 10);
    if (!Number.isNaN(v)) result.sizePercent = Math.max(10, Math.min(v, 200));
  } else if (LEGACY_SIZE_PERCENT[data.size]) {
    result.sizePercent = LEGACY_SIZE_PERCENT[data.size];
  }
  for (const [name, value] of Object.entries(data.positions || {})) {
    const cell = cellFromAny(value, BASE_CELL_W, BASE_CELL_H);
    if (cell) result.positions[name] = cell;
  }
  for (const raw of data.links || []) {
    const link = normalizeLink(raw);
    if (link) result.links.push(link);
  }
  for (const n of data.notes || []) {
    const cell = cellFromAny(n, BASE_CELL_W, BASE_CELL_H);
    if (!cell) continue;
    result.notes.push({
      id: n.id || crypto.randomBytes(5).toString('hex'),
      text: n.text || '',
      col: cell[0],
      row: cell[1],
    });
  }
  return result;
}

// ---------------------------------------------------------------- intake
function driveOf(p) {
  const root = path.parse(path.resolve(p)).root || '';
  return root.toLowerCase();
}

function uniqueDestination(targetFolder, name) {
  let dest = path.join(targetFolder, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) {
    const candidate = path.join(targetFolder, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (fs.statSync(src).isDirectory()) {
      copyDirSync(src, dest);
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    }
  }
}

// Explorer rule: same drive -> move, different drive -> copy.
// Never overwrite (" (2)" suffix). Skips items already inside the
// target folder, missing items, and the board data file itself.
function placeDroppedItems(sources, targetFolder) {
  const placed = [];
  const targetAbs = path.resolve(targetFolder);
  for (const src of sources || []) {
    if (!src || !fs.existsSync(src)) continue;
    const srcAbs = path.resolve(src);
    if (path.dirname(srcAbs) === targetAbs) continue;
    const name = path.basename(srcAbs);
    if (name === BOARD_FILENAME) continue;
    const dest = uniqueDestination(targetFolder, name);
    if (driveOf(srcAbs) === driveOf(targetFolder)) {
      movePath(srcAbs, dest);
    } else if (fs.statSync(srcAbs).isDirectory()) {
      copyDirSync(srcAbs, dest);
    } else {
      fs.copyFileSync(srcAbs, dest);
    }
    placed.push(dest);
  }
  return placed;
}

function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

module.exports = {
  BOARD_FILENAME, HOME_FILENAME, BASE_DIR_NAME, DEFAULT_BOARD_NAME,
  PERCENT_CHOICES, DEFAULT_PERCENT, LEGACY_SIZE_PERCENT,
  BASE_CELL_W, BASE_CELL_H, THEME_ORDER, DEFAULT_THEME,
  posToCell, cellFromAny, rowsPerColumn, nextFreeCell, moveToCell,
  oldBaseDir, defaultBaseDir, listBoards, mergeLegacyBoards, resolveBase,
  ensureBase, validateBoardName, createBoard, renameBoard,
  loadHome, saveHome, scanFolder, saveBoard, loadBoard,
  driveOf, uniqueDestination, placeDroppedItems, desktopDir,
};
