'use strict';const assert=require('assert/strict'),{allowed}=require('./desktop-dpi-empty-fixture-ci');
const p='C:\\Users\\Public\\Desktop';
assert(allowed(p+'\\Firefox.lnk',p));
for(const v of [p+'\\mine.lnk','C:\\Users\\keiya\\Desktop\\Firefox.lnk',p+'\\x\\Firefox.lnk',p+'\\Firefox.exe',null])assert(!allowed(v,p));
console.log('fixture allowlist 6 checks PASS; no Desktop access');
