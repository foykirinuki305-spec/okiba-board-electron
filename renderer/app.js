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
let selectedKey = null;
let busy = false;         // modal or menu open -> pause auto refresh
let dragging = false;

const SVG = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" opacity=".9"/><path d="M14 3l4 4h-4z" fill="#fff" opacity=".45"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="6.5" cy="18" r="2.8" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.8" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5" fill="currentColor" opacity=".9"/><path d="M16 10.5l5-3v9l-5-3z" fill="currentColor"/></svg>',
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3200);
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
function promptModal({ title, value = '', multiline = false }) {
  return new Promise((resolve) => {
    busy = true;
    const overlay = $('modalOverlay');
    const input = $('modalInput'), area = $('modalArea'), err = $('modalError');
    $('modalTitle').textContent = title;
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

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
    card.dataset.name = b.name;
    const collage = document.createElement('div');
    collage.className = 'collage';
    if (b.thumbs.length) {
      for (const u of b.thumbs) {
        const im = document.createElement('img');
        im.src = u; im.alt = '';
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
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 7) {
      moved = true; dragging = true;
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
    else {
      const note = notes.find((n) => 'note:' + n.id === key);
      if (note) { note.col = c[0]; note.row = c[1]; }
    }
  }
  boardData.positions = positions;
  boardData.notes = notes;
  try {
    await api.saveBoard(boardData.name, positions, notes, boardData.sizePercent);
  } catch (e) { toast(String(e.message || e)); }
}

function renderBoard() {
  if (!boardData) return;
  $('boardTitle').textContent = boardData.name;
  $('percentSel').value = String(boardData.sizePercent);
  buildCells();
  const m = metrics();
  boardArea.innerHTML = '';
  const renderItem = (key, kind, label, fullPath, noteText) => {
    const c = cells.get(key);
    if (!c) return;
    const el = document.createElement('div');
    el.className = 'item' + (key === selectedKey ? ' selected' : '');
    el.dataset.key = key;
    el.style.left = (ORIGIN + c[0] * m.cellW) + 'px';
    el.style.top = (ORIGIN + c[1] * m.cellH) + 'px';
    el.style.width = m.cellW + 'px';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.width = m.thumb + 'px';
    thumb.style.height = m.thumb + 'px';
    if ((kind === 'image' || kind === 'video') && fullPath) {
      const img = document.createElement('img');
      img.alt = '';
      thumb.appendChild(img);
      const had = thumbCache.get(fullPath);
      if (had) img.src = had;
      else {
        // show a tile until the thumbnail arrives
        thumb.appendChild(tileFor(kind));
        api.thumb(fullPath).then((url) => {
          thumbCache.set(fullPath, url);
          if (url && img.isConnected) { img.src = url; const t = thumb.querySelector('.tile'); if (t) t.remove(); }
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
    el.addEventListener('pointerdown', (e) => itemPointer(e, el, key, fullPath));
    el.addEventListener('dblclick', () => {
      if (kind === 'note') editNoteFlow(key);
      else if (fullPath) api.openItem(fullPath).catch((err) => toast(String(err.message || err)));
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedKey = key;
      renderBoardSelection();
      if (kind === 'note') {
        showMenu(e.clientX, e.clientY, [
          { label: '編集', action: () => editNoteFlow(key) },
          { label: 'ゴミ箱へ削除', danger: true, action: async () => {
              boardData.notes = boardData.notes.filter((n) => 'note:' + n.id !== key);
              cells.delete(key);
              await persistBoard(); renderBoard();
            } },
        ]);
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
    renderItem('file:' + e.name, e.kind, e.name, e.path, null);
  }
  for (const n of boardData.notes) {
    renderItem('note:' + n.id, 'note', n.text.split('\n')[0] || 'メモ', null, n.text);
  }
}

function renderBoardSelection() {
  for (const el of boardArea.querySelectorAll('.item')) {
    el.classList.toggle('selected', el.dataset.key === selectedKey);
  }
}

function itemPointer(e, el, key, fullPath) {
  if (e.button !== 0) return;
  hideMenu();
  selectedKey = key;
  renderBoardSelection();
  const startX = e.clientX, startY = e.clientY;
  const origLeft = el.offsetLeft, origTop = el.offsetTop;
  let moved = false, handedOff = false;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; dragging = true; el.classList.add('dragging'); }
    if (!moved) return;
    el.style.left = (origLeft + dx) + 'px';
    el.style.top = (origTop + dy) + 'px';
    // --- drag OUT handoff: pointer left the window while held ---
    if (!handedOff && fullPath &&
        (ev.clientX <= 0 || ev.clientY <= 0 ||
         ev.clientX >= window.innerWidth - 1 || ev.clientY >= window.innerHeight - 1)) {
      handedOff = true;
      dragging = false;
      el.classList.remove('dragging');
      cleanup();
      renderBoard(); // card returns to its cell while the OS drag runs
      api.startDrag(fullPath); // official Electron native drag
      setTimeout(refreshBoard, 900); // reflect move-out if it happened
    }
  };
  const onUp = () => {
    cleanup();
    if (handedOff) return;
    el.classList.remove('dragging');
    dragging = false;
    if (!moved) return;
    const m = metrics();
    // nearest cell to the item's top-left corner (v7 pos_to_cell rule)
    const cellTarget = [
      Math.max(0, Math.round((el.offsetLeft - ORIGIN) / m.cellW)),
      Math.max(0, Math.round((el.offsetTop - ORIGIN) / m.cellH)),
    ];
    moveKeyTo(key, cellTarget);
    renderBoard();
    persistBoard();
  };
  const cleanup = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
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
    if (view === 'board') renderBoard();
  } catch (e) { /* board folder may be gone */ }
}

async function openBoard(name) {
  boardData = await api.getBoard(name);
  view = 'board';
  selectedKey = null;
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

boardArea.addEventListener('pointerdown', (e) => {
  if (e.target === boardArea) { selectedKey = null; renderBoardSelection(); }
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
  try {
    await api.dropFiles(boardData.name, paths);
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

// ---------------------------------------------------------------- init
(async () => {
  await refreshHome();
})();
