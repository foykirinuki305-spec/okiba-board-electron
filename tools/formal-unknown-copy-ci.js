// Disposable byte-identical product tree. No patches, injected modules or execution.
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {ownedTempDirectory}=require('./unknown-grid-lease-copy-ci');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function inventory(root){const result=[];function walk(relative){const full=path.join(root,relative),st=fs.lstatSync(full);assert(!st.isSymbolicLink(),'product symlink rejected');if(st.isDirectory()){for(const name of fs.readdirSync(full).sort())walk(path.join(relative,name));}else{assert(st.isFile(),'regular product file required');result.push({path:relative,size:st.size,sha256:hash(full)});}}for(const name of ['lib','scripts','package.json'])walk(name);return result;}
function verify(root,destination){const source=inventory(root),copied=inventory(destination);assert.deepEqual(copied,source,'product copy differs');return {byteIdentical:true,files:source.length,manifest:source};}
function build(root,destination){root=fs.realpathSync.native(root);destination=ownedTempDirectory(destination,{empty:true});const before=inventory(root);for(const name of ['lib','scripts','package.json'])fs.cpSync(path.join(root,name),path.join(destination,name),{recursive:true,errorOnExist:true,force:false});assert.deepEqual(inventory(root),before,'source changed during copy');return verify(root,destination);}
module.exports={build,verify,inventory};
