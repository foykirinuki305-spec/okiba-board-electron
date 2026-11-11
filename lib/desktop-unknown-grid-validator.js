// Bundled pure validation; native private ledger and identity checks remain authoritative.
'use strict';const {verifyProof,fixShape,verifyTargets}=require('./desktop-unknown-grid-model');
const {parseUtf8Json}=require('./desktop-unknown-grid-json-wire');const chunks=[];let inputSize=0;process.stdin.on('data',s=>{chunks.push(s);inputSize+=s.length;if(inputSize>1048576){process.stderr.write('input-limit');process.exit(2);}});process.stdin.on('end',()=>{try{
 const p=parseUtf8Json(Buffer.concat(chunks));const proof=verifyProof(p.proof);if(!proof.ok)throw Error(proof.reason);const shape=fixShape(p.items,p.anchorPath);const g=proof.grid;
 const anchor={x:g.gx+Math.floor((p.requestedAnchor.x-g.gx)/g.sx+.5)*g.sx,y:g.gy+Math.floor((p.requestedAnchor.y-g.gy)/g.sy+.5)*g.sy};
 const targets=shape.map(s=>({path:s.path,x:anchor.x+s.dx*g.sx,y:anchor.y+s.dy*g.sy}));const result=verifyTargets({shape,targets,anchor,grid:g,area:p.area,old:p.old});if(!result.ok)throw Error(result.reason);
 const output=JSON.stringify({ok:true,grid:g,anchor,shape,targets});if(Buffer.byteLength(output)>65536)throw Error('output-limit');process.stdout.write(output);
}catch(e){process.stdout.write(JSON.stringify({ok:false,reason:e.message}));process.exitCode=1;}});
