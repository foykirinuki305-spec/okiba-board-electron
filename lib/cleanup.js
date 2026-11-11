'use strict';
// Legacy cleanup planner retained as a non-destructive compatibility API.
// Latest policy: updates preserve all Desktop/Downloads items unchanged.
const path = require('path');

const PORTABLE_NAME = 'OkibaBoard.exe';
const SETUP_PREFIX = 'OkibaBoard-Setup-';
const SETUP_SUFFIX = '.exe';

function isPortableName(name) {
  return name === PORTABLE_NAME;
}

function isSetupName(name) {
  return typeof name === 'string' &&
    name.startsWith(SETUP_PREFIX) &&
    name.endsWith(SETUP_SUFFIX) &&
    name.length > SETUP_PREFIX.length + SETUP_SUFFIX.length;
}

// A loose exe file name this cleanup is responsible for.
function isAppExeName(name) {
  return isPortableName(name) || isSetupName(name);
}

// Path identity, Windows-style: resolved + case-insensitive on
// win32 (mirrors lib/links.samePath), verbatim elsewhere.
function samePath(a, b) {
  if (!a || !b) return false;
  let ra, rb;
  try { ra = path.resolve(a); } catch (e) { ra = a; }
  try { rb = path.resolve(b); } catch (e) { rb = b; }
  if (process.platform === 'win32') {
    return ra.toLowerCase() === rb.toLowerCase();
  }
  return ra === rb;
}

// Cleanup runs once per version change: the stored marker (the
// base .home.json `appVersion`) differs from the running version
// (absent marker counts as different — a pre-v2.2.1 install has
// never cleaned up).
function shouldRunCleanup(currentVersion, storedVersion) {
  if (!currentVersion) return false;
  return storedVersion !== currentVersion;
}

// Backward-compatible result shape. Automatic cleanup is permanently inert.
function planCleanup() {
  // Compatibility API only. Startup/update must never delete or replace user
  // Desktop/Downloads files, including stale app and board shortcuts.
  return { deleteFiles: [], deleteShortcuts: [], healShortcuts: [] };
}
module.exports = {
  PORTABLE_NAME,
  isPortableName,
  isSetupName,
  isAppExeName,
  samePath,
  shouldRunCleanup,
  planCleanup,
};
