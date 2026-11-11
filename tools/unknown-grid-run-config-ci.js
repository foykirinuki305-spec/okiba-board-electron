// Strict test selection only: never manufactures desktop geometry or changes DPI.
'use strict';
function readConfig(env){
 const scale=env.OKIBA_UNKNOWN_EXPECTED_SCALE??'100';
 if(!['100','150'].includes(scale))throw Error('unsupported expected scale');
 const selection=env.OKIBA_UNKNOWN_CASES??'success,duplicate-requests,no-fit';
 if(!['success,duplicate-requests,no-fit','success,no-fit'].includes(selection))throw Error('unsupported case selection');
 return {expectedScale:Number(scale),cases:selection.split(',')};
}
module.exports={readConfig};
