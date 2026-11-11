'use strict';
const assert = require('assert/strict');
const {createPreviewService} = require('../lib/previews');
let checks = 0;
function ok(v, label) { assert.ok(v, label); checks++; }
const image = url => ({isEmpty: () => false, toDataURL: () => url});
const tick = () => new Promise(r => setImmediate(r));
async function main() {
  let clock = 0, version = 1, thumbs = 0, icons = 0, fail = false, missing = false;
  const make = overrides => createPreviewService({
    stat: async p => { if (missing) throw Error('missing'); return {mtimeMs:version,size:10,isFile:()=>p!=='folder',isDirectory:()=>p==='folder'}; },
    thumbnail: async () => { thumbs++; if (fail) throw Error('codec'); return image('thumb-'+version); },
    fileIcon: async () => { icons++; return image('icon'); },
    isMedia: p => p.endsWith('.mp4'), now:()=>clock, ...overrides,
  });
  const s = make();
  const a=s.get('a.mp4'), b=s.get('a.mp4');
  ok(a===b,'inflight identical promise');
  ok(await a==='thumb-1','media thumbnail');
  ok(thumbs===1,'dedup invokes native once');
  await s.get('a.mp4'); ok(thumbs===1,'unchanged signature cached');
  version=2; ok(await s.get('a.mp4')==='thumb-2','mtime invalidates immediately after await');
  ok(thumbs===2,'changed signature invokes native');
  ok(await s.get('a.txt')==='icon','nonmedia native icon');
  ok(await s.get('folder')===null,'folder keeps existing recognisable tile');
  ok(icons===1,'folder avoids incorrect drive icon; nonmedia avoids thumbnail');
  fail=true; ok(await s.get('b.mp4')==='icon','failed thumbnail falls back');
  const before=thumbs; await s.get('b.mp4'); ok(thumbs===before,'fallback negative TTL suppresses retry');
  clock+=15001; fail=false;
  ok(await s.get('b.mp4')==='thumb-2','fallback retries after TTL');
  missing=true; ok(await s.get('a.mp4')===null,'missing no stale result'); missing=false;
  ok(await s.get('')===null,'empty path rejected');
  ok(await s.get(null)===null,'nonstring path rejected');
  let inflight=0, peak=0; const releases=[];
  const q=make({concurrency:2,maxPending:3,thumbnail:()=>new Promise(resolve=>{
    inflight++;peak=Math.max(peak,inflight);releases.push(()=>{inflight--;resolve(image('q'));});
  })});
  const jobs=[q.get('1.mp4'),q.get('2.mp4'),q.get('3.mp4')];
  ok(await q.get('overflow.mp4')===null,'pending limit enforced');
  await tick(); ok(peak===2,'native concurrency bounded');
  releases.shift()(); await tick();
  while(releases.length) releases.shift()(); await Promise.all(jobs);
  ok(peak===2,'queue drained without exceeding bound');
  let count=0; const lru=make({maxCache:2,thumbnail:async()=>{count++;return image('lru');}});
  await lru.get('1.mp4');await lru.get('2.mp4');await lru.get('3.mp4');await lru.get('1.mp4');
  ok(count===4,'LRU bound evicts old signature');
  let notices=0; const p=make();
  ok(p.peek('peek.mp4',100,()=>notices++)===null,'peek nonblocking');
  await tick();ok(p.peek('peek.mp4',100)==='thumb-2','peek ready cache');
  ok(notices===1,'peek notifies once');
  clock+=5001;version=3;p.peek('peek.mp4',100,()=>notices++);await tick();
  ok(p.peek('peek.mp4',100)==='thumb-3' && notices===2,'peek background version refresh');
  const negative=make({thumbnail:async()=>({isEmpty:()=>true}),fileIcon:async()=>{throw Error('no icon');}});
  ok(await negative.get('bad.mp4')===null,'all native failures safe fallback');
  console.log(`preview-selftest: ${checks} checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
