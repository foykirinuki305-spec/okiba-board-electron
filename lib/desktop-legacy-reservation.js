'use strict';
// The caller owns the old mutation helper. This proof never permits guessed recovery.
function validLegacyProof(p){
 return !!p&&['committed','rolled-back','no-mutation'].includes(p.outcome)&&p.mutationsSettled===true&&p.metadataSettled===true&&p.oldUnchanged===true&&!!p.helper&&(p.helper.allRequestsCompleted===true||p.helper.stopConfirmed===true);
}
function legacyTerminal(a,owned){return a?.mode==='legacy-reservation'&&a.phase==='released'&&!owned?{ok:true,state:'legacy-released',outcome:a.outcome,leaseReleased:true}:null;}
module.exports={validLegacyProof,legacyTerminal};
