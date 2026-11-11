
'use strict';const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8').replace(/\r\n/g,'\n'),s=read('formal-unknown-dpi-empty-ci.ps1'),original=read('desktop-dpi-empty-ci.ps1');
assert(s.includes("Join-Path $PSScriptRoot 'formal-unknown-success-ci.js'"));assert(!s.includes("Join-Path $PSScriptRoot 'unknown-grid-success-ci.js'"));
for(const guard of ["$native.WaitForExit(240000)","$exitKnown=($native.HasExited -and $null -ne $report.nativeExitCode)","$n.cleanupVerified -eq $true","-not $n.cleanupError","$n.actualScale -eq 150","($n.cases -join ',') -ceq 'success,no-fit'","$r.restoreSkippedDueToUnresolvedLease","$safeRestore=$false",'OKIBA_UNKNOWN_EXPECTED_SCALE','OKIBA_UNKNOWN_CASES'])assert(s.includes(guard)&&original.includes(guard),guard);
assert(s.includes("$source=$source.Replace('desktop-dpi-ui-ci.json','formal-unknown-dpi-ui-ci.json')"));
assert(read('formal-unknown-dpi-empty-fixture-ci.js').replaceAll('formal-unknown-dpi-empty-fixture.json','dpi-empty-fixture.json')===read('desktop-dpi-empty-fixture-ci.js'));
assert(!s.includes('$env:SCRIPT'));console.log('PASS fixed formal native entry, unchanged fixture logic and unresolved-lease restore gates');
