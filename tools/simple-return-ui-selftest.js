 'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'main.js'),'utf8'),ui=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
assert(!/label: ['"]原本を残してコピー/.test(ui));
assert(!/label: ['"]ボードから外す/.test(ui));
assert(ui.includes("label: '選択を戻し先フォルダへ移動'"));
assert(ui.includes("label: '戻し先フォルダへ移動'"));
assert(ui.includes("label: '素材を探す'"));
assert(main.includes("ipcMain.handle('link-files'"));
const preview=main.slice(main.indexOf('function leasePreview()'),main.indexOf('function legacyDesktopTest()'));
for(const packaged of [true,false])for(const ci of ['true','false'])for(const hook of ['1','0']){const ctx={app:{isPackaged:packaged},process:{platform:'win32',env:{GITHUB_ACTIONS:ci,OKIBA_TEST_HOOKS:hook}},desktopPreviewPolicy:{enabled:()=>true}};assert.equal(vm.runInNewContext(preview+';leasePreview()',ctx),!packaged&&ci==='true'&&hook==='1');}
const legacy=main.match(/function legacyDesktopTest\(\)\{[^}]+\}/)[0];
for(const packaged of [true,false])for(const ci of ['true','false']){const ctx={app:{isPackaged:packaged},process:{env:{GITHUB_ACTIONS:ci,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_RETURN_MODE:'legacy'}}};assert.equal(vm.runInNewContext(legacy+';legacyDesktopTest()',ctx),!packaged&&ci==='true');}
assert(main.includes(':returnToFolder(payload)'));
assert(main.includes(':await returnToFolder(payload)'));
console.log('PASS simplified menus, preserved intake/rescue/folder return, production direct Desktop placement disabled');
