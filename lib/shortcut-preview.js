'use strict';
const path = require('path').win32;
const folderUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f5c65c"/><path d="M1 15h8v8H1z" fill="white"/><path d="M3 21v-3h3v-2l3 3-3 3v-2H4v1z" fill="#2878bd"/></svg>');
const folderImage = { isEmpty: () => false, toDataURL: () => folderUrl };
function createFileIconResolver({ readShortcutLink, getFileIcon, stat, loadIcon, env = process.env }) {
  function expand(value, base) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const text = value.replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (whole, name) => {
      const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? env[key] : whole;
    });
    return path.isAbsolute(text) ? text : path.resolve(path.dirname(base), text);
  }
  return async function fileIcon(fullPath, options) {
    if (!/\.lnk$/i.test(fullPath)) return getFileIcon(fullPath, options);
    let current = fullPath;
    const seen = new Set();
    try {
      for (let depth = 0; depth < 4; depth++) {
        const id = current.toLowerCase();
        if (seen.has(id)) break;
        seen.add(id);
        const info = await readShortcutLink(current); // Read only: never resolve by launching.
        const icon = expand(info.icon, current);
        if (icon && /\.ico$/i.test(icon)) {
          try {
            const st = await stat(icon);
            if (st.isFile() && st.size <= 4 * 1024 * 1024) {
              const img = await loadIcon(icon);
              if (img && !img.isEmpty()) return img;
            }
          } catch (_) {}
        }
        // Electron cannot extract a selected EXE/DLL icon resource by index.
        // Prefer the actual target's default icon over a wrong indexed icon.
        const target = expand(info.target, current);
        if (!target) break;
        const st = await stat(target);
        if (st.isDirectory()) return folderImage;
        if (!st.isFile()) break;
        if (/\.lnk$/i.test(target)) { current = target; continue; }
        return await getFileIcon(target, options);
      }
    } catch (_) {}
    return getFileIcon(fullPath, options); // broken/unsupported shortcut: generic shell icon
  };
}
module.exports = { createFileIconResolver };
