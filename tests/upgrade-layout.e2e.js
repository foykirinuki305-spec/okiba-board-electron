'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {_electron:electron}=require('playwright');
const ROOT=path.join(__dirname,'..');
const assert=(value,label)=>{if(!value)throw Error(label);console.log('  ok - '+label);};
async function run(){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-upgrade-layout-'));
 const base=path.join(tmp,'boards'),old=path.join(tmp,'old'),desktop=path.join(tmp,'desktop');
 for(const dir of [base,old,desktop])fs.mkdirSync(dir,{recursive:true});
 const linked=path.join(tmp,'linked.txt');fs.writeFileSync(linked,'unchanged linked source');
 const boards=['Upgrade A','Upgrade B'];const percentages=[100,125];const original={};
 for(let i=0;i<boards.length;i++){
  const dir=path.join(base,boards[i]);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'resident.txt'),'unchanged resident');
  const data={version:6,size_percent:percentages[i],positions:{'resident.txt':{col:2,row:3}},notes:[{id:'kept-note',text:'Keep this note',col:1,row:2}],links:[{path:linked,col:4,row:1,wasHidden:false}]};
  const p=path.join(dir,'.okiba-board.json');fs.writeFileSync(p,JSON.stringify(data,null,2));original[p]=fs.readFileSync(p,'utf8');
 }
 const homePath=path.join(base,'.home.json');const home={positions:{'Upgrade A':{col:2,row:1},'Upgrade B':{col:0,row:0}},theme:'\u7d3a',appVersion:'2.2.3'};
 fs.writeFileSync(homePath,JSON.stringify(home,null,2));
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_TEST_HELPER:'fake',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_POSITIONER:'stub',OKIBA_TEST_RESOLVER_DIR:desktop,OKIBA_TEST_HOOKS:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'};
 const launch=()=>electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+path.join(tmp,'profile')],env,timeout:60000});
 let app;let firstHome;const rendered={};
 try{
  for(let round=0;round<2;round++){
   app=await launch();const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
   const homeView=await page.locator('#boardGrid .board-card').evaluateAll(els=>els.map(e=>({name:e.dataset.name,x:e.offsetLeft,y:e.offsetTop})));
   if(round===0)firstHome=homeView;else assert(JSON.stringify(homeView)===JSON.stringify(firstHome),'home display order and coordinates unchanged after restart');
   assert(await page.evaluate(()=>document.documentElement.dataset.theme)===home.theme,'saved theme retained');
   for(let i=0;i<boards.length;i++){
    await page.click('#boardGrid .board-card[data-name="'+boards[i]+'"]');await page.waitForSelector('#boardView:not([hidden]) .item');
    const scale=percentages[i]/100,cw=Math.max(56,Math.round(164*scale)),ch=Math.max(64,Math.round(158*scale));
    const expected={'file:resident.txt':[2,3],'note:kept-note':[1,2],['link:'+linked]:[4,1]};
    const actual=await page.locator('.item').evaluateAll(els=>Object.fromEntries(els.map(e=>[e.dataset.key,[e.style.left,e.style.top]])));
    for(const [key,cell] of Object.entries(expected))assert(JSON.stringify(actual[key])===JSON.stringify([16+cell[0]*cw+'px',16+cell[1]*ch+'px']),boards[i]+' '+key+': saved cell rendered exactly, round '+round);
    assert(await page.inputValue('#percentSel')===String(percentages[i]),'saved size percent unchanged');
    if(round===0)rendered[boards[i]]=actual;else assert(JSON.stringify(actual)===JSON.stringify(rendered[boards[i]]),'all card coordinates unchanged after restart');
    await page.click('#backBtn');await page.waitForSelector('#homeView:not([hidden])');
   }
   await app.close();app=null;
   for(const [p,bytes]of Object.entries(original))assert(fs.readFileSync(p,'utf8')===bytes,'v6 board bytes unchanged by upgrade/open/close');
   const after=JSON.parse(fs.readFileSync(homePath,'utf8'));assert(after.appVersion===require('../package.json').version,'home version marker updated to current release');
   delete after.appVersion;const expectedHome={...home};delete expectedHome.appVersion;assert(JSON.stringify(after)===JSON.stringify(expectedHome),'home only appVersion changes; positions and theme preserved');
   assert(fs.readFileSync(linked,'utf8')==='unchanged linked source','linked original untouched');
  }
  console.log('UPGRADE LAYOUT E2E PASSED');
 }finally{if(app)await app.close().catch(()=>{});fs.rmSync(tmp,{recursive:true,force:true});}
}
module.exports=run;
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1});
