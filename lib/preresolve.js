'use strict';
/*
 * Drag-out PRE-RESOLUTION cache (v2.2.2).
 *
 * The user's complaint after v2.2: dragging out to the desktop
 * still did not feel snappy （サクッと). The warm helper had
 * removed the PowerShell cold starts, but the release pipeline
 * still ran strictly sequentially AFTER the release: detect ->
 * resolve -> move -> position, and the card stayed on screen
 * until all of it finished. This module is the pure half of the
 * fix: while a drag is in progress, main polls the OS cursor and
 * resolves the drop target for OUTSIDE points AHEAD of time.
 * At release, a cached answer whose point is close to the
 * release point (and fresh enough) is used immediately — zero
 * resolve round-trip on the critical path.
 *
 * Pure and clock-injected so tools/selftest.js can drive every
 * rule (throttle, staleness, acceptance radius, superseded
 * answers) without a clock or a shell:
 *
 *   const cache = createPreResolver({ resolve });
 *   cache.observe(x, y, nowMs);  // an outside cursor sample
 *   const hit = cache.lookup(x, y, nowMs); // -> { target, ageMs } | null
 *   cache.reset();
 *
 * Rules:
 *   - an observe() fires resolve() when there is no answer yet,
 *     when the point moved >= REFETCH_DISTANCE_PX from the last
 *     fired point, or when the last fire is older than
 *     REFETCH_AFTER_MS (a resting cursor still refreshes);
 *   - a fired resolution that is superseded by a newer fire
 *     before it lands is DROPPED (its point is stale news);
 *   - resolver failures cache nothing (the release-time resolve
 *     runs as before);
 *   - lookup() accepts only an answer whose point is within
 *     ACCEPT_RADIUS_PX of the release point and whose age is at
 *     most MAX_AGE_MS — anything else misses and the caller
 *     resolves the old way.
 */

const REFETCH_DISTANCE_PX = 8;   // spec: refire when moved >= 8px
const REFETCH_AFTER_MS = 300;    // spec: or when older than 300ms
const ACCEPT_RADIUS_PX = 12;     // spec: release within ~12px hits
const MAX_AGE_MS = 1500;         // acceptance cap (poll stalls etc.)

function createPreResolver(opts) {
  const resolve = (opts && typeof opts.resolve === 'function')
    ? opts.resolve
    : () => null;

  let fired = null;   // { x, y, at } of the latest fired resolve
  let answer = null;  // { x, y, at, target } of the latest LANDED answer
  let fireSeq = 0;

  function fire(x, y, now) {
    const seq = ++fireSeq;
    fired = { x, y, at: now };
    let out;
    try {
      out = resolve(x, y);
    } catch (e) {
      return; // resolver threw: cache nothing
    }
    if (out && typeof out.then === 'function') {
      out.then((target) => {
        if (seq !== fireSeq) return; // superseded while in flight
        if (target) answer = { x, y, at: now, target };
      }, () => { /* failure: cache nothing */ });
    } else if (out) {
      answer = { x, y, at: now, target: out };
    }
  }

  function observe(x, y, now) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now)) return;
    if (!fired) { fire(x, y, now); return; }
    const moved = Math.hypot(x - fired.x, y - fired.y);
    if (moved >= REFETCH_DISTANCE_PX || now - fired.at >= REFETCH_AFTER_MS) {
      fire(x, y, now);
    }
  }

  function lookup(x, y, now) {
    if (!answer) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now)) return null;
    const ageMs = now - answer.at;
    if (ageMs < 0 || ageMs > MAX_AGE_MS) return null;
    if (Math.hypot(x - answer.x, y - answer.y) > ACCEPT_RADIUS_PX) return null;
    return { target: answer.target, ageMs };
  }

  function reset() {
    fired = null;
    answer = null;
    fireSeq++; // any in-flight answer is now superseded
  }

  function size() { return answer ? 1 : 0; }

  return { observe, lookup, reset, size };
}

module.exports = {
  createPreResolver,
  REFETCH_DISTANCE_PX,
  REFETCH_AFTER_MS,
  ACCEPT_RADIUS_PX,
  MAX_AGE_MS,
};
