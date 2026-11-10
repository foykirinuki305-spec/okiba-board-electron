'use strict';
/* OkibaBoard renderer. All filesystem work goes through window.okiba
 * (preload IPC); this file only does layout, drag and menus. */
const api = window.okiba;

const THEME_ORDER = ['紺', '黒グレー', '深緑', '紫夜', '焦げ茶'];
const PERCENTS = [25, 30, 40, 50, 60, 70, 80, 90, 100, 125];
const ORIGIN = 16;

const $ = (id) => document.getElementById(id);
const homeView = $('homeView'), boardView = $('boardView');
const boardGrid = $('boardGrid'), boardArea = $('boardArea');

let theme = '紺';
let view = 'home';
let homeData = null;      // {boards, positions, migrated, base}
let boardData = null;     // {name, entries, positions, notes, sizePercent}
let cells = new Map();    // "file:name"|"note:id" -> [col,row]
let selection = new Set(); // selected item keys ("file:name"|"note:id")
let busy = false;         // modal or menu open -> pause auto refresh
let dragging = false;

const SVG = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" opacity=".9"/><path d="M14 3l4 4h-4z" fill="#fff" opacity=".45"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="6.5" cy="18" r="2.8" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.8" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5" fill="currentColor" opacity=".9"/><path d="M16 10.5l5-3v9l-5-3z" fill="currentColor"/></svg>',
};

function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, ms || 3200);
}

function applyTheme(name) {
  theme = THEME_ORDER.includes(name) ? name : '紺';
  document.documentElement.dataset.theme = theme;
  $('homeThemeBtn').textContent = 'テーマ: ' + theme;
  $('boardThemeBtn').textContent = 'テーマ: ' + theme;
}

async function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  applyTheme(next);
  try { await api.setTheme(next); } catch (e) {}
}

// ------------------------------------------------------------ modal
function promptModal({ title, value = '', multiline = false, note = '' }) {
  return new Promise((resolve) => {
    busy = true;
    const overlay = $('modalOverlay');
    const input = $('modalInput'), area = $('modalArea'), err = $('modalError');
    $('modalTitle').textContent = title;
    const noteEl = $('modalNote');
    noteEl.textContent = note || '';
    noteEl.hidden = !note;
    err.textContent = '';
    input.hidden = multiline;
    area.hidden = !multiline;
    const field = multiline ? area : input;
    field.value = value;
    overlay.hidden = false;
    setTimeout(() => { field.focus(); field.select(); }, 30);
    const cleanup = () => {
      overlay.hidden = true;
      $('modalOk').onclick = $('modalCancel').onclick = null;
      field.onkeydown = null;
      busy = false;
    };
    $('modalCancel').onclick = () => { cleanup(); resolve(null); };
    $('modalOk').onclick = () => { const v = field.value; cleanup(); resolve(v); };
    field.onkeydown = (e) => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); $('modalOk').click(); }
      if (e.key === 'Escape') { e.preventDefault(); $('modalCancel').click(); }
    };
    overlay.onmousedown = (e) => { if (e.target === overlay) $('modalCancel').click(); };
  });
}
function modalError(msg) {
  // re-open a simple notice by reusing the toast (errors from actions)
  toast(msg);
}

// -------------------------------------------------------- context menu
const ctxMenu = $('ctxMenu');
function showMenu(x, y, items) {
  busy = true;
  ctxMenu.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    d.onmousedown = (e) => {
      e.stopPropagation();
      hideMenu();
      Promise.resolve(it.action()).catch((err) => toast(String(err.message || err)));
    };
    ctxMenu.appendChild(d);
  }
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function hideMenu() { ctxMenu.hidden = true; busy = false; }
document.addEventListener('mousedown', (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
    if (view === 'board' && selection.size) {
      selection = new Set();
      renderBoardSelection();
    }
  }
});

// ------------------------------------------------- native-drag lockdown
// HTML5 drag is disabled app-wide, unconditionally. There is NO
// native drag in this app at all (webContents.startDrag was removed
// in v1.2 — on the user's PC the handoff silently did nothing; the
// drag-out move is now self-implemented on outside release). The
// lockdown still matters: thumbnails are <img> elements whose src is
// a data: URL, and an <img> is natively draggable by default —
// dragging one out of the window made Chromium save the THUMBNAIL as
// a browser-style download (different file name, original left
// behind). The capture-phase preventDefault below seals every
// remaining path (links, backgrounded images, future elements), and
// every created <img>/item also gets draggable=false explicitly.
document.addEventListener('dragstart', (e) => { e.preventDefault(); }, true);
// Drops outside the board area must never navigate or download.
document.addEventListener('dragover', (e) => {
  if (!boardArea.contains(e.target)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!boardArea.contains(e.target)) e.preventDefault();
});

// main-process status messages (e.g. drag-out cleanup failures)
api.onStatus((msg) => toast(msg));

// -------------------------------------------------------------- thumbs
const thumbCache = new Map();
function loadThumb(fullPath, imgEl) {
  if (thumbCache.has(fullPath)) {
    const u = thumbCache.get(fullPath);
    if (u) imgEl.src = u;
    return;
  }
  api.thumb(fullPath).then((url) => {
    thumbCache.set(fullPath, url);
    if (url && imgEl.isConnected) imgEl.src = url;
  }).catch(() => thumbCache.set(fullPath, null));
}

function tileFor(kind, noteText) {
  const t = document.createElement('div');
  if (kind === 'folder') { t.className = 'tile tile-folder'; t.innerHTML = SVG.folder; }
  else if (kind === 'audio') { t.className = 'tile tile-audio'; t.innerHTML = SVG.audio; }
  else if (kind === 'video') {
    t.className = 'tile tile-video'; t.innerHTML = SVG.video;
    const b = document.createElement('span'); b.className = 'badge'; b.textContent = '▶';
    t.appendChild(b);
  } else if (kind === 'note') {
    t.className = 'tile tile-note'; t.textContent = noteText || '';
  } else { t.className = 'tile tile-file'; t.innerHTML = SVG.file; }
  return t;
}

// ================================================================ HOME
function homeOrder(boards, positions) {
  const key = (n) => {
    const c = positions[n];
    return c ? c[0] * 10000 + c[1] : Number.MAX_SAFE_INTEGER;
  };
  return [...boards].sort((a, b) => key(a.name) - key(b.name));
}

async function saveHomeOrder(orderedNames) {
  // column-fill cells so reload reproduces this order
  const rows = Math.max(1, Math.floor(boardGrid.clientHeight / 250)) || 2;
  const positions = {};
  orderedNames.forEach((name, i) => {
    positions[name] = [Math.floor(i / rows), i % rows];
  });
  try { await api.saveHomePositions(positions); } catch (e) {}
  if (homeData) homeData.positions = positions;
}

function renderHome() {
  const boards = homeOrder(homeData.boards, homeData.positions || {});
  $('homeSub').textContent = homeData.boards.length
    ? `全 ${homeData.boards.length} 件` : 'まだボードがありません';
  const notice = $('migratedNotice');
  if (homeData.migrated > 0) {
    notice.hidden = false;
    notice.textContent = `前の版から ${homeData.migrated} 件のボードを引き継ぎました`;
  } else notice.hidden = true;
  boardGrid.innerHTML = '';
  for (const b of boards) {
    const card = document.createElement('div');
    card.className = 'board-card';
    card.draggable = false;
    card.dataset.name = b.name;
    const collage = document.createElement('div');
    collage.className = 'collage';
    if (b.thumbs.length) {
      for (const u of b.thumbs) {
        const im = document.createElement('img');
        im.src = u; im.alt = '';
        im.draggable = false; // never leak a thumbnail as a "download"
        collage.appendChild(im);
      }
    } else {
      for (const k of (b.kinds.length ? b.kinds : ['folder']).slice(0, 6)) {
        collage.appendChild(tileFor(k));
      }
    }
    const nm = document.createElement('div');
    nm.className = 'board-card-name'; nm.textContent = b.name; nm.title = b.name;
    const sub = document.createElement('div');
    sub.className = 'board-card-sub'; sub.textContent = `${b.count}件`;
    card.append(collage, nm, sub);
    card.addEventListener('pointerdown', (e) => homeCardPointer(e, card, b));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '名前を変更', action: () => renameBoardFlow(b.name) },
        { label: '場所を開く', action: () => api.openBoardFolder(b.name) },
        { label: 'デスクトップにショートカットを作る', action: async () => {
            await api.createBoardShortcut(b.name);
            toast(`『${b.name}』のショートカットをデスクトップに作りました`);
          } },
        { label: 'ゴミ箱へ削除', danger: true, action: async () => {
            await api.trashBoard(b.name); await refreshHome();
          } },
      ]);
    });
    boardGrid.appendChild(card);
  }
}

function homeCardPointer(e, card, board) {
  if (e.button !== 0) return;
  dragging = true; // suppress refresh for the whole press (see itemPointer)
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 7) {
      moved = true;
      card.classList.add('dragging');
    }
    if (moved) {
      card.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px) scale(1.03)`;
    }
  };
  const onUp = async (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    card.classList.remove('dragging');
    card.style.transform = '';
    dragging = false;
    if (!moved) { openBoard(board.name); return; }
    // swap with the card under the pointer (if any)
    card.style.pointerEvents = 'none';
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    card.style.pointerEvents = '';
    const target = under && under.closest ? under.closest('.board-card') : null;
    const names = [...boardGrid.querySelectorAll('.board-card')].map((c) => c.dataset.name);
    const from = names.indexOf(board.name);
    if (target && target.dataset.name !== board.name) {
      const to = names.indexOf(target.dataset.name);
      [names[from], names[to]] = [names[to], names[from]];
      await saveHomeOrder(names);
    }
    renderHome();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

async function renameBoardFlow(oldName) {
  const v = await promptModal({ title: 'ボードの名前を変更', value: oldName });
  if (v === null) return;
  try {
    homeData = await api.renameBoard(oldName, v);
    renderHome();
  } catch (e) { toast(String(e.message || e)); }
}

async function refreshHome() {
  homeData = await api.getHome();
  applyTheme(homeData.theme);
  if (dragging) return; // same mid-drag render guard as refreshBoard
  if (view === 'home') renderHome();
}

// =============================================================== BOARD
function metrics() {
  const p = boardData ? boardData.sizePercent : 100;
  const s = p / 100;
  const cellW = Math.max(56, Math.round(164 * s));
  const cellH = Math.max(64, Math.round(158 * s));
  const thumb = Math.max(30, Math.round(96 * s));
  const font = Math.max(9, Math.round(12.5 * s));
  const rows = Math.max(1, Math.floor((boardArea.clientHeight - ORIGIN * 1.5) / cellH));
  return { cellW, cellH, thumb, font, rows, percent: p };
}

function buildCells() {
  cells = new Map();
  for (const [name, c] of Object.entries(boardData.positions)) {
    cells.set('file:' + name, c);
  }
  for (const n of boardData.notes) cells.set('note:' + n.id, [n.col, n.row]);
  for (const l of boardData.links || []) {
    if (l.col !== null && l.col !== undefined &&
        l.row !== null && l.row !== undefined) {
      cells.set('link:' + l.path, [l.col, l.row]);
    }
  }
  const m = metrics();
  const occupied = new Set([...cells.values()].map((c) => c[0] + ',' + c[1]));
  const place = (key) => {
    if (!cells.has(key)) {
      const c = bfNextFree(occupied, m.rows);
      cells.set(key, c);
      occupied.add(c[0] + ',' + c[1]);
    }
  };
  for (const e of boardData.entries) place('file:' + e.name);
  for (const n of boardData.notes) place('note:' + n.id);
  for (const l of boardData.links || []) place('link:' + l.path);
}
function bfNextFree(occupied, rows) {
  for (let col = 0; ; col++) {
    for (let row = 0; row < rows; row++) {
      if (!occupied.has(col + ',' + row)) return [col, row];
    }
  }
}

async function persistBoard() {
  const positions = {};
  const notes = boardData.notes.map((n) => ({ ...n }));
  for (const [key, c] of cells.entries()) {
    if (key.startsWith('file:')) positions[key.slice(5)] = c;
    else if (key.startsWith('note:')) {
      const note = notes.find((n) => 'note:' + n.id === key);
      if (note) { note.col = c[0]; note.row = c[1]; }
    }
  }
  const links = (boardData.links || []).map((l) => {
    const c = cells.get('link:' + l.path);
    return {
      path: l.path, wasHidden: !!l.wasHidden,
      col: c ? c[0] : (l.col !== undefined ? l.col : null),
      row: c ? c[1] : (l.row !== undefined ? l.row : null),
    };
  });
  boardData.positions = positions;
  boardData.notes = notes;
  for (const l of boardData.links || []) {
    const c = cells.get('link:' + l.path);
    if (c) { l.col = c[0]; l.row = c[1]; }
  }
  try {
    await api.saveBoard(boardData.name, positions, notes, boardData.sizePercent, links);
  } catch (e) { toast(String(e.message || e)); }
}

function renderBoard() {
  if (!boardData) return;
  $('boardTitle').textContent = boardData.name;
  $('percentSel').value = String(boardData.sizePercent);
  buildCells();
  const m = metrics();
  boardArea.innerHTML = '';
  const renderItem = (key, kind, label, fullPath, noteText, opts) => {
    opts = opts || {};
    const itemKind = opts.itemKind || 'resident';
    const missing = !!opts.missing;
    const c = cells.get(key);
    if (!c) return;
    const el = document.createElement('div');
    el.className = 'item' + (selection.has(key) ? ' selected' : '') +
      (missing ? ' missing' : '');
    el.draggable = false; // items move via pointer drag only (see lockdown)
    el.dataset.key = key;
    el.style.left = (ORIGIN + c[0] * m.cellW) + 'px';
    el.style.top = (ORIGIN + c[1] * m.cellH) + 'px';
    el.style.width = m.cellW + 'px';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.width = m.thumb + 'px';
    thumb.style.height = m.thumb + 'px';
    if ((kind === 'image' || kind === 'video') && fullPath && !missing) {
      const showImg = (url) => {
        const t = thumb.querySelector('.tile');
        if (t) t.remove();
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false; // a dragged data:-URL img becomes a "download"
        img.src = url;
        thumb.appendChild(img);
      };
      const had = thumbCache.get(fullPath);
      if (had) showImg(had);
      else {
        // show a tile until the thumbnail arrives
        thumb.appendChild(tileFor(kind));
        api.thumb(fullPath).then((url) => {
          thumbCache.set(fullPath, url);
          if (url && thumb.isConnected) showImg(url);
        }).catch(() => {});
      }
    } else {
      thumb.appendChild(tileFor(kind === 'note' ? 'note' : kind, noteText));
    }
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.style.fontSize = m.font + 'px';
    nm.textContent = label;
    nm.title = label; // full name on hover
    el.append(thumb, nm);
    if (missing) {
      const badge = document.createElement('div');
      badge.className = 'badge-missing';
      badge.textContent = '元の場所にありません';
      el.appendChild(badge);
    }
    el.addEventListener('pointerdown', (e) => itemPointer(e, el, key, fullPath));
    el.addEventListener('dblclick', () => {
      if (kind === 'note') editNoteFlow(key);
      else if (missing) toast('元の場所にありません');
      else if (fullPath) api.openItem(fullPath).catch((err) => toast(String(err.message || err)));
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selection.has(key)) selection = new Set([key]);
      renderBoardSelection();
      if (selection.size > 1) {
        // ---- multi-selection menu: one combined "take out" action
        // — since v2.1 both kinds move to the Desktop for real
        // (linked originals too, with their links detached). Plain
        // removal without moving is the single-item ボードから外す.
        // Delete is the explicit real-file kind.
        const hasOut = [...selection].some((k) =>
          k.startsWith('file:') || k.startsWith('link:'));
        const items = [{ label: `${selection.size}件を選択中`, action: () => {} }];
        if (hasOut) {
          items.push({ label: '選択をボードから出す', action: () => takeOutSelection() });
        }
        items.push({ label: 'ゴミ箱へ削除（実ファイルも削除）', danger: true, action: () => trashSelection() });
        showMenu(e.clientX, e.clientY, items);
        return;
      }
      if (kind === 'note') {
        showMenu(e.clientX, e.clientY, [
          { label: '編集', action: () => editNoteFlow(key) },
          { label: 'ゴミ箱へ削除', danger: true, action: async () => {
              boardData.notes = boardData.notes.filter((n) => 'note:' + n.id !== key);
              cells.delete(key);
              await persistBoard(); renderBoard();
            } },
        ]);
      } else if (itemKind === 'linked') {
        const link = opts.link;
        if (missing) {
          // The original is gone from its path: the ONLY sensible
          // action is cleaning the reference off the board. Nothing
          // file-destructive is offered.
          showMenu(e.clientX, e.clientY, [
            { label: 'ボードから外す', action: () => unlinkFlow([fullPath]) },
          ]);
        } else {
          showMenu(e.clientX, e.clientY, [
            { label: '開く', action: () => api.openItem(fullPath) },
            { label: '名前を変更', action: () => renameLinkedFlow(key, link) },
            { label: '場所を開く', action: () => api.showItem(fullPath) },
            { label: 'デスクトップへ移動', action: () => moveLinkedToDesktopFlow([fullPath]) },
            { label: 'ボードから外す', action: () => unlinkFlow([fullPath]) },
            { label: 'ファイルをゴミ箱へ削除', danger: true, action: async () => {
                await api.trashLinked(boardData.name, fullPath); refreshBoard();
              } },
          ]);
        }
      } else {
        showMenu(e.clientX, e.clientY, [
          { label: '開く', action: () => api.openItem(fullPath) },
          { label: '名前を変更', action: () => renameItemFlow(key, fullPath, label) },
          { label: '場所を開く', action: () => api.showItem(fullPath) },
          { label: 'デスクトップへ移動', action: async () => {
              await api.moveToDesktop(fullPath); refreshBoard();
            } },
          { label: 'ゴミ箱へ削除', danger: true, action: async () => {
              await api.trashItem(fullPath); refreshBoard();
            } },
        ]);
      }
    });
    boardArea.appendChild(el);
  };
  for (const e of boardData.entries) {
    renderItem('file:' + e.name, e.kind, e.name, e.path, null, { itemKind: 'resident' });
  }
  for (const l of boardData.links || []) {
    renderItem('link:' + l.path, l.kind, l.name, l.path, null,
      { itemKind: 'linked', missing: !l.exists, link: l });
  }
  for (const n of boardData.notes) {
    renderItem('note:' + n.id, 'note', n.text.split('\n')[0] || 'メモ', null, n.text);
  }
}

function renderBoardSelection() {
  for (const el of boardArea.querySelectorAll('.item')) {
    el.classList.toggle('selected', selection.has(el.dataset.key));
  }
}

// ------------------------------------------------------- multi-select
function pathOfKey(key) {
  if (!boardData) return null;
  if (key.startsWith('link:')) return key.slice(5); // the path IS the id
  if (!key.startsWith('file:')) return null;
  const entry = boardData.entries.find((en) => en.name === key.slice(5));
  return entry ? entry.path : null;
}

// Plan a group move by cell delta. Returns a Map key->[col,row] to
// apply, or null to revert the WHOLE group: every target cell must be
// inside the grid and either free or occupied by a selection member.
// No partial moves — predictable, like the desktop.
function planGroupMove(keys, dCol, dRow, rows) {
  if (!dCol && !dRow) return new Map();
  const keySet = new Set(keys);
  const occupiedBy = new Map();
  for (const [k, v] of cells.entries()) occupiedBy.set(v[0] + ',' + v[1], k);
  const plan = new Map();
  for (const k of keys) {
    const c = cells.get(k);
    if (!c) return null;
    const t = [c[0] + dCol, c[1] + dRow];
    if (t[0] < 0 || t[1] < 0 || t[1] >= rows) return null;
    const occ = occupiedBy.get(t[0] + ',' + t[1]);
    if (occ && !keySet.has(occ)) return null;
    plan.set(k, t);
  }
  return plan;
}

// Unregister linked items （ボードから外す menu action). Main
// removes the references and restores visibility; the renderer then
// just reloads board state — the originals never moved. (Drag-out
// is a different gesture since v2.1: a real move, see onUp.)
async function unlinkFlow(paths) {
  if (!paths.length) return;
  try { await api.unlinkItems(boardData.name, paths); }
  catch (e) { toast(String(e.message || e)); }
  refreshBoard();
}

// Move LINKED items' real files to the Desktop (menu version of
// the v2.1 drag-out): the original leaves its home path for the
// Desktop, the link is detached, and the file lands visible. This
// is deliberately different from ボードから外す above, which only
// unregisters and un-hides — the file stays where it always was.
async function moveLinkedToDesktopFlow(paths) {
  if (!paths.length) return;
  try {
    const r = await api.moveLinkedToDesktop(boardData.name, paths);
    if (r && r.moved && r.moved.length) toast('デスクトップへ移動しました');
    else toast('移動できませんでした');
  } catch (e) { toast(String(e.message || e)); }
  refreshBoard();
}

// Combined "take the selection out of this board": since v2.1 both
// kinds land on the Desktop for real — resident files move there
// (their long-standing "out"), and linked originals move there too
// (with their links detached). Plain removal without moving is the
// single-item ボードから外す. Notes stay (a note has no file to
// take out; deleting notes is the trash action below).
async function takeOutSelection() {
  const keys = [...selection];
  const linkedPaths = keys.filter((k) => k.startsWith('link:')).map((k) => k.slice(5));
  const residentPaths = keys.filter((k) => k.startsWith('file:'))
    .map(pathOfKey).filter(Boolean);
  if (linkedPaths.length) {
    try { await api.moveLinkedToDesktop(boardData.name, linkedPaths); }
    catch (e) { toast(String(e.message || e)); }
  }
  for (const p of residentPaths) {
    try { await api.moveToDesktop(p); } catch (e) { toast(String(e.message || e)); }
  }
  refreshBoard();
}

// Combined delete: notes are deleted, resident files are trashed,
// and LINKED items get their REAL original file trashed (explicit
// destructive action — distinct from ボードから外す）.
async function trashSelection() {
  for (const key of [...selection]) {
    if (key.startsWith('note:')) {
      boardData.notes = boardData.notes.filter((n) => 'note:' + n.id !== key);
      cells.delete(key);
      selection.delete(key);
    } else if (key.startsWith('link:')) {
      const p = key.slice(5);
      try {
        await api.trashLinked(boardData.name, p);
        boardData.links = boardData.links.filter((l) => l.path !== p);
        cells.delete(key);
        selection.delete(key);
      } catch (e) { toast(String(e.message || e)); }
    } else {
      const p = pathOfKey(key);
      if (p) {
        try { await api.trashItem(p); } catch (e) { toast(String(e.message || e)); }
      }
    }
  }
  await persistBoard();
  refreshBoard();
}

function itemPointer(e, el, key, fullPath) {
  if (e.button !== 0) return;
  hideMenu();
  // Ctrl/Cmd+click: toggle this item in/out of the selection only.
  if (e.ctrlKey || e.metaKey) {
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    renderBoardSelection();
    return;
  }
  // Dragging an unselected item selects it alone first (standard).
  if (!selection.has(key)) {
    selection = new Set([key]);
    renderBoardSelection();
  }
  // Suppress auto-refresh for the WHOLE press: a poll/fs re-render
  // detaches these elements, which silently kills pointer capture.
  dragging = true;
  const m = metrics();
  const group = [...selection].map((k) => {
    const cell = cells.get(k);
    const gel = boardArea.querySelector(`.item[data-key="${CSS.escape(k)}"]`);
    if (!cell || !gel) return null;
    return {
      key: k, el: gel, cell: [cell[0], cell[1]],
      left: gel.offsetLeft, top: gel.offsetTop,
      // pathOfKey resolves BOTH resident ("file:") and linked
      // ("link:") keys to their real file path; notes get null.
      path: pathOfKey(k),
    };
  }).filter(Boolean);
  const anchor = group.find((g) => g.key === key) || group[0];
  if (!anchor) { dragging = false; return; }
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  let lastCursor = null; // OS cursor position (screen coords), polled
  el.setPointerCapture(e.pointerId);
  // Backup exit signal: while dragging, poll the OS cursor position
  // in the main process. Pointer capture can clamp the renderer's
  // own coordinates at the window edge, so this is the reliable
  // "the pointer really is outside" witness.
  const poll = setInterval(() => {
    api.cursorPoint().then((p) => { if (p) lastCursor = p; }).catch(() => {});
  }, 120);
  const cleanup = () => {
    clearInterval(poll);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
  };
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 6) {
      moved = true;
      for (const g of group) g.el.classList.add('dragging');
    }
    if (!moved) return;
    for (const g of group) {
      g.el.style.left = (g.left + dx) + 'px';
      g.el.style.top = (g.top + dy) + 'px';
    }
  };
  const finishInternal = () => {
    // nearest cell to the anchor item's top-left (v7 pos_to_cell rule)
    const target = [
      Math.max(0, Math.round((anchor.el.offsetLeft - ORIGIN) / m.cellW)),
      Math.max(0, Math.round((anchor.el.offsetTop - ORIGIN) / m.cellH)),
    ];
    const plan = planGroupMove(group.map((g) => g.key),
      target[0] - anchor.cell[0], target[1] - anchor.cell[1], m.rows);
    if (plan === null) { renderBoard(); return; } // blocked -> whole group reverts
    for (const [k, c] of plan.entries()) cells.set(k, c);
    // persist FIRST: renderBoard() rebuilds cells from boardData.
    persistBoard();
    renderBoard();
  };
  const onUp = async (ev) => {
    cleanup();
    for (const g of group) g.el.classList.remove('dragging');
    dragging = false;
    if (!moved) {
      // plain click: collapse to just this item
      selection = new Set([key]);
      renderBoardSelection();
      return;
    }
    // ---- was the pointer released OUTSIDE the window? ----
    let outside = ev.clientX < 0 || ev.clientY < 0 ||
      ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
    let screenPt = { x: ev.screenX, y: ev.screenY };
    if (lastCursor) {
      const cx = lastCursor.x - window.screenX;
      const cy = lastCursor.y - window.screenY;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
        outside = true;
        screenPt = lastCursor;
      }
    }
    // Partition the dragged group by item kind. Notes have no file
    // at all. Since v2.1 BOTH file kinds perform the same real
    // move on an outside release: resident files move out of the
    // board folder, and LINKED originals move out of their home
    // path (their link is detached, and they land visible). What
    // changed vs v2.0: a linked drag-out is no longer "unlink
    // wherever you drop it" — if the drop point does not resolve
    // to a folder, the whole gesture cancels and nothing changes.
    const linkedPaths = group.filter((g) => g.key.startsWith('link:'))
      .map((g) => g.path).filter(Boolean);
    const residentPaths = group.filter((g) => g.key.startsWith('file:'))
      .map((g) => g.path).filter(Boolean);
    if (!outside || (!linkedPaths.length && !residentPaths.length)) {
      finishInternal();
      return;
    }
    // ---- outside release: self-implemented MOVE (no startDrag) --
    renderBoard(); // items snap back while main works
    toast('移動先を判定しています…', 15000);
    let res = null;
    try {
      res = await api.resolveDropMove({
        boardName: boardData.name,
        paths: residentPaths,
        linkedPaths,
        screenX: screenPt.x,
        screenY: screenPt.y,
      });
    } catch (err) { res = null; }
    if (res && res.moved && res.moved.length) {
      const movedSet = new Set(res.moved);
      const movedLinked = new Set(linkedPaths.filter((p) => movedSet.has(p)));
      for (const g of group) {
        if (g.path && movedSet.has(g.path)) {
          cells.delete(g.key);
          selection.delete(g.key);
        }
      }
      if (movedLinked.size) {
        boardData.links = boardData.links.filter((l) => !movedLinked.has(l.path));
      }
      await persistBoard();
      const isDesktop = res.resolved && res.resolved.type === 'desktop';
      let msg = isDesktop ? 'デスクトップへ移動しました' : 'フォルダへ移動しました';
      // Positioning is best-effort; only the auto-arrange case adds
      // a note (the move itself still succeeded).
      if (isDesktop && res.positionNote) msg += '。' + res.positionNote;
      toast(msg);
      refreshBoard();
    } else {
      // unknown target / failure: NOTHING was moved or unlinked.
      // Plain removal without moving is the ボードから外す menu.
      toast('落とした場所が判定できませんでした');
      renderBoard();
    }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

function moveKeyTo(key, target) {
  const old = cells.get(key);
  if (old && old[0] === target[0] && old[1] === target[1]) return;
  let other = null;
  for (const [k, v] of cells.entries()) {
    if (k !== key && v[0] === target[0] && v[1] === target[1]) { other = k; break; }
  }
  if (other !== null) {
    if (!old) return;
    cells.set(other, old);
  }
  cells.set(key, target);
}

async function renameItemFlow(key, fullPath, oldName) {
  const v = await promptModal({ title: '名前を変更', value: oldName });
  if (v === null || v.trim() === oldName) return;
  try {
    await api.renameItem(fullPath, v.trim());
    if (cells.has(key)) {
      const c = cells.get(key);
      cells.delete(key);
      cells.set('file:' + v.trim(), c);
    }
    await persistBoard();
    refreshBoard();
  } catch (e) { toast(String(e.message || e)); }
}

// Renaming a LINKED item renames the real file at its original
// path — which is exactly what breaks other apps' references, so
// the modal carries the one-line warning the user asked to see.
async function renameLinkedFlow(key, link) {
  if (!link) return;
  const v = await promptModal({
    title: '名前を変更', value: link.name,
    note: '名前を変えるとAviUtl等の参照が切れます',
  });
  if (v === null || v.trim() === link.name) return;
  try {
    const dest = await api.renameLinked(boardData.name, link.path, v.trim());
    if (cells.has(key)) {
      const c = cells.get(key);
      cells.delete(key);
      cells.set('link:' + dest, c);
    }
    if (selection.has(key)) {
      selection.delete(key);
      selection.add('link:' + dest);
    }
    link.path = dest;
    link.name = v.trim();
    await persistBoard();
    refreshBoard();
  } catch (e) { toast(String(e.message || e)); }
}

async function editNoteFlow(key) {
  const note = boardData.notes.find((n) => 'note:' + n.id === key);
  if (!note) return;
  const v = await promptModal({ title: 'メモを編集', value: note.text, multiline: true });
  if (v === null) return;
  note.text = v;
  await persistBoard();
  renderBoard();
}

async function refreshBoard() {
  if (!boardData) return;
  const name = boardData.name;
  try {
    boardData = await api.getBoard(name);
    // A refresh requested before a drag started can resolve DURING
    // the drag; rendering then would wipe the dragged elements /
    // rubber band mid-gesture. Re-check at render time.
    if (dragging) return;
    if (view === 'board') renderBoard();
  } catch (e) { /* board folder may be gone */ }
}

async function openBoard(name) {
  boardData = await api.getBoard(name);
  view = 'board';
  selection = new Set(); // selection never carries across boards

  homeView.hidden = true;
  boardView.hidden = false;
  renderBoard();
}

// ------------------------------------------------------------ events
$('backBtn').addEventListener('click', async () => {
  view = 'home';
  boardView.hidden = true;
  homeView.hidden = false;
  await api.watchHome();
  refreshHome();
});
$('homeThemeBtn').addEventListener('click', cycleTheme);
$('boardThemeBtn').addEventListener('click', cycleTheme);
$('addBoardBtn').addEventListener('click', async () => {
  const v = await promptModal({ title: '新しいボードの名前' });
  if (v === null) return;
  try {
    homeData = await api.createBoard(v);
    renderHome();
  } catch (e) { toast(String(e.message || e)); }
});
$('percentSel').addEventListener('change', async (e) => {
  const p = parseInt(e.target.value, 10);
  if (!PERCENTS.includes(p) || !boardData) return;
  boardData.sizePercent = p;
  renderBoard();
  await persistBoard();
});

// ------------------------------------------- rubber-band selection
// PRIMARY multi-select (desktop style, no modifier needed): drag on
// empty board area -> a translucent blue rectangle is drawn live and
// every item it touches becomes the selection (replacing, unless
// Ctrl/Cmd is held, in which case it adds). A plain click on empty
// area just clears the selection.
boardArea.addEventListener('pointerdown', (e) => {
  if (e.target !== boardArea || e.button !== 0) return;
  hideMenu();
  const additive = e.ctrlKey || e.metaKey;
  const baseSel = additive ? new Set(selection) : new Set();
  if (!additive) { selection = new Set(); renderBoardSelection(); }
  const rect = boardArea.getBoundingClientRect();
  const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
  let band = null;
  let moved = false;
  dragging = true; // pause auto-refresh from pointerdown, not threshold
  const onMove = (ev) => {
    const x1 = ev.clientX - rect.left, y1 = ev.clientY - rect.top;
    if (!moved && Math.hypot(x1 - x0, y1 - y0) > 4) {
      moved = true;
      dragging = true; // pause auto-refresh while banding
      band = document.createElement('div');
      band.className = 'rubber-band';
      boardArea.appendChild(band);
    }
    if (!moved) return;
    const bx = Math.min(x0, x1), by = Math.min(y0, y1);
    const bw = Math.abs(x1 - x0), bh = Math.abs(y1 - y0);
    band.style.left = bx + 'px';
    band.style.top = by + 'px';
    band.style.width = bw + 'px';
    band.style.height = bh + 'px';
    const sel = new Set(baseSel);
    for (const itemEl of boardArea.querySelectorAll('.item')) {
      const ix = itemEl.offsetLeft, iy = itemEl.offsetTop;
      const iw = itemEl.offsetWidth, ih = itemEl.offsetHeight;
      if (ix < bx + bw && ix + iw > bx && iy < by + bh && iy + ih > by) {
        sel.add(itemEl.dataset.key);
      }
    }
    selection = sel;
    renderBoardSelection();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (band) band.remove();
    dragging = false;
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
});
boardArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  boardArea.classList.add('drop-active');
});
boardArea.addEventListener('dragleave', () => boardArea.classList.remove('drop-active'));
boardArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  boardArea.classList.remove('drop-active');
  if (!boardData) return;
  const paths = [...e.dataTransfer.files].map((f) => api.getPathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  // v2.0 intake: LINK, never move. The file stays at its original
  // path (AviUtl references survive); main hides it in place.
  try {
    const r = await api.linkFiles(boardData.name, paths);
    if (r && r.duplicates && r.duplicates.length) {
      toast('すでにボードに入っています');
    } else if (r && r.attribFailed && r.attribFailed.length) {
      toast('ボードに入れました（見た目を隠す印は付けられませんでした）');
    }
    refreshBoard();
  } catch (err) { toast(String(err.message || err)); }
});
window.addEventListener('resize', () => {
  if (view === 'board') renderBoard();
});

// external changes: watcher events + 2s polling + focus refresh
api.onFsChanged(() => { if (!busy && !dragging) (view === 'board' ? refreshBoard() : refreshHome()); });
setInterval(() => { if (!busy && !dragging) (view === 'board' ? refreshBoard() : refreshHome()); }, 2000);
window.addEventListener('focus', () => { if (!busy && !dragging) (view === 'board' ? refreshBoard() : refreshHome()); });

// ------------------------------------------- board-shortcut routing
// Launched from a board shortcut (--board-path), the app opens
// directly into that board instead of the home screen; when the
// board is gone, a one-line note explains it. The same route arrives
// live whenever a shortcut is double-clicked while the app is
// already running (main's second-instance handler forwards it).
async function applyRoute(route) {
  if (!route) return;
  if (route.boardName) {
    if (view === 'board' && boardData && boardData.name === route.boardName) return;
    try { await openBoard(route.boardName); } catch (e) { /* stay home */ }
  } else if (route.invalidBoard) {
    toast('ショートカット先のボードが見つかりませんでした');
  }
}
api.onOpenBoardRequest((route) => { applyRoute(route); });

// ---------------------------------------------------------------- init
(async () => {
  await refreshHome();
  try { await applyRoute(await api.getStartupRoute()); } catch (e) {}
})();
