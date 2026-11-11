// Bundled pure validation; native private ledger and identity checks remain authoritative.
'use strict';const {TextDecoder}=require('util');
function parseUtf8Json(bytes){if(!Buffer.isBuffer(bytes))throw Error('json-bytes-required');if(bytes.length>1048576)throw Error('json-input-limit');const bom=bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;const content=bom?bytes.subarray(3):bytes;const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);return JSON.parse(text);}
module.exports={parseUtf8Json};
