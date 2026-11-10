'use strict';
/*
 * Move-out history (v2.2.1, Job 3 — 「どこに行ったか分からない」
 * 場合の救済措置）.
 *
 * Every REAL move out of a board (drag-out, right-click
 * 「デスクトップへ移動」, 「選択をボードから出す」) is recorded so
 * the user can find the file again (「場所を開く」) or put it back
 * (「ボードに戻す」). History starts with v2.2.1's moves; nothing
 * is backfilled.
 *
 * GROUPED (user-confirmed shape): ONE move operation = ONE group.
 * A marquee multi-select move-out is a single group whose items
 * restore together, preserving their original cells/layout; a
 * single-file move is simply a group of one, so every code path is
 * the same. The cap is the newest MAX_GROUPS operations — a bulk
 * move-out can never evict the whole history by itself.
 *
 * Storage: <base>\.move-history.json
 *   [{ id, at (ISO), boardName, boardFolder,
 *      items: [{ kind: 'resident'|'linked', destPath, fileName,
 *                col, row }] }]
 * newest first. col/row are the item's board cell before the move
 * (either may be null when it had no saved cell).
 *
 * This module is the pure/storage half (record / cap / merge /
 * removal / restore planning); main.js performs the actual file
 * moves, re-links and existence checks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_FILENAME = '.move-history.json';
const MAX_GROUPS = 5;

function historyPath(base) { return path.join(base, HISTORY_FILENAME); }

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.destPath !== 'string' || !raw.destPath) return null;
  const kind = raw.kind === 'linked' ? 'linked' : 'resident';
  const num = (v) => (Number.isFinite(v) ? v | 0 : null);
  return {
    kind,
    destPath: raw.destPath,
    fileName: (typeof raw.fileName === 'string' && raw.fileName)
      ? raw.fileName : path.basename(raw.destPath),
    col: num(raw.col),
    row: num(raw.row),
  };
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(normalizeItem).filter(Boolean);
  if (!items.length) return null;
  return {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id
      : crypto.randomBytes(6).toString('hex'),
    at: (typeof raw.at === 'string' && raw.at) ? raw.at : new Date(0).toISOString(),
    boardName: (typeof raw.boardName === 'string') ? raw.boardName : '',
    boardFolder: (typeof raw.boardFolder === 'string') ? raw.boardFolder : '',
    items,
  };
}

function loadHistory(base) {
  const p = historyPath(base);
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map(normalizeGroup).filter(Boolean).slice(0, MAX_GROUPS);
  } catch (e) {
    return []; // corrupted history must never break the app
  }
}

function saveHistory(base, groups) {
  const out = (groups || []).map(normalizeGroup).filter(Boolean).slice(0, MAX_GROUPS);
  fs.writeFileSync(historyPath(base), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/*
 * Record the items of ONE move operation. With an `id` that already
 * exists (the renderer passes one shared operation id through the
 * several IPC calls of a multi-select "take out", so they land in
 * ONE group), the items are appended to that group instead of
 * opening a new one. Otherwise a new group is unshifted (newest
 * first) and the cap trims the oldest operations.
 * Returns the stored history.
 */
function recordItems(base, { id, at, boardName, boardFolder, items }) {
  const clean = (items || []).map(normalizeItem).filter(Boolean);
  if (!clean.length) return loadHistory(base);
  const groups = loadHistory(base);
  if (id) {
    const existing = groups.find((g) => g.id === id);
    if (existing) {
      existing.items.push(...clean);
      saveHistory(base, groups);
      return groups;
    }
  }
  groups.unshift({
    id: id || crypto.randomBytes(6).toString('hex'),
    at: at || new Date().toISOString(),
    boardName: boardName || '',
    boardFolder: boardFolder || '',
    items: clean,
  });
  return saveHistory(base, groups);
}

// Partition a group's items into the ones that can come back (the
// recorded destination still exists) and the ones that cannot
// (renamed / deleted / moved by hand after the move-out — the
// honest limit: 移動後に名前を変えると戻せません).
// existsFn(destPath) -> boolean is injected for testability.
function planRestore(group, existsFn) {
  const restorable = [];
  const missing = [];
  for (const item of (group && group.items) || []) {
    let exists = false;
    try { exists = !!existsFn(item.destPath); } catch (e) { exists = false; }
    (exists ? restorable : missing).push(item);
  }
  return { restorable, missing };
}

// Remove items (by destination path) from one group — used after a
// successful restore and for the per-item 「履歴から消す」. A group
// left empty is removed entirely. Returns the stored history.
function removeItems(base, groupId, destPaths) {
  const drop = new Set(destPaths || []);
  const groups = loadHistory(base)
    .map((g) => (g.id === groupId
      ? { ...g, items: g.items.filter((it) => !drop.has(it.destPath)) }
      : g))
    .filter((g) => g.items.length > 0);
  return saveHistory(base, groups);
}

function removeGroup(base, groupId) {
  const groups = loadHistory(base).filter((g) => g.id !== groupId);
  return saveHistory(base, groups);
}

function findGroup(base, groupId) {
  return loadHistory(base).find((g) => g.id === groupId) || null;
}

module.exports = {
  HISTORY_FILENAME,
  MAX_GROUPS,
  historyPath,
  loadHistory,
  saveHistory,
  recordItems,
  planRestore,
  removeItems,
  removeGroup,
  findGroup,
  normalizeItem,
  normalizeGroup,
};
