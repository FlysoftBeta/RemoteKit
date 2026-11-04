import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('ordinary Viewer console export reads compact scalars without credentials, SDP or identities',()=>{
  let copied='';
  const secret='NEVER_EXPORT_SECRET';
  const transport={diagnostics:{videoWidth:1936,videoHeight:816,decodedFramesPerSecond:12,token:secret,endpoint:{gccTargetFps:57,gccTargetBitrate:12000000,queueFullDrops:2,mediaPolicy:{requested:{degradationPreference:'balanced',maxFps:60,secret},applied:{degradationPreference:'balanced',maxFps:60,secret}},secret}},signaling:{originalOfferSdp:secret},getPresentationDiagnostics:()=>({presentationEndpoint:'video-compositor-observation',rendering:{backend:'video',secret,videoCompositorByView:{privateView:{frames:40,callbacks:37,fps:12,secret}}}})};
  const element={'__reactFiber$fixture':{memoizedState:{memoizedState:{current:transport}}}};
  vm.runInNewContext(fs.readFileSync(new URL('../../tools/viewer-diagnostics-console.js',import.meta.url),'utf8'),{document:{querySelectorAll:()=>[element],visibilityState:'visible'},navigator:{userAgent:'Chrome/138'},console:{log(){}},copy:(text:string)=>copied=text});
  assert.ok(!copied.includes(secret));assert.ok(!copied.includes('privateView'));assert.ok(copied.length<3000);
  const result=JSON.parse(copied);assert.equal(result.presentationEndpoint,'video-compositor-observation');assert.deepEqual(result.planes,[{frames:40,callbacks:37,fps:12}]);assert.equal('adaptive' in result,false);assert.equal(result.policy.requested.degradationPreference,'balanced');assert.equal(result.policy.applied.maxFps,60);assert.equal('codecTargetFps' in result.policy.applied,false);assert.equal(result.source.gccTargetFps,57);assert.equal(result.source.gccTargetBitrate,12000000);assert.equal(result.source.queueFullDrops,2);
});
