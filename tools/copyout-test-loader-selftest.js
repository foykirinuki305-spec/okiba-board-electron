'use strict';
// Read-only module loading in a VM with no mainModule or global require.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),root=path.resolve(__dirname,'..');
for(const file of ['tests/copyout-ui.e2e.js','tests/packaged-copyout.e2e.js']){
 const source=fs.readFileSync(path.join(root,file),'utf8');assert(!source.includes('process.mainModule'));
 const start=source.indexOf("const nativeModule=process.getBuiltinModule('module')");
 const finish=source.indexOf(String.fromCharCode(10)+"  global.",start);assert(start>=0&&finish>start);
 const body=source.slice(start,finish);
 const loads=[];const context={process:{getBuiltinModule:name=>{loads.push(name);return require(name);}},app:{getAppPath:()=>root}};
 vm.createContext(context);vm.runInContext(body+String.fromCharCode(10)+"globalThis.loadedCopy=module.copyFilesOut;",context);
 assert.equal(typeof context.loadedCopy,'function');assert.equal(context.loadedCopy,require('../lib/copyout').copyFilesOut);assert.deepEqual(loads,['module','path']);
 assert(!Object.hasOwn(context,'require'));assert(!Object.hasOwn(context.process,'mainModule'));
}
console.log('PASS Electron test loader uses built-in createRequire without mainModule/global require; source and packaged fixture original-copy contracts unchanged');
