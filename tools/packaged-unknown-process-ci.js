// Pure packaged-process selection. Launcher ancestry is verified separately.
'use strict';const assert=require('assert/strict'),path=require('path');
function selectMain(runtime,processes,expectedExe){
 assert(runtime?.packaged===true&&Number.isInteger(runtime.pid)&&runtime.pid>0,'packaged main PID required');
 assert(typeof runtime.execPath==='string'&&path.win32.resolve(runtime.execPath).toLowerCase()===path.win32.resolve(expectedExe).toLowerCase(),'actual main executable mismatch');
 const hits=processes.filter(p=>p.pid===runtime.pid);assert.equal(hits.length,1,'main must belong to captured launcher tree');assert(typeof hits[0].started==='string'&&/^\d+$/.test(hits[0].started),'main native birth required');return hits[0];
}
module.exports={selectMain};
