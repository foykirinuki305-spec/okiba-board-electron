'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),bf=require('../lib/boardfs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-home-fields-test-')),file=path.join(temp,'.home.json');let n=0;const check=x=>{assert.ok(x);n++;};
const initial=JSON.parse('{"positions":{"A":{"col":13,"row":4}},"theme":"dark","appVersion":"old","future":{"a":[1,{"b":true}]},"__proto__":{"polluted":true},"constructor":{"future":"value"}}');
fs.writeFileSync(file,JSON.stringify(initial));
let h=bf.loadHome(temp);bf.saveHome(temp,h.positions,h.theme,'new');let a=JSON.parse(fs.readFileSync(file,'utf8'));
check(JSON.stringify(a.positions)===JSON.stringify(initial.positions));check(JSON.stringify(a.future)===JSON.stringify(initial.future));check(a.appVersion==='new');check(a.theme==='dark');check(Object.hasOwn(a,'__proto__'));check(a.__proto__.polluted===true);check(a.constructor.future==='value');check({}.polluted===undefined);
bf.saveHome(temp,{B:[27,6]},'light');a=JSON.parse(fs.readFileSync(file,'utf8'));check(a.positions.B.col===27&&a.positions.B.row===6);check(!a.positions.A);check(a.theme==='light');check(a.appVersion==='new');check(a.future.a[1].b===true);
bf.saveHome(temp,{B:[27,6]},undefined,null);a=JSON.parse(fs.readFileSync(file,'utf8'));check(!Object.hasOwn(a,'appVersion'));check(a.theme==='light');check(a.future.a[1].b===true);
for(const raw of ['{broken','null','[]','42','"text"']){fs.writeFileSync(file,raw);bf.saveHome(temp,{C:[1,2]},'dark','v');a=JSON.parse(fs.readFileSync(file,'utf8'));check(a.positions.C.col===1&&a.positions.C.row===2);check(a.theme==='dark'&&a.appVersion==='v');check(!Object.hasOwn(a,'0'));}
fs.writeFileSync(file,JSON.stringify({positions:{},theme:23,appVersion:false,future:7}));bf.saveHome(temp,{});a=JSON.parse(fs.readFileSync(file,'utf8'));check(!Object.hasOwn(a,'theme')&&!Object.hasOwn(a,'appVersion'));check(a.future===7);check({}.polluted===undefined);
console.log('home unknown fields '+n+' checks PASS; isolated fixture '+temp);
