'use strict';
function enabled({isPackaged,platform,env}) {
 return isPackaged===true && platform==='win32' && env?.OKIBA_DESKTOP_SAFE_PREVIEW==='1';
}
function nativeEnv(env) {
 const copy={...env};
 for(const key of Object.keys(copy))if(/^OKIBA_(TEST_|FAKE_|UNKNOWN_|MIXED_)/i.test(key)||/^OKIBA_(HELPER_MODE|SNAP_LEASE)$/i.test(key)){copy[key]='';copy[key.toUpperCase()]='';}
 return copy;
}
module.exports={enabled,nativeEnv};
