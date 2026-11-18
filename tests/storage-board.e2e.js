'use strict';
// Real Electron UI + real transfer service; all files/profile are disposable TEMP fixtures.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {_electron:electron}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'okiba-storage-gui-'));
const base=path.join(temp,'boards'),c=path.join(base,'Existing'),external=path.join(temp,'external'),profile=path.join(temp,'profile'),input=path.join(temp,'input'),dest=path.join(temp,'return'),old=path.join(temp,'old');
for(const p of [c,external,profile,input,dest,old])fs.mkdirSync(p,{recursive:true});
const cmeta=path.join(c,'.okiba-board.json');fs.writeFileSync(cmeta,JSON.stringify({version:6,positions:{'keep.txt':{col:3,row:4}},links:[],notes:[],future:{keep:true}}));fs.writeFileSync(path.join(c,'keep.txt'),'unchanged');const original=fs.readFileSync(cmeta);
// Use the app's own Node runtime: Windows dev identifiers differ between Node and Electron.
const setup=require('child_process').spawnSync(require('electron'),['-e',"process.stdout.write(JSON.stringify(require(process.argv[1]).create(process.argv[2],process.argv[3],'D storage fixture')))",path.join(ROOT,'lib/external-boards.js'),base,external],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
assert.equal(setup.status,0,setup.stderr);const ext=JSON.parse(setup.stdout);
fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:require('../package.json').version,positions:{Existing:{col:0,row:0},[ext.id]:{col:1,row:0}}}));
const migrationC=path.join(base,'MigrationSource'),migrationDest=path.join(base,'MigrationReturn'),migrationD=path.join(temp,'migration-external');
for(const p of [migrationC,migrationDest,migrationD])fs.mkdirSync(p,{recursive:true});
const migrationData={version:6,size_percent:100,positions:{'scene.txt':{col:5,row:2},'audio':{col:5,row:3}},links:[],notes:[{id:'note-fixture',text:'scene note',col:7,row:1}]};
fs.writeFileSync(path.join(migrationC,'.okiba-board.json'),JSON.stringify(migrationData));fs.writeFileSync(path.join(migrationC,'scene.txt'),'scene material');fs.mkdirSync(path.join(migrationC,'audio'));fs.writeFileSync(path.join(migrationC,'audio','voice.txt'),'voice material');
fs.writeFileSync(path.join(migrationDest,'.okiba-board.json'),JSON.stringify({version:6,positions:{},links:[],notes:[]}));
const secondSetup=require('child_process').spawnSync(require('electron'),['-e',"process.stdout.write(JSON.stringify(require(process.argv[1]).create(process.argv[2],process.argv[3],'Migration D')))",path.join(ROOT,'lib/external-boards.js'),base,migrationD],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
assert.equal(secondSetup.status,0,secondSetup.stderr);const migrationExt=JSON.parse(secondSetup.stdout);
const a=path.join(input,'alpha.txt'),b=path.join(input,'beta.txt');fs.writeFileSync(a,'alpha');fs.writeFileSync(b,'beta');
let app,checks=0;function ok(v,msg){assert(v,msg);checks++;}
(async()=>{try{
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_RETURN_FOLDER:dest,OKIBA_SHORTCUT_DESKTOP:dest,OKIBA_CLEANUP_DESKTOP:dest,OKIBA_CLEANUP_DOWNLOADS:dest};
 delete env.ELECTRON_RUN_AS_NODE;delete env.OKIBA_TEST_RETURN_MODE;delete env.OKIBA_DESKTOP_SAFE_PREVIEW;delete env.OKIBA_DESKTOP_UNKNOWN_PREVIEW;
 app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile,'--board-id='+ext.id],env});
 app.process().stderr.on('data',b=>process.stderr.write(b));
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 await app.evaluate(({shell,BrowserWindow})=>{shell.openPath=async()=>'';for(const w of BrowserWindow.getAllWindows())w.hide();});
 await page.waitForFunction(()=>document.getElementById('boardTitle')?.textContent==='D storage fixture');checks++;
 const route=await page.evaluate(()=>window.okiba.getStartupRoute());ok(JSON.stringify(route).includes(ext.id),'external startup route');
 let state=await page.evaluate(id=>window.okiba.getBoard(id),ext.id);ok(state.external&&state.displayName==='D storage fixture','external display name');
 const added=await page.evaluate(({id,a,b})=>window.okiba.linkFiles(id,[a,b],{anchor:[2,1],offsets:[[0,0],[0,1]],rows:8}),{id:ext.id,a,b});ok(added.added.length===2,'two intake');ok(!fs.existsSync(a)&&!fs.existsSync(b),'intake physically moved');
 await page.evaluate(id=>openBoard(id),ext.id);await page.waitForSelector('#boardArea .item');ok(await page.locator('#boardArea .item').count()===2,'desktop-style individual items');
 let raw=JSON.parse(fs.readFileSync(path.join(external,'.okiba-board.json'),'utf8'));assert.deepEqual(raw.positions['alpha.txt'],{col:2,row:1});assert.deepEqual(raw.positions['beta.txt'],{col:2,row:2});checks+=2;
 state=await page.evaluate(id=>window.okiba.getBoard(id),ext.id);
 const saved=await page.evaluate(({id,state})=>window.okiba.saveBoard(id,{'alpha.txt':[4,1],'beta.txt':[4,2]},state.notes,100,state.links,state.revision),{id:ext.id,state});ok(saved.saved!==false,'save freely arranged grid');
 raw=JSON.parse(fs.readFileSync(path.join(external,'.okiba-board.json'),'utf8'));ok(raw.positions['alpha.txt'].col===4,'saved column');ok(raw.externalBoardId===ext.id,'external identity retained');
 await page.evaluate(id=>openBoard(id),ext.id);
 const src=path.join(external,'alpha.txt');let result=await page.evaluate(({id,src})=>window.okiba.safeTakeout({boardName:id,paths:[src],linkedPaths:[]}),{id:ext.id,src});ok(!result.error&&result.moved.length===1,'return success');ok(fs.readFileSync(path.join(dest,'alpha.txt'),'utf8')==='alpha'&&!fs.existsSync(src),'same configured return folder');
 const beta=path.join(external,'beta.txt');fs.writeFileSync(path.join(dest,'beta.txt'),'existing destination');
 result=await page.evaluate(({id,src})=>window.okiba.safeTakeout({boardName:id,paths:[src],linkedPaths:[]}),{id:ext.id,src:beta});ok(!!result.error,'collision rejected');ok(fs.readFileSync(beta,'utf8')==='beta','collision source preserved');ok(fs.readFileSync(path.join(dest,'beta.txt'),'utf8')==='existing destination','collision destination preserved');
 assert.deepEqual(fs.readFileSync(cmeta),original);checks++;ok(fs.readFileSync(path.join(c,'keep.txt'),'utf8')==='unchanged','C material unchanged');
 await app.close();app=null;
 app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile,'--board-id='+ext.id],env});
 const restarted=await app.firstWindow();restarted.setDefaultTimeout(15000);
 await app.evaluate(({shell,BrowserWindow})=>{shell.openPath=async()=>'';for(const w of BrowserWindow.getAllWindows())w.hide();});
 await restarted.waitForFunction(()=>document.getElementById('boardTitle')?.textContent==='D storage fixture');checks++;
 const recovered=await restarted.evaluate(id=>window.okiba.getBoard(id),ext.id);ok(recovered.positions['beta.txt'][0]===4&&recovered.positions['beta.txt'][1]===2,'restart keeps cells');
 ok(recovered.entries.some(e=>e.name==='beta.txt')&&!recovered.entries.some(e=>e.name==='alpha.txt'),'restart sees same physical board');
 assert.deepEqual(fs.readFileSync(cmeta),original);checks++;
 // Exercise actual migrate-board IPC and both dialogs without showing UI.
 await app.evaluate(({dialog})=>{global.__migrationDialogs=[];global.__migrationChoice={target:'',cancelAt:0};dialog.showMessageBox=async(_window,options)=>{global.__migrationDialogs.push(options);const n=global.__migrationDialogs.length,c=global.__migrationChoice;if(c.cancelAt===n)return {response:0};if(n===1){const index=options.buttons.findIndex(t=>t.includes(c.target));if(index<1)throw Error('fixture migration target absent');return {response:index};}return {response:1};};});
 async function migrate(source,target,cancelAt=0){await app.evaluate((_,v)=>{global.__migrationDialogs=[];global.__migrationChoice=v;},{target,cancelAt});return restarted.evaluate(id=>window.okiba.migrateBoard(id),source);}
 const mMeta=path.join(migrationC,'.okiba-board.json'),mBefore=fs.readFileSync(mMeta),dBefore=fs.readFileSync(path.join(migrationD,'.okiba-board.json'));
 let mr=await migrate('MigrationSource','Migration D',1);ok(mr.cancelled,'selection cancellation');assert.deepEqual(fs.readFileSync(mMeta),mBefore);checks++;
 mr=await migrate('MigrationSource','Migration D',2);ok(mr.cancelled,'confirmation cancellation');assert.deepEqual(fs.readFileSync(mMeta),mBefore);assert.deepEqual(fs.readFileSync(path.join(migrationD,'.okiba-board.json')),dBefore);checks+=2;
 let dialogs=await app.evaluate(()=>global.__migrationDialogs);ok(dialogs.length===2,'selection plus concrete confirmation');ok(dialogs[1].detail.includes(migrationC)&&dialogs[1].detail.includes(migrationD),'confirmation exact source destination');ok(dialogs[1].detail.includes('AviUtl')&&dialogs[1].detail.includes('空になります'),'confirmation source empty and AviUtl warning');
 ok(fs.readFileSync(path.join(migrationC,'scene.txt'),'utf8')==='scene material','cancel source remains');ok(!fs.existsSync(path.join(migrationD,'scene.txt')),'cancel no transfer');
 mr=await migrate('MigrationSource','Migration D');ok(mr.ok,'C to D migration');
 let migrated=JSON.parse(fs.readFileSync(path.join(migrationD,'.okiba-board.json'),'utf8'));assert.deepEqual(migrated.positions,migrationData.positions);assert.deepEqual(migrated.notes,migrationData.notes);checks+=2;ok(migrated.externalBoardId===migrationExt.id,'migration D identity');ok(fs.readFileSync(path.join(migrationD,'audio','voice.txt'),'utf8')==='voice material','nested folder preserved');ok(fs.readdirSync(migrationC).length===1,'source board retained empty');
 mr=await migrate(migrationExt.id,'MigrationReturn');ok(mr.ok,'D to C migration');migrated=JSON.parse(fs.readFileSync(path.join(migrationDest,'.okiba-board.json'),'utf8'));assert.deepEqual(migrated.positions,migrationData.positions);assert.deepEqual(migrated.notes,migrationData.notes);checks+=2;ok(!migrated.externalBoardId,'C target does not inherit external ID');ok(fs.readFileSync(path.join(migrationDest,'scene.txt'),'utf8')==='scene material','C target material');ok(fs.readdirSync(migrationD).length===1,'D source retained empty');assert.deepEqual(fs.readFileSync(cmeta),original);checks++;
 console.log('PASS storage GUI '+checks+' checks; TEMP-only external routing, grid, intake, save, same return folder, collision protection, C unchanged');
 }catch(e){console.error(e.stack);console.error('fixture retained for diagnosis: '+temp);process.exitCode=1;}finally{if(app)await app.close();}
})();
