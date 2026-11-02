import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('ordinary Viewer console export reads compact scalars without credentials, SDP or identities',()=>{
  let copied='';
  const secret='NEVER_EXPORT_SECRET';
  const transport={diagnostics:{videoWidth:1936,videoHeight:816,decodedFramesPerSecond:12,token:secret,endpoint:{adaptiveFps:{actualAppliedRenderFps:12,reason:'display_limit',secret},mediaPolicy:{applied:{codecTargetFps:50}},secret}},signaling:{originalOfferSdp:secret},getPresentationDiagnostics:()=>({frameSource:'video',canvasPaintByView:{privateView:{frames:40,fps:12,secret}},processor:{read:40,secret},rendering:{backend:'canvas-2d',secret,shared:{secret}}})};
  const element={'__reactFiber$fixture':{memoizedState:{memoizedState:{current:transport}}}};
  vm.runInNewContext(fs.readFileSync(new URL('../../tools/viewer-diagnostics-console.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[element],visibilityState:'visible'},navigator:{userAgent:'Chrome/138'},console:{log(){}},copy:(text:string)=>copied=text});
  assert.ok(!copied.includes(secret));assert.ok(!copied.includes('privateView'));assert.ok(copied.length<3000);
  const result=JSON.parse(copied);assert.equal(result.adaptive.actualAppliedRenderFps,12);assert.equal(result.policy.applied.codecTargetFps,50);
});
