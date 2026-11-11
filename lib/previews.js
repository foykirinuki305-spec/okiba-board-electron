'use strict';
// Async, bounded native shell preview work. Nothing here changes board data.
function createPreviewService({ stat, thumbnail, fileIcon, isMedia,
  concurrency = 3, maxCache = 400, maxPending = 256, now = Date.now }) {
  const cache = new Map(), latest = new Map(), pending = new Map(), queue = [];
  let active = 0;
  const touch = (map, key, value) => {
    map.delete(key); map.set(key, value);
    while (map.size > maxCache) map.delete(map.keys().next().value);
  };
  const requestKey = (p, px) => JSON.stringify([p, px]);
  const size = px => Math.max(32, Math.min(512, Math.round(Number(px) || 300)));
  const dataUrl = image => {
    try { return image && !image.isEmpty() ? image.toDataURL() : null; }
    catch (_) { return null; }
  };
  async function make(fullPath, px, key) {
    let st;
    try { st = await stat(fullPath); } catch (_) { latest.delete(key); return null; }
    // Electron/Windows returns a drive icon for ordinary directories on
    // supported test hosts. Keep the recognisable folder tile instead.
    if (!st.isFile()) return null;
    const version = JSON.stringify([fullPath, px, st.mtimeMs, st.size, st.isDirectory()]);
    const hit = cache.get(version);
    if (hit && (!hit.retry || now() - hit.at < 15000)) {
      touch(cache, version, hit);
      touch(latest, key, { url: hit.url, at: now() });
      return hit.url;
    }
    let url = null;
    const media = st.isFile() && isMedia(fullPath);
    let thumbnailReady = false;
    if (media) {
      try { url = dataUrl(await thumbnail(fullPath, { width: px, height: px })); } catch (_) {}
      thumbnailReady = !!url;
    }
    if (!url) {
      try { url = dataUrl(await fileIcon(fullPath, { size: 'large' })); } catch (_) {}
    }
    touch(cache, version, { url, at: now(), retry: !url || (media && !thumbnailReady) || /\.lnk$/i.test(fullPath) });
    touch(latest, key, { url, at: now() });
    return url;
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++;
      Promise.resolve().then(() => make(task.fullPath, task.px, task.key))
        .catch(() => null).then(url => {
          pending.delete(task.key); active--; task.resolve(url); pump();
        });
    }
  }
  function get(fullPath, px = 300) {
    if (typeof fullPath !== 'string' || !fullPath || fullPath.includes('\0')) return Promise.resolve(null);
    px = size(px);
    const key = requestKey(fullPath, px);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return Promise.resolve(null);
    const promise = new Promise(resolve => queue.push({ fullPath, px, key, resolve }));
    pending.set(key, promise); pump();
    return promise;
  }
  function peek(fullPath, px = 300, onReady = () => {}) {
    px = size(px);
    const key = requestKey(fullPath, px), hit = latest.get(key);
    // Cache-first home paint. Refresh metadata in the background, not on UI.
    if ((!hit || now() - hit.at >= 5000) && !pending.has(key)) {
      get(fullPath, px).then(url => {
        if (url !== (hit ? hit.url : null)) onReady(url);
      }).catch(() => {});
    }
    return hit ? hit.url : null;
  }
  return { get, peek };
}
module.exports = { createPreviewService };
