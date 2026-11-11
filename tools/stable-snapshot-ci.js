'use strict';
// CI-only bounded read stabilization. No mutations and no best-effort snapshots.
async function stableSnapshot({read,guard,same,sleep,attempts=100}){
 let previous;
 for(let n=0;n<attempts;n++){
  const response=await read();
  if(!response?.ok||!response.result)throw Error('snapshot transport failure '+JSON.stringify(response));
  const s=response.result;
  if(!s.ok){
   if(s.reason!=='desktop-changing'||s.hresult!=null||s.errorType||s.detail||s.innerDetail)throw Error('snapshot failure '+JSON.stringify(s));
   previous=undefined;await sleep(100);continue;
  }
  guard(s);
  if(previous&&same(previous,s))return s;
  previous=s;await sleep(100);
 }
 throw Error('unstable snapshot: bounded attempts exhausted');
}
module.exports={stableSnapshot};
