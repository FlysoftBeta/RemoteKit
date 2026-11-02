import { planeMatchesLayout, type PixelRect, type PlaneIdentity } from './plane-source';
import type { Layout } from './types';

export interface SharedPlaneTarget extends PlaneIdentity { canvas: HTMLCanvasElement }
export interface SharedFrame { rtpTimestamp: number; layout: Layout }
export interface SharedPlaneResult { canvas: HTMLCanvasElement; frame: SharedFrame; regions: Map<string, PixelRect>; uploaded: boolean; uploadMs: number; drawMs: number }
export interface PlanePlacement { id: string; input: PixelRect; output: PixelRect }
interface Bounds { left: number; top: number; width: number; height: number }
export interface SharedGeometry extends Bounds { density: number; pixelWidth: number; pixelHeight: number; placements: PlanePlacement[] }

/** Map each DOM content rectangle independently; gutters remain transparent and ROI scales stay explicit. */
export function sharedPlaneGeometry(planes: { id: string; source: PixelRect; client: Bounds }[], maxSide = 8192, maxPixels = 8 * 1024 * 1024): SharedGeometry | undefined {
  if (planes.length < 2 || planes.some(p => ![p.source.x,p.source.y,p.source.width,p.source.height,p.client.left,p.client.top,p.client.width,p.client.height].every(Number.isFinite) || p.client.width <= 0 || p.client.height <= 0 || p.source.width <= 0 || p.source.height <= 0)) return;
  const left = Math.min(...planes.map(p => p.client.left)), top = Math.min(...planes.map(p => p.client.top));
  const density = Math.max(...planes.flatMap(p => [p.source.width / p.client.width, p.source.height / p.client.height]));
  const placements = planes.map(p => ({ id:p.id, input:{...p.source}, output:{x:Math.round((p.client.left-left)*density),y:Math.round((p.client.top-top)*density),width:Math.round(p.client.width*density),height:Math.round(p.client.height*density)} }));
  const pixelWidth = Math.max(...placements.map(p=>p.output.x+p.output.width)), pixelHeight = Math.max(...placements.map(p=>p.output.y+p.output.height));
  if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || pixelWidth > maxSide || pixelHeight > maxSide || pixelWidth*pixelHeight > maxPixels) return;
  return {left,top,width:pixelWidth/density,height:pixelHeight/density,density,pixelWidth,pixelHeight,placements};
}

/** One reusable atlas texture and one visible compositing canvas, with synchronous 2D fallback. */
export class SharedPlaneRenderer {
  private canvas?: HTMLCanvasElement;
  private gl?: WebGL2RenderingContext;
  private texture?: WebGLTexture;
  private program?: WebGLProgram;
  private buffer?: WebGLBuffer;
  private frame?: SharedFrame;
  private targets: SharedPlaneTarget[] = [];
  private originalOpacity = new Map<HTMLCanvasElement,string>();
  private observer?: ResizeObserver;
  private raf?: number;
  private failed = false;
  private disposed = false;
  private maxSide = 8192;
  readonly counts = { frames:0, redraws:0, uploads:0, planeDraws:0, failures:0, fallbackReason:undefined as string|undefined, width:0, height:0 };
  constructor(private options:{ isCurrent:(frame:SharedFrame)=>boolean; onRedraw:(result:SharedPlaneResult)=>void; onFailure:(reason:string)=>void; onResume?:()=>void }) {
    window.addEventListener('resize',this.geometryChanged);
    window.addEventListener('scroll',this.geometryChanged,true);
    document.addEventListener('visibilitychange',this.visibilityChanged);
  }
  private visibilityChanged=()=>{if(document.visibilityState==='hidden')this.clear();else this.options.onResume?.();};
  private geometryChanged=()=>{
    if(this.raf!==undefined||!this.frame||!this.gl)return;
    this.raf=requestAnimationFrame(()=>{this.raf=undefined;const frame=this.frame;if(!frame||!this.options.isCurrent(frame)){this.clear();return;}try{const result=this.drawTexture(frame,this.targets,false,0);if(result){this.counts.redraws++;this.options.onRedraw(result);}}catch(error){this.fail(error,true);}});
  };
  private ensureContext() {
    if(this.gl)return;
    const canvas=document.createElement('canvas');canvas.className='shared-plane-canvas';canvas.setAttribute('aria-hidden','true');
    // Preserve the *actually displayed* backing pixels for synchronous/asynchronous Marker ROI reads.
    const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
    if(!gl)throw Error('webgl2-unavailable');
    this.canvas=canvas;this.gl=gl;
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(this.canvas===canvas)this.fail('context-lost',true);});
    const shader=(type:number,source:string)=>{const s=gl.createShader(type);if(!s)throw Error('shader-allocation');gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(s);gl.deleteShader(s);throw Error('shader-compile:'+error);}return s;};
    const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nin vec2 position;in vec2 uv;out vec2 tex;void main(){gl_Position=vec4(position,0,1);tex=uv;}');
    const fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;in vec2 tex;uniform sampler2D image;out vec4 color;void main(){color=texture(image,tex);}');
    const program=gl.createProgram();if(!program)throw Error('program-allocation');this.program=program;
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('program-link');gl.useProgram(program);
    const buffer=gl.createBuffer(),texture=gl.createTexture();if(!buffer||!texture)throw Error('resource-allocation');this.buffer=buffer;this.texture=texture;
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);const position=gl.getAttribLocation(program,'position'),uv=gl.getAttribLocation(program,'uv');
    gl.enableVertexAttribArray(position);gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(position,2,gl.FLOAT,false,16,0);gl.vertexAttribPointer(uv,2,gl.FLOAT,false,16,8);
    gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    this.maxSide=Math.min(8192,gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));gl.clearColor(0,0,0,0);
    document.body.append(canvas);
    this.observer=typeof ResizeObserver==='function'?new ResizeObserver(this.geometryChanged):undefined;
  }
  render(image:CanvasImageSource,frame:SharedFrame,targets:SharedPlaneTarget[]):SharedPlaneResult|undefined {
    if(this.failed||this.disposed||document.visibilityState==='hidden')return;
    if(targets.length<2){this.clear();return;}
    if(!this.options.isCurrent(frame)||targets.some(target=>!planeMatchesLayout(target,frame.layout)))return;
    const geometry=sharedPlaneGeometry(targets.map(target=>({id:target.view.id,source:target.view,client:target.canvas.getBoundingClientRect()})),this.maxSide);
    if(!geometry||frame.layout.width*frame.layout.height>32*1024*1024){this.clear();this.counts.fallbackReason='geometry-budget-or-hidden';return;}
    try {
      this.ensureContext();const gl=this.gl!;
      if(frame.layout.width>this.maxSide||frame.layout.height>this.maxSide)throw Error('source-texture-limit');
      if(geometry.pixelWidth>this.maxSide||geometry.pixelHeight>this.maxSide)throw Error('output-canvas-limit');
      const start=performance.now();gl.bindTexture(gl.TEXTURE_2D,this.texture!);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image as TexImageSource);
      if(gl.getError()!==gl.NO_ERROR)throw Error('texture-upload');this.counts.uploads++;
      const result=this.drawTexture(frame,targets,true,performance.now()-start,geometry);
      if(!result){this.clear();this.counts.fallbackReason='geometry-budget-or-hidden';return;}
      this.frame=frame;this.targets=[...targets];this.counts.frames++;
      return result;
    }catch(error){this.fail(error,false);return;}
  }
  private drawTexture(frame:SharedFrame,targets:SharedPlaneTarget[],uploaded:boolean,uploadMs:number,plannedGeometry?:SharedGeometry):SharedPlaneResult|undefined {
    const gl=this.gl,canvas=this.canvas;if(!gl||!canvas)return;
    if(targets.some(t=>!t.canvas.isConnected||!planeMatchesLayout(t,frame.layout)))return;
    const geometry=plannedGeometry??sharedPlaneGeometry(targets.map(t=>({id:t.view.id,source:t.view,client:t.canvas.getBoundingClientRect()})),this.maxSide);
    if(!geometry)return;
    const start=performance.now();
    if(canvas.width!==geometry.pixelWidth||canvas.height!==geometry.pixelHeight){canvas.width=geometry.pixelWidth;canvas.height=geometry.pixelHeight;}
    Object.assign(canvas.style,{left:`${geometry.left}px`,top:`${geometry.top}px`,width:`${geometry.width}px`,height:`${geometry.height}px`});
    gl.disable(gl.SCISSOR_TEST);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);
    const regions=new Map<string,PixelRect>();
    for(const placement of geometry.placements){const v=placement.input,o=placement.output,x0=v.x/frame.layout.width,x1=(v.x+v.width)/frame.layout.width,y0=v.y/frame.layout.height,y1=(v.y+v.height)/frame.layout.height;
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,x0,y1,1,-1,x1,y1,-1,1,x0,y0,-1,1,x0,y0,1,-1,x1,y1,1,1,x1,y0]),gl.DYNAMIC_DRAW);
      gl.viewport(o.x,canvas.height-o.y-o.height,o.width,o.height);gl.scissor(o.x,canvas.height-o.y-o.height,o.width,o.height);gl.drawArrays(gl.TRIANGLES,0,6);regions.set(placement.id,{...o});
    }
    if(gl.getError()!==gl.NO_ERROR)throw Error('draw-submit');
    const active=new Set(targets.map(t=>t.canvas));
    for(const [node,opacity]of this.originalOpacity)if(!active.has(node)){node.style.opacity=opacity;this.originalOpacity.delete(node);this.observer?.unobserve(node);}
    for(const target of targets){if(!this.originalOpacity.has(target.canvas)){this.originalOpacity.set(target.canvas,target.canvas.style.opacity);this.observer?.observe(target.canvas);}target.canvas.style.opacity='0';}
    this.counts.planeDraws+=targets.length;this.counts.width=canvas.width;this.counts.height=canvas.height;this.counts.fallbackReason=undefined;
    return {canvas,frame,regions,uploaded,uploadMs,drawMs:performance.now()-start};
  }
  /** Used by getPresentedPlane: never return a retired/hidden shared backing. */
  isVisible(canvas:HTMLCanvasElement){return !this.failed&&this.canvas===canvas&&canvas.isConnected&&!!this.frame;}
  get backend(){return this.frame&&this.canvas&&!this.failed?'shared-webgl':'canvas-2d';}
  resetDiagnostics(){this.counts.frames=0;this.counts.redraws=0;this.counts.uploads=0;this.counts.planeDraws=0;this.counts.failures=0;}
  private fail(error:unknown,notify:boolean){const reason=error instanceof Error?error.message:String(error);this.counts.failures++;this.counts.fallbackReason=reason;this.failed=true;this.clear();if(notify)this.options.onFailure(reason);}
  clear(){
    if(this.raf!==undefined)cancelAnimationFrame(this.raf);this.raf=undefined;this.frame=undefined;this.targets=[];
    this.observer?.disconnect();this.observer=undefined;
    for(const [canvas,opacity]of this.originalOpacity)canvas.style.opacity=opacity;this.originalOpacity.clear();
    const gl=this.gl,canvas=this.canvas;this.canvas=undefined;this.gl=undefined;
    if(gl){gl.deleteTexture(this.texture??null);gl.deleteBuffer(this.buffer??null);gl.deleteProgram(this.program??null);gl.getExtension('WEBGL_lose_context')?.loseContext();}
    this.texture=undefined;this.buffer=undefined;this.program=undefined;canvas?.remove();this.counts.width=0;this.counts.height=0;
  }
  dispose(){this.disposed=true;this.clear();window.removeEventListener('resize',this.geometryChanged);window.removeEventListener('scroll',this.geometryChanged,true);document.removeEventListener('visibilitychange',this.visibilityChanged);}
}
