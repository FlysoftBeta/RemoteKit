// Isolated experiment policy adapter. Product modules remain untouched.
// Run with control/node_modules/.bin/tsx tools/viewer-video-clip-server.mts <run>.
// Reuses the formal baseline fixture and its /shutdown route.
import {EndpointProcess} from '../control/server/endpoint.ts';
const start=EndpointProcess.prototype.start, request=EndpointProcess.prototype.request;
EndpointProcess.prototype.start=function() {
  const instance=this as unknown as {args:string[];videoClipConfigured?:boolean};
  if(!instance.videoClipConfigured){instance.args.push('--fps=50');instance.videoClipConfigured=true;}
  return start.call(this);
};
EndpointProcess.prototype.request=function(method,tenant,args={}) {
  // Forward the cap to the native peer; its observed applied policy is checked
  // by the browser runner. WebRTC congestion adaptation remains active.
  if(method==='session.mediaPolicy') return request.call(this,method,tenant,{...args,maxFps:50});
  return request.call(this,method,tenant,args);
};
await import('./viewer-presentation-baseline-server.mts');
