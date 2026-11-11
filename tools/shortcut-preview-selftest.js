'use strict';
const assert=require('assert/strict');
const {createFileIconResolver}=require('../lib/shortcut-preview');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};
(async()=>{
  let links={}, calls=[], icons={}, paths={};
  const f=createFileIconResolver({env:{WINDIR:'C:\\Windows'},
    readShortcutLink:p=>{if(!links[p])throw Error('broken');return links[p];},
    getFileIcon:async p=>{calls.push(p);return p;},
    stat:async p=>{if(!paths[p])throw Error('missing');return paths[p];},
    loadIcon:p=>icons[p],
  });
  const file={isFile:()=>true,isDirectory:()=>false,size:100};
  const dir={isFile:()=>false,isDirectory:()=>true,size:0};
  links['C:\\a.lnk']={target:'%WINDIR%\\notepad.exe'}; paths['C:\\Windows\\notepad.exe']=file;
  ok(await f('C:\\a.lnk',{})==='C:\\Windows\\notepad.exe','target icon, environment expansion');
  ok(await f('C:\\normal.txt',{})==='C:\\normal.txt','ordinary file passthrough');
  links['C:\\a.lnk']={target:'app.exe'}; paths['C:\\app.exe']=file;
  ok(await f('C:\\a.lnk',{})==='C:\\app.exe','relative target resolved beside shortcut');
  const ico={isEmpty:()=>false,toDataURL:()=> 'ico'};paths['C:\\custom.ico']=file;icons['C:\\custom.ico']=ico;
  links['C:\\a.lnk']={target:'app.exe',icon:'custom.ico',iconIndex:0};
  ok(await f('C:\\a.lnk',{})===ico,'explicit ico honoured');
  paths['C:\\custom.ico']={...file,size:5*1024*1024};
  ok(await f('C:\\a.lnk',{})==='C:\\app.exe','oversized ico skipped');
  links['C:\\a.lnk']={target:'app.exe',icon:'shell32.dll',iconIndex:42};
  ok(await f('C:\\a.lnk',{})==='C:\\app.exe','unsupported indexed dll uses target');
  links['C:\\a.lnk']={target:'folder'};paths['C:\\folder']=dir;
  const folder=await f('C:\\a.lnk',{});ok(folder.toDataURL().startsWith('data:image/svg+xml'),'folder link has recognisable folder not drive');
  links['C:\\a.lnk']={target:'missing.exe'};
  ok(await f('C:\\a.lnk',{})==='C:\\a.lnk','broken target falls back');
  links['C:\\a.lnk']={target:'a.lnk'};paths['C:\\a.lnk']=file;
  ok(await f('C:\\a.lnk',{})==='C:\\a.lnk','cycle bounded');
  links['C:\\a.lnk']={target:'b.lnk'};paths['C:\\b.lnk']=file;links['C:\\b.lnk']={target:'app.exe'};
  ok(await f('C:\\a.lnk',{})==='C:\\app.exe','nested shortcut read only');
  const exeIcon={isEmpty:()=>false,toDataURL:()=> 'explicit-exe-icon'};
  const explicitCalls=[];
  const explicit=createFileIconResolver({
    readShortcutLink:()=>({target:'C:\\target.exe',icon:'C:\\branding.exe',iconIndex:0}),
    stat:async()=>file,loadIcon:()=>null,
    getFileIcon:async p=>{explicitCalls.push(p);return exeIcon;},
  });
  ok(await explicit('C:\\tool.lnk',{})===exeIcon && explicitCalls[0]==='C:\\branding.exe','explicit EXE default icon preferred');
  const indexedCalls=[];
  const indexed=createFileIconResolver({
    readShortcutLink:()=>({target:'C:\\target.exe',icon:'C:\\branding.exe',iconIndex:2}),
    stat:async()=>file,loadIcon:()=>null,
    getFileIcon:async p=>{indexedCalls.push(p);return exeIcon;},
  });
  await indexed('C:\\tool.lnk',{});
  ok(indexedCalls[0]==='C:\\target.exe','nonzero EXE resource index not misrepresented');
  console.log(`shortcut-preview-selftest: ${checks} checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
