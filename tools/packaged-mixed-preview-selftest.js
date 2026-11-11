
'use strict';const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'packaged-mixed-preview-ci.js'),'utf8'),p=fs.readFileSync(path.join(__dirname,'packaged-mixed-preview-support-ci.ps1'),'utf8');
for(const required of ['policy.hosted(process.env,process.platform)','window.okiba.safeTakeout(payload)',"'dist/win-unpacked/OkibaBoard.exe'",'linkedPaths:links.map','residents.map','keepRecord','beforeHash','report.history','mixed-hidden-resident','report.finalFileObservations'])assert(s.includes(required),required);
assert(!s.includes('OKIBA_MIXED_LEASE'));assert(!s.includes('runLease('));assert(!s.includes('SetFlagsForCI'));
assert(s.indexOf('await stop();await snapshot();')<s.indexOf("await support('hide'"));assert(s.indexOf("assert(invisible,'owned files not invisible')")<s.indexOf('fs.unlinkSync(f.path)'));
assert(p.includes('$parsed.Count -ne 6'));assert(p.includes('-[123456]\\.txt$'));assert(p.includes('SetRecordedAndNotify'));assert(p.includes('$n.identity -cne $r.identity'));assert(!p.includes('Remove-Item'));
console.log('PASS packaged mixed static isolation/cleanup/metadata/receipt/shape guards; no native operation');
