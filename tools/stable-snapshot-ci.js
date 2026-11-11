'use strict';
// CI-only bounded read stabilization. No mutations and no best-effort snapshots.
async function stableSnapshot({read,guard,same,sleep,attempts=100,cleanupEvidence=null}){
 let previous;
 for(let n=0;n<attempts;n++){
  const response=await read();
  if(!response?.ok||!response.result)throw Error('snapshot transport failure '+JSON.stringify(response));
  const s=response.result;
  if(!s.ok){
   const changing=s.reason==='desktop-changing'&&s.hresult==null&&!s.errorType&&!s.detail&&!s.innerDetail;
   const cleanupRead=cleanupEvidence?.phase==='terminal-owned-removal'&&cleanupEvidence.terminalConfirmed===true&&typeof cleanupEvidence.record==='function'&&s.reason==='shell-snapshot-error'&&s.errorType==='System.Runtime.InteropServices.COMException'&&['0x80004005','0x80070490'].includes(String(s.hresult).toLowerCase())&&typeof s.detail==='string'&&s.detail.includes('ReadShellBatch');
   const cleanupCount=cleanupEvidence?.phase==='terminal-owned-removal'&&cleanupEvidence.terminalConfirmed===true&&typeof cleanupEvidence.record==='function'&&s.reason==='desktop-changing'&&s.errorType==='System.InvalidOperationException'&&String(s.hresult).toLowerCase()==='0x80131509'&&s.innerDetail==='item-count-changed'&&s.detail==='Exception calling "ReadShellBatch" with "1" argument(s): "item-count-changed"';
   if(!changing&&!cleanupRead&&!cleanupCount)throw Error('snapshot failure '+JSON.stringify(s));
   if(cleanupRead||cleanupCount)cleanupEvidence.record({attempt:n,reason:s.reason,hresult:s.hresult,errorType:s.errorType,detail:s.detail,innerDetail:s.innerDetail});
   previous=undefined;await sleep(100);continue;
  }
  guard(s);
  if(previous&&same(previous,s))return s;
  previous=s;await sleep(100);
 }
 throw Error('unstable snapshot: bounded attempts exhausted');
}
module.exports={stableSnapshot};
