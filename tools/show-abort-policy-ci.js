'use strict';
function isSafeShowAbort(name,result,status){return name==='show-hidden-mid-stage'&&result?.ok===false&&result.resolution?.state==='aborted'&&status?.ok===true&&status.unsafe===false&&status.phase==='aborted';}
module.exports={isSafeShowAbort};
