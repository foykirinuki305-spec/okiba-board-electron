'use strict';
/*
 * Anchored intake placement (v2.2, Job B).
 *
 * Until v2.1, files dropped onto a board were appended: the renderer
 * handed every position-less item the next free cell from (0,0), so a
 * vertical strip of icons selected on the desktop landed at the
 * bottom of whatever the board already held. The user asked for the
 * opposite: items should land AT the cell he aimed at, keeping the
 * arrangement they had where they came from (a vertical strip on the
 * desktop arrives as the same strip; running past the bottom of a
 * column may shift things — he explicitly accepted that).
 *
 * This module is the pure core:
 *
 *   placeItems({ occupied, anchor, offsets, count, rowsPerCol })
 *     For each item, in order: preferred = anchor + offset (offsets
 *     default to a vertical strip (0, i) in drop order). If the
 *     preferred cell is taken or out of the grid, scan FORWARD from
 *     it — down the column, then on to the next columns, the board's
 *     existing fill order — to the nearest free cell. Existing items
 *     are never overwritten, swapped or displaced; processing items
 *     in order keeps their relative order.
 *
 *   computeCells({ entries, positions, notes, links, rowsPerCol })
 *     Replicates renderer buildCells() exactly, so the MAIN process
 *     can know the board's true occupancy at intake time (saved
 *     positions first, then position-less residents / links appended
 *     in render order by the same column-fill scan).
 *
 *   cellsFromDesktopPositions(posResult, names)
 *     Turns the warm helper's getDesktopPositions answer (icon pixel
 *     positions + grid spacing) into per-name grid cells, so a drop
 *     that came from the desktop can reuse the desktop arrangement
 *     as relative offsets (planDesktopOffsets).
 */
const bf = require('./boardfs');

const key = (c, r) => c + ',' + r;

// Linear index in the board's fill order (column by column). Scanning
// forward in this index IS "down the column, then next columns".
function idxOf(col, row, rowsPerCol) {
  return col * rowsPerCol + row;
}
function cellOfIdx(idx, rowsPerCol) {
  return [Math.floor(idx / rowsPerCol), idx % rowsPerCol];
}

/*
 * Place `count` items. `offsets` (optional) is an array of [dcol,
 * drow] per item; missing entries default to the vertical strip
 * (0, i). Returns an array of [col, row] per item, in item order.
 */
function placeItems({ occupied, anchor, offsets, count, rowsPerCol }) {
  const rows = Math.max(1, rowsPerCol | 0);
  const occ = new Set(occupied || []);
  const a = Array.isArray(anchor) ? anchor : [0, 0];
  const cells = [];
  // Generous scan bound: the occupied set is finite, so a free cell
  // always exists within occ.size + count steps of any start; the
  // extra slack only guards against pathological inputs.
  const maxSteps = occ.size + count + 4096;
  for (let i = 0; i < count; i++) {
    const off = (offsets && offsets[i]) || [0, i];
    let pc = (a[0] | 0) + (off[0] | 0);
    let pr = (a[1] | 0) + (off[1] | 0);
    if (pc < 0) pc = 0;
    if (pr < 0) pr = 0;
    let idx = idxOf(pc, pr, rows);
    let steps = 0;
    let cell = cellOfIdx(idx, rows);
    while (occ.has(key(cell[0], cell[1]))) {
      idx += 1;
      steps += 1;
      if (steps > maxSteps) throw new Error('placement: no free cell within scan bound');
      cell = cellOfIdx(idx, rows);
    }
    occ.add(key(cell[0], cell[1]));
    cells.push(cell);
  }
  return cells;
}

/*
 * Replicate the renderer's buildCells() assignment so main knows
 * which cell every current board item occupies:
 *   1. residents with a saved position, notes, links with a saved
 *      cell — taken as-is, in that order;
 *   2. residents without one (entries order), then links without one
 *      (json order) — appended by the column-fill scan from (0,0).
 * (Renderer order is entries → notes → links; notes always carry a
 * cell in the json, so their append phase never fires.)
 *
 * Returns { cells: Map<itemKey, [col,row]>, occupied: Set<'c,r'> }
 * where itemKey is 'file:<name>' for residents, 'note:<id>' for
 * notes and 'link:<path>' for links.
 */
function computeCells({ entries, positions, notes, links, rowsPerCol }) {
  const rows = Math.max(1, rowsPerCol | 0);
  const cells = new Map();
  const occupied = new Set();
  const take = (k, cell) => {
    cells.set(k, cell);
    occupied.add(key(cell[0], cell[1]));
  };
  const pos = positions || {};
  for (const e of entries || []) {
    const p = pos[e.name];
    if (Array.isArray(p)) take('file:' + e.name, [p[0] | 0, p[1] | 0]);
  }
  for (const n of notes || []) {
    if (Number.isFinite(n.col) && Number.isFinite(n.row)) {
      take('note:' + n.id, [n.col | 0, n.row | 0]);
    }
  }
  for (const l of links || []) {
    if (Number.isFinite(l.col) && Number.isFinite(l.row)) {
      take('link:' + l.path, [l.col | 0, l.row | 0]);
    }
  }
  for (const e of entries || []) {
    const k = 'file:' + e.name;
    if (!cells.has(k)) take(k, bf.nextFreeCell(occupied, rows));
  }
  for (const l of links || []) {
    const k = 'link:' + l.path;
    if (!cells.has(k)) take(k, bf.nextFreeCell(occupied, rows));
  }
  return { cells, occupied };
}

/*
 * Convert the helper's getDesktopPositions result
 *   { positions: { <name>: {x, y} }, sx, sy }
 * into a Map name -> [col, row] (only for names actually found).
 * Icon origins sit at col*sx / row*sy plus a few px, so rounding to
 * the nearest grid step recovers the cell.
 */
function cellsFromDesktopPositions(posResult, names) {
  const out = new Map();
  if (!posResult || !posResult.positions) return out;
  const sx = posResult.sx > 0 ? posResult.sx : 100;
  const sy = posResult.sy > 0 ? posResult.sy : 100;
  for (const name of names || []) {
    const p = posResult.positions[name];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out.set(name, [Math.max(0, Math.round(p.x / sx)), Math.max(0, Math.round(p.y / sy))]);
  }
  return out;
}

/*
 * Given items [{ key, cell }] (cell from cellsFromDesktopPositions),
 * produce { order, offsets }: items sorted by their desktop (col,
 * then row) and each item's offset relative to the top-left-most
 * cell, so placeItems() reproduces the desktop arrangement at the
 * anchor. Returns null when there is nothing usable.
 */
function planDesktopOffsets(items) {
  const usable = (items || []).filter((it) => it && Array.isArray(it.cell));
  if (!usable.length) return null;
  const sorted = usable.slice().sort((a, b) => (a.cell[0] - b.cell[0]) || (a.cell[1] - b.cell[1]));
  const minC = Math.min(...sorted.map((it) => it.cell[0]));
  const minR = Math.min(...sorted.map((it) => it.cell[1]));
  return {
    order: sorted.map((it) => it.key),
    offsets: sorted.map((it) => [it.cell[0] - minC, it.cell[1] - minR]),
  };
}

module.exports = {
  placeItems,
  computeCells,
  cellsFromDesktopPositions,
  planDesktopOffsets,
};
