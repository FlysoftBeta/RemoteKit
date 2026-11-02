// Isolated experiment policy adapter. Product modules remain untouched.
// Run with control/node_modules/.bin/tsx tools/viewer-video-clip-server.mts <run>.
// Reuses the formal baseline fixture and its /shutdown route.
import {EndpointProcess} from '../control/server/endpoint.ts';
const start=EndpointProcess.prototype.start, request=EndpointProcess.prototype.request;
EndpointProcess.prototype.start=function() {
  // Experimental instance only. Product session.mediaPolicy requires adaptive:true;
  // fixed-policy experiments instead use the existing native startup contract.
  const instance=this as unknown as {args:string[];videoClipConfigured?:boolean};
  if(!instance.videoClipConfigured){instance.args.push('--fps=50','--browser-render-fps=50','--adaptive-fps=off');instance.videoClipConfigured=true;}
  return start.call(this);
};
EndpointProcess.prototype.request=function(method,tenant,args={}) {
  // The fixed startup configuration is authoritative. Do not synthesize native
  // stats: the browser runner must observe adaptive=false/targetFps=50 itself.
  if(method==='session.mediaPolicy')return Promise.resolve({accepted:true,applied:true,experimentStartupPolicy:true});
  return request.call(this,method,tenant,args);
};
await import('./viewer-presentation-baseline-server.mts');
