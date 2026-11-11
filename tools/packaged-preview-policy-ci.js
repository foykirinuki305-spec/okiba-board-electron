'use strict';
const assert=require('assert/strict');
function hosted(env,platform){assert(platform==='win32'&&env.GITHUB_ACTIONS==='true'&&env.RUNNER_OS==='Windows'&&env.RUNNER_ENVIRONMENT==='github-hosted','hosted Windows only');}
function cleanEnv(input,base,old){const e={...input};for(const k of Object.keys(e))if(/^OKIBA_/i.test(k)||/^ELECTRON_RUN_AS_NODE$/i.test(k))delete e[k];return {...e,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_DESKTOP_SAFE_PREVIEW:'1'};}
function known(s){assert(s.ok&&s.snap&&!s.autoArrange&&s.identityVersion===1,'blocked: desktop state');assert(s.areas.length===1&&s.areas[0].scale===100&&s.areas[0].grid,'blocked: requires single known 100% monitor');}
function success(r,sources,destinations){assert(r&&r.metadataCommitted===true);assert.equal(sources.length,3);assert.equal(destinations.length,3);assert.deepEqual(r.moved,sources);assert.deepEqual(r.destinations,destinations);assert.equal(r.error,null);assert.deepEqual(r.failed,[]);assert.deepEqual(r.skipped,[]);assert.deepEqual(r.warnings,[]);assert.equal(r.position?.status,'ok');assert.equal(r.position?.positioned,3);}
module.exports={hosted,cleanEnv,known,success};
