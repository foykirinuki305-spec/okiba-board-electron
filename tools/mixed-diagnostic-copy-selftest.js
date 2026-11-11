 'use strict';
const fs=require('fs'),assert=require('assert/strict'),{instrumentMixed}=require('./mixed-diagnostic-copy-ci');
const s=fs.readFileSync(require('path').join(__dirname,'../scripts/mixed-lease.ps1'),'utf8'),r=instrumentMixed(s);
assert.throws(()=>instrumentMixed(r));assert.throws(()=>instrumentMixed(s.replace('$stable=0;$poll=0;$previousSelected=$null','bad')));
for(const word of ['Start-Sleep','Lease-SetSnap','Lease-SetHidden','RestoreMoved','RestoreUnmoved','Lease-Guard $r $s','Lease-Snapshot'])assert.equal(r.split(word).length,s.split(word).length,word+' operations unchanged');
assert(r.includes('oldGuardPassed=$true'));assert(r.includes('visibility-snapshot-failed'));assert(r.includes('visibility-guard-failed'));assert(r.includes('lastFull=$lastFull'));
console.log('PASS CI-copy observability unique anchors, unchanged mutation/guard/wait counts, rethrow-only failures');
