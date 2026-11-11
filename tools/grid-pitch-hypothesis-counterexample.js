// Deliberately demonstrates an UNSOUND shortcut. Never import into production.
'use strict';const assert=require('assert/strict');
const snap=(q,p,o)=>o+Math.floor((q-o)/p+.5)*p;
function sparseHypothesisProof(p,center,measure){
 const first=measure(center),o=((first%p)+p)%p,cell=snap(center,p,o),d=Math.max(1,Math.floor(p/4));
 const near=cell>=center?cell-p:cell+p,far=cell>=center?cell+p:cell-p;
 const requests=[near-d,near+d,cell-d,cell+d,far].sort((a,b)=>a-b);
 const rows=requests.map(q=>({q,actual:measure(q),expected:snap(q,p,o)}));
 const values=rows.map(r=>r.actual),cells=[...new Set(values)];
 const ok=rows.every(r=>r.actual===r.expected)&&requests.slice().reverse().every(q=>measure(q)===snap(q,p,o))&&cells.length===3&&cells[1]-cells[0]===p&&cells[2]-cells[1]===p&&cells.filter(v=>values.filter(x=>x===v).length>=2).length===2;
 return {ok,origin:o,rows};
}
for(const [actual,hypothesis,center,origin] of [[9,18,-401,8],[117,234,400,15],[147,294,400,15]]){
 const proof=sparseHypothesisProof(hypothesis,center,q=>snap(q,actual,origin));
 assert(proof.ok,'Counterexample no longer reproduced');assert.notEqual(actual,hypothesis);
 console.log(JSON.stringify({actual,hypothesis,center,origin,falseAcceptance:proof.ok,rows:proof.rows}));
}
assert(!sparseHypothesisProof(117,400,q=>q).ok);
let calls=0;assert(!sparseHypothesisProof(117,400,q=>snap(q,117,15)+(++calls>4?1:0)).ok);
console.log('PASS: doubled odd-pitch alias reproduced despite three apparent cells, two plateaus and reverse repeatability. Hypothesis-only shortcut is NOT safe.');
