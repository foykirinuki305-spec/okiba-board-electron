'use strict';
// Native previews against throwaway data only. Never touches the real Desktop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { _electron: electron } = require('playwright');
const ROOT = path.join(__dirname, '..');
const assert = (v, m) => { if (!v) throw Error(m); console.log('  ok - ' + m); };
async function run(shots = path.join(ROOT, 'screenshots')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-preview-e2e-'));
  const base = path.join(tmp, 'boards'), old = path.join(tmp, 'old'), desktop = path.join(tmp, 'desktop');
  const board = path.join(base, 'Preview Test');
  for (const dir of [board, old, desktop]) fs.mkdirSync(dir, {recursive:true});
  const fixtures = ['preview-wide.png','preview-tall.png','preview-wide.mp4','preview-green.mp4'];
  for (const name of fixtures) fs.copyFileSync(path.join(__dirname,'fixtures',name),path.join(board,name));
  fs.writeFileSync(path.join(board,'document.txt'),'preview fixture, never user data');
  fs.writeFileSync(path.join(board,'unknown.customextension'),'unknown icon fallback');
  fs.writeFileSync(path.join(board,'broken.mp4'),'intentionally invalid video');
  fs.mkdirSync(path.join(board,'folder'));
  const names = [...fixtures,'document.txt','unknown.customextension','broken.mp4','folder'];
  const positions = Object.fromEntries(names.map((name,i)=>[name,{col:i%4,row:Math.floor(i/4)}]));
  const meta = path.join(board,'.okiba-board.json');
  fs.writeFileSync(meta,JSON.stringify({version:6,size_percent:100,positions,notes:[{id:'preview-note',text:'Keep note text',col:0,row:2}],
    links:[{path:path.join(tmp,'missing.png'),col:1,row:2,wasHidden:false}]}));
  const files = [meta,...names.filter(n=>n!=='folder').map(n=>path.join(board,n))];
  const snapshot = () => files.map(p=>({path:p,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),mtime:fs.statSync(p).mtimeMs}));
  const before = snapshot();
  let app;
  try {
    app = await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+path.join(tmp,'userdata')],timeout:60000,env:{...process.env,
      OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,
      OKIBA_TEST_HELPER:'fake',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_POSITIONER:'stub',
      OKIBA_TEST_RESOLVER_DIR:desktop,OKIBA_TEST_HOOKS:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'}});
    const page = await app.firstWindow();
    await page.waitForSelector('#boardGrid .board-card[data-name="Preview Test"]');
    await page.click('#boardGrid .board-card[data-name="Preview Test"]');
    await page.waitForSelector('#boardView:not([hidden]) .item');
    for (const name of names.filter(n=>n!=='folder')) {
      // The board refresh replaces cards asynchronously. Query and inspect the
      // current connected image in ONE renderer task, rather than holding a
      // locator handle across attachment/load/style checks.
      const deadline = Date.now() + 30000;
      let details = null;
      let ready = false;
      while (Date.now() < deadline) {
        details = await page.evaluate(name => {
          const card = [...document.querySelectorAll('.item')].find(e=>e.querySelector('.name')?.textContent===name);
          const img = card?.querySelector('.thumb img');
          if (!img) return { found:false, cardConnected:!!card?.isConnected };
          return { found:true, connected:img.isConnected && img.ownerDocument===document,
            complete:img.complete, fit:getComputedStyle(img).objectFit,
            draggable:img.draggable, width:img.naturalWidth, height:img.naturalHeight };
        }, name);
        ready = details.found && details.connected && details.complete &&
          details.width>0 && details.height>0 && details.fit==='contain' && details.draggable===false;
        if (ready) break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert(ready, name+': complete contained non-draggable native preview/icon; details='+JSON.stringify(details));
    }
    const folder=page.locator('.item[data-key="file:folder"]');
    assert(await folder.locator('.tile-folder svg').count()===1 && await folder.locator('.thumb img').count()===0,'folder keeps dedicated yellow folder SVG, not incorrect Windows drive icon');
    const missing=page.locator('.item.missing');
    assert(await missing.count()===1 && await missing.locator('.thumb img').count()===0,'missing link remains explicit missing tile');
    const note=page.locator('.item[data-key="note:preview-note"]');
    assert((await note.innerText()).includes('Keep note text') && await note.locator('.thumb img').count()===0,'note remains readable text, not a file icon');
    const scan=await page.evaluate(()=>[...document.querySelectorAll('img')].every(i=>!i.draggable));
    assert(scan,'all images have draggable=false');
    const sources=await page.locator('.item').evaluateAll(els=>Object.fromEntries(els.map(e=>[e.querySelector('.name')?.textContent,e.querySelector('.thumb img')?.src])));
    assert(new Set(['preview-wide.png','preview-tall.png','preview-wide.mp4','preview-green.mp4'].map(n=>sources[n])).size===4,'two images and two real videos have distinguishable thumbnail content');
    assert(sources['preview-wide.mp4']!==sources['broken.mp4'] && sources['preview-green.mp4']!==sources['broken.mp4'],'real videos use frame thumbnails rather than shared MP4 icon fallback');
    const geometry=await page.locator('.item').evaluateAll(els=>Object.fromEntries(els.map(e=>[e.dataset.key,[e.style.left,e.style.top]])));
    for (const [name,cell] of Object.entries(positions)) assert(JSON.stringify(geometry['file:'+name])===JSON.stringify([16+cell.col*164+'px',16+cell.row*158+'px']),name+': original cell coordinates unchanged');
    fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'native-previews.png')});
    // Allow a background refresh and exercise repeat requests/cache without moving data.
    await page.evaluate(async()=>{const names=[...document.querySelectorAll('.item')];await new Promise(r=>setTimeout(r,1500));});
    assert(JSON.stringify(snapshot())===JSON.stringify(before),'preview loading leaves source bytes, mtimes and board metadata unchanged');
    await app.close();app=null;
    assert(JSON.stringify(snapshot())===JSON.stringify(before),'closing the preview app leaves metadata and sources unchanged');
    console.log('NATIVE PREVIEW E2E PASSED');
  } catch (error) {
    if (app) {
      try {
        fs.mkdirSync(shots,{recursive:true});
        const failurePage=await app.firstWindow();
        await failurePage.screenshot({path:path.join(shots,'native-previews-failure.png')});
      } catch (captureError) { console.error('preview failure screenshot unavailable: '+captureError.message); }
    }
    throw error;
  } finally { if(app) await app.close().catch(()=>{}); fs.rmSync(tmp,{recursive:true,force:true}); }
}
module.exports=run;
if(require.main===module) run().catch(e=>{console.error(e);process.exitCode=1});
