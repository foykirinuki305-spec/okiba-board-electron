
'use strict';const assert=require('assert/strict'),{readConfig}=require('./unknown-grid-run-config-ci');
assert.deepEqual(readConfig({}),{expectedScale:100,cases:['success','duplicate-requests','no-fit']});
assert.deepEqual(readConfig({OKIBA_UNKNOWN_EXPECTED_SCALE:'150',OKIBA_UNKNOWN_CASES:'success,no-fit'}),{expectedScale:150,cases:['success','no-fit']});
for(const scale of ['', '149','150.0','NaN','1000',' 150'])assert.throws(()=>readConfig({OKIBA_UNKNOWN_EXPECTED_SCALE:scale}));
for(const cases of ['', 'success','no-fit','success,no-fit,success','success,other','success, no-fit'])assert.throws(()=>readConfig({OKIBA_UNKNOWN_CASES:cases}));
const env={OKIBA_UNKNOWN_EXPECTED_SCALE:'150'};readConfig(env);assert.deepEqual(env,{OKIBA_UNKNOWN_EXPECTED_SCALE:'150'});
console.log('PASS strict unknown hosted expected-scale/case selection; no geometry mutation or Desktop API');
