// Research-only decision model. Does not call Shell or validate real settling latency.
'use strict';const assert=require('assert/strict');
function settle(previous,predictions,reads,audit){
 if(!predictions.length||predictions.includes(previous.x))return {fallback:true};
 let candidate=null;
 for(const r of reads){
  if(r.oldChanged||r.flagsChanged)return {ok:false};
  if(r.changing){candidate=null;continue;}
  if(r.count!==1)return {ok:false};
  if(r.x===previous.x||!predictions.includes(r.x)){candidate=null;continue;}
  if(candidate&&candidate.x===r.x&&candidate.y===r.y)return {ok:!!audit&&!audit.oldChanged&&!audit.flagsChanged&&audit.count===1&&audit.x===r.x&&audit.y===r.y};
  candidate=r;
 }
 return {ok:false};
}
const old={x:10,y:20},stale={...old,count:1},changed={x:30,y:20,count:1};
assert.equal(settle(old,[30],[stale,stale,stale],stale).ok,false);
assert.equal(settle(old,[30],[stale,changed,changed],changed).ok,true);
assert.equal(settle(old,[30],[changed,changed],{...changed,x:40}).ok,false);
assert.equal(settle(old,[30],[changed,{...changed,oldChanged:true}],changed).ok,false);
assert.equal(settle(old,[30],[changed,{...changed,flagsChanged:true}],changed).ok,false);
assert.equal(settle(old,[30],[changed,{count:0}],changed).ok,false);
assert.equal(settle(old,[10,30],[changed,changed],changed).fallback,true);
assert.equal(settle(old,[],[changed,changed],changed).fallback,true);
assert.equal(settle(old,[30],[changed,{changing:true},changed],changed).ok,false);
console.log('PASS 9 synthetic fast-settle decision checks; native timing unproven');
