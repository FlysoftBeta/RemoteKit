// Experimental page-only renderer. Production RTP/epoch authorization and immutable owner stay intact.
// No input is sent by this harness; this is not a production presentation implementation.
window.installPresentationCandidate = function(t) {
  if(t.presentationDiagnostics.frameSource!=='track-processor')throw Error('Candidate requires immutable MSTP source');
  const original=t.dispatchPaint, holder=document.createElement('div');holder.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:10000';document.body.append(holder);
  const state={mode:'2d',frames:0,byView:{},duplicates:0,drops:{},costs:[],uploads:0,draws:0,lastRtp:null,metadataMissingAtRead:0,metadataWait:[],reads:0,rafCallbacks:0};
  let mode='2d', surfaces=[],canvas,gl,program,buffer,position,uv,texture,width,height,left,top,scale,identityEpoch,identityGeneration;
  const releaseGl=()=>{if(gl){gl.deleteTexture(texture);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();gl=undefined;}};
  const drop=reason=>{state.drops[reason]=(state.drops[reason]??0)+1;};
  const buildShader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
  const setup=()=>{
    releaseGl();holder.replaceChildren();identityEpoch=t.layout?.epoch;identityGeneration=t.layout?.generation;const renderers=Array.from(t.renderers).filter(r=>t.rendererCurrent(r)&&!r.view.stale);
    surfaces=renderers.map(r=>({view:{...r.view},rect:r.canvas.getBoundingClientRect()}));if(!surfaces.length)throw Error('No live planes');
    left=Math.min(...surfaces.map(s=>s.rect.left));top=Math.min(...surfaces.map(s=>s.rect.top));scale=surfaces[0].view.width/surfaces[0].rect.width;
    width=Math.round((Math.max(...surfaces.map(s=>s.rect.right))-left)*scale);height=Math.round((Math.max(...surfaces.map(s=>s.rect.bottom))-top)*scale);
    if(mode==='2d')for(const s of surfaces){const c=document.createElement('canvas');c.width=s.view.width;c.height=s.view.height;c.style.cssText=`position:fixed;left:${s.rect.left}px;top:${s.rect.top}px;width:${s.rect.width}px;height:${s.rect.height}px`;holder.append(c);s.canvas=c;s.context=c.getContext('2d',{alpha:false});}
    else {
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.style.cssText=`position:fixed;left:${left}px;top:${top}px;width:${width/scale}px;height:${height/scale}px`;holder.append(canvas);
      gl=canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:false});if(!gl)throw Error('WebGL2 unavailable');
      program=gl.createProgram();gl.attachShader(program,buildShader(gl.VERTEX_SHADER,'#version 300 es\nin vec2 position;in vec2 uv;out vec2 tex;void main(){gl_Position=vec4(position,0,1);tex=uv;}'));gl.attachShader(program,buildShader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision mediump float;in vec2 tex;uniform sampler2D image;out vec4 color;void main(){color=texture(image,tex);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);position=gl.getAttribLocation(program,'position');uv=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(position);gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(position,2,gl.FLOAT,false,16,0);gl.vertexAttribPointer(uv,2,gl.FLOAT,false,16,8);texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.enable(gl.SCISSOR_TEST);
    }
    for(const r of renderers)r.canvas.style.visibility='hidden';
  };
  const originalProfile=t.profileProcessor;
  t.profileProcessor=function(phase,details){if(phase==='read'){state.reads++;if(details.epoch!==details.layoutEpoch)state.metadataMissingAtRead++;}if(phase==='raf')state.rafCallbacks++;return originalProfile.call(this,phase,details)};
  const render=()=>{
    const owner=t.latestProcessorFrame,frame=owner?.frame,layout=t.layout,rtp=t.displayedRtp;
    if(!frame||!layout||!t.displayReady||t.frameGate.epochFor(rtp)!==layout.epoch){drop('metadata-layout-rtp');return;}
    if(frame.displayWidth!==layout.width||frame.displayHeight!==layout.height){drop('dimensions');return;}
    if(state.lastRtp===rtp){state.duplicates++;return;}
    if(layout.epoch!==identityEpoch||layout.generation!==identityGeneration||surfaces.length!==layout.views.length||surfaces.some(s=>!layout.views.some(v=>!v.stale&&v.id===s.view.id&&v.session===s.view.session&&v.x===s.view.x&&v.y===s.view.y&&v.width===s.view.width&&v.height===s.view.height&&v.instance===s.view.instance&&v.document===s.view.document))){drop('plane-identity-geometry');return;}
    const start=performance.now();let uploadEnd=start;
    try {
      if(mode==='webgl'){gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame);state.uploads++;uploadEnd=performance.now();}
      for(const s of surfaces){const v=s.view;if(mode==='2d')s.context.drawImage(frame,v.x,v.y,v.width,v.height,0,0,v.width,v.height);
        else {const x0=v.x/layout.width,x1=(v.x+v.width)/layout.width,y0=v.y/layout.height,y1=(v.y+v.height)/layout.height;gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,x0,y1,1,-1,x1,y1,-1,1,x0,y0,-1,1,x0,y0,1,-1,x1,y1,1,1,x1,y0]),gl.DYNAMIC_DRAW);const x=Math.round((s.rect.left-left)*scale),y=height-Math.round((s.rect.top-top)*scale)-v.height;gl.viewport(x,y,v.width,v.height);gl.scissor(x,y,v.width,v.height);gl.drawArrays(gl.TRIANGLES,0,6);}state.draws++;state.byView[v.id]=(state.byView[v.id]??0)+1;t.reportPresented(v.id,rtp,performance.now(),Date.now());}
      state.frames++;state.lastRtp=rtp;state.costs.push({at:performance.now(),upload:uploadEnd-start,draw:performance.now()-uploadEnd,total:performance.now()-start,readToSubmit:performance.now()-owner.readAt});state.metadataWait.push(t.authorizedAt-owner.readAt);
    }catch(e){drop('draw-exception:'+String(e));}
  };
  t.dispatchPaint=function(){return original.call(this,render)};
  const api={state,setMode(next){mode=next;state.mode=next;setup();},reset(){for(const k of ['frames','duplicates','uploads','draws','reads','rafCallbacks','metadataMissingAtRead'])state[k]=0;state.byView={};state.drops={};state.costs=[];state.metadataWait=[];state.lastRtp=null;},snapshot(){return {...state,costs:[...state.costs],metadataWait:[...state.metadataWait],geometry:{width,height,scale,surfaces:surfaces.map(s=>({view:s.view,rect:{x:s.rect.x,y:s.rect.y,width:s.rect.width,height:s.rect.height}}))},gl:gl?{renderer:gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION),error:gl.getError()}:null};},dispose(){t.dispatchPaint=original;t.profileProcessor=originalProfile;releaseGl();holder.remove();for(const r of t.renderers)r.canvas.style.visibility='';}};
  api.setMode('2d');return api;
};
