'use strict';
const fs=require('fs');
// Read-only matching: both names must resolve to the exact same extant path.
// Never zip records by position or fall back to basename/label comparisons.
function matchLeaseFileRecords(items,records,canonical=p=>fs.realpathSync.native(p).toLowerCase(),includeNative=false){
 if(!Array.isArray(items)||!Array.isArray(records)||items.length!==records.length)throw Error('file-record-count-mismatch');
 const byPath=new Map();for(const r of records){if(!r||typeof r.path!=='string'||typeof r.identity!=='string'||!r.identity)throw Error('invalid-file-record');const key=canonical(r.path);if(byPath.has(key))throw Error('duplicate-file-record-path');byPath.set(key,r);}
 const seen=new Set();return items.map(i=>{const key=canonical(i.path);if(seen.has(key))throw Error('duplicate-file-source-path');seen.add(key);const record=byPath.get(key);if(!record)throw Error('file-record-missing');return {...i,fileIdentity:record.identity,...(includeNative?{nativeFile:{attributes:record.attributes,regularFile:record.regularFile,reparse:record.reparse,linkCount:record.linkCount}}:{})};});
}
module.exports={matchLeaseFileRecords};
