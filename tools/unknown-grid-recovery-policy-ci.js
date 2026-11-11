'use strict';
// Research recovery only. A fresh full native guard must still succeed after retry.
function retryableSnapshotRead(d){const s=d?.snapshotFailure;return d?.detail==='lease-snapshot-shell-snapshot-error'&&s?.reason==='shell-snapshot-error'&&String(s.hresult).toLowerCase()==='0x80070490'&&/ReadShellBatch/.test(s.detail||'');}
module.exports={retryableSnapshotRead};
