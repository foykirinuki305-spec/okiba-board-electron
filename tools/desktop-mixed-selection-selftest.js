'use strict';
const assert=require('assert/strict'),{classifyMixedSelection:c,prepareMixedMetadata:p}=require('../lib/desktop-resident-selection');
let checks=0;const test=f=>{f();checks++};
const board='C:\\Boards\\B',desktop='C:\\Users\\CI\\Desktop',options={enabled:true,knownGrid:true,desktop};
const resident={path:board+'\\clip.mp4',dest:desktop+'\\clip.mp4',isLink:false,crossVolume:false,isFile:true,reparse:false,linkCount:1,attributes:32,fileIdentity:'AA:01'};
const link={...resident,path:desktop+'\\link.mp4',dest:desktop+'\\link.mp4',isLink:true,hidden:true,attributes:34,fileIdentity:'AA:02'};
const items=[resident,link];
const data={version:17,positions:{'clip.mp4':[1,2],'stay.mp4':[7,8]},links:[{path:'D:\\first.mp4',future:{a:1}},{path:link.path,col:2,row:9,extra:'selected'},{path:'D:\\last.mp4',future:[1,2]}],future:{nested:{a:[1,2]}}},raw=JSON.stringify(data);
test(()=>assert.equal(c(items,options).kind,'mixed-hidden-resident'));
test(()=>assert.equal(c(items,{...options,enabled:false}).reason,'mixed-disabled'));
test(()=>assert.equal(c(items,{...options,knownGrid:false}).reason,'unknown-grid'));
test(()=>{const expected=structuredClone(data);delete expected.positions['clip.mp4'];expected.links.splice(1,1);assert.deepEqual(JSON.parse(p(raw,items,board,options)),expected);assert.equal(JSON.stringify(data),raw);assert.deepEqual(items,[resident,link]);});
for(const change of [{attributes:128},{reparse:true},{isFile:false},{linkCount:2},{crossVolume:true},{crossVolume:undefined},{path:123},{path:'C:relative.mp4'},{path:'C:\\folder\\clip.mp4:ads'},{path:'C:\\RUNNER~1\\clip.mp4'},{fileIdentity:''}])test(()=>assert.notEqual(c([{...resident,...change},link],options).kind,'mixed-hidden-resident'));
for(const change of [{hidden:false},{attributes:32},{isLink:false},{isLink:undefined},{dest:desktop+'\\other.mp4'},{path:'D:\\link.mp4',dest:desktop+'\\other.mp4'}])test(()=>assert.notEqual(c([resident,{...link,...change}],options).kind,'mixed-hidden-resident'));
test(()=>assert.equal(c([resident,{...link,fileIdentity:'aa:01'}],options).kind,'invalid'));
test(()=>assert.equal(c([resident,link,{...link,path:link.path.toUpperCase(),dest:link.dest.toUpperCase(),fileIdentity:'aa:03'}],options).kind,'invalid'));
test(()=>assert.notEqual(c([{...resident,path:link.path,dest:desktop+'\\other.mp4'},link],options).kind,'mixed-hidden-resident'));
test(()=>assert.equal(c([resident,{...resident,path:board+'\\b.mp4',dest:desktop+'\\b.mp4',fileIdentity:'aa:03'}],options).reason,'not-mixed'));
for(const mutated of [
 {...data,positions:{'stay.mp4':[7,8]}},
 {...data,positions:{...data.positions,'CLIP.MP4':[3,4]}},
 {...data,links:[...data.links,{path:link.path.toUpperCase()}]},
 {...data,links:data.links.filter(l=>l.path!==link.path)},
 {...data,links:[...data.links,{path:resident.path}]}
])test(()=>assert.throws(()=>p(JSON.stringify(mutated),items,board,options)));
test(()=>assert.throws(()=>p(raw,items,board)));
test(()=>{const after=JSON.parse(p(raw,[link,resident],board,options));assert.deepEqual(after.links,[data.links[0],data.links[2]]);assert.deepEqual(after.future,data.future);});
console.log('mixed selection '+checks+' PASS; no native calls');
