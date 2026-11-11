'use strict';
// Pure, NOT connected to main. Eligibility is not native authorization:
// prepare still checks pinned file/ancestor identity, links and current attributes.
const path=require('path');
function localFilePath(p){return typeof p==='string'&&/^[a-z]:\\/i.test(p)&&p.slice(3).split('\\').every(part=>part&&part!=='.'&&part!=='..'&&!/[<>:"/|?*\x00-\x1f]/.test(part)&&!/[. ]$/.test(part));}
const key=p=>typeof p==='string'?path.win32.resolve(p).toLowerCase():null;
function classifyResidentSelection(items,{knownGrid=false}={}){
 if(!Array.isArray(items)||!items.length)return {kind:'invalid',reason:'empty-selection'};
 const paths=new Set(),destinations=new Set();
 for(const i of items){if(!i||!localFilePath(i.path)||!localFilePath(i.dest)||paths.has(key(i.path))||destinations.has(key(i.dest)))return {kind:'invalid',reason:'duplicate-or-missing-path'};paths.add(key(i.path));destinations.add(key(i.dest));}
 if(items.some((i,n)=>items.some((j,m)=>n!==m&&key(i.path)===key(j.dest))))return {kind:'invalid',reason:'source-destination-alias'};
 if(items.some(i=>i.crossVolume!==false))return {kind:'unsupported',reason:'cross-volume'};
 const same=items.map(i=>key(i.path)===key(i.dest));
 if(same.some(Boolean)&&!same.every(Boolean))return {kind:'unsupported',reason:'mixed-samepath-resident'};
 if(same.every(Boolean))return {kind:'samepath',reason:'existing-route'};
 if(items.some(i=>i.isLink))return {kind:'unsupported',reason:'external-link-move'};
 if(!knownGrid)return {kind:'unsupported',reason:'unknown-grid'};
 if(items.some(i=>i.isFile!==true||i.reparse!==false||i.linkCount!==1||![32,34].includes(i.attributes)))return {kind:'unsupported',reason:'native-file-scope-unverified'};
 return {kind:'resident-archive-samevolume'};
}
function prepareResidentMetadata(before,selected,boardFolder){
 if(typeof before!=='string'||!Array.isArray(selected)||!selected.length||!boardFolder)throw Error('resident-metadata-input');
 const data=JSON.parse(before);
 if(!data||Array.isArray(data)||typeof data!=='object'||!data.positions||Array.isArray(data.positions)||typeof data.positions!=='object'||!Array.isArray(data.links))throw Error('resident-metadata-shape');
 const names=new Set(),paths=new Set();
 for(const file of selected){
  if(typeof file!=='string'||key(path.win32.dirname(file))!==key(boardFolder)||paths.has(key(file)))throw Error('resident-selection-invalid');
  paths.add(key(file));const name=path.win32.basename(file),lower=name.toLowerCase();
  if(names.has(lower)||!Object.prototype.hasOwnProperty.call(data.positions,name))throw Error('resident-position-missing-or-duplicate');
  // Never remove a resident while leaving an aliased duplicate position or link.
  if(Object.keys(data.positions).filter(n=>n.toLowerCase()===lower).length!==1||data.links.some(l=>l&&key(l.path)===key(file)))throw Error('resident-metadata-ambiguous');
  names.add(lower);
 }
 for(const file of selected)delete data.positions[path.win32.basename(file)];
 return JSON.stringify(data,null,2);
}
module.exports={classifyResidentSelection,prepareResidentMetadata};
