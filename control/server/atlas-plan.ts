export interface AtlasItem { width: number; height: number }
interface Rect extends AtlasItem { x: number; y: number }
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x+a.width >= b.x+b.width && a.y+a.height >= b.y+b.height;
const less = (a: number[], b: number[]) => { for(let i=0;i<a.length;i++) { if(a[i]!==b[i])return a[i]<b[i]; } return false; };
function pack(width: number,height: number,items: AtlasItem[]) {
  let free: Rect[]=[{x:0,y:0,width,height}]; const used: Rect[]=[];
  for(const item of items) {
    const w=item.width+8,h=item.height+8;let chosen:Rect|undefined,score:number[]=[];
    for(const f of free)if(w<=f.width&&h<=f.height) {const next=[Math.min(f.width-w,f.height-h),Math.max(f.width-w,f.height-h),f.y,f.x];if(!chosen||less(next,score)){score=next;chosen={x:f.x,y:f.y,width:w,height:h};}}
    if(!chosen)return;
    const u=chosen,next:Rect[]=[];
    for(const f of free) {
      if(!(f.x<u.x+u.width&&u.x<f.x+f.width&&f.y<u.y+u.height&&u.y<f.y+f.height)){next.push(f);continue;}
      if(u.x>f.x)next.push({...f,width:u.x-f.x});
      if(u.x+u.width<f.x+f.width)next.push({...f,x:u.x+u.width,width:f.x+f.width-u.x-u.width});
      if(u.y>f.y)next.push({...f,height:u.y-f.y});
      if(u.y+u.height<f.y+f.height)next.push({...f,y:u.y+u.height,height:f.y+f.height-u.y-u.height});
    }
    free=next.filter((r,i)=>!next.some((other,j)=>i!==j&&contains(other,r)&&(!contains(r,other)||j<i)));used.push(u);
  }
  return used;
}
export function atlasAllocation(width:number,height:number,scale:number,alignment=16) {
  scale=Math.fround(scale);
  if(width<1||height<1||width>16384||height>16384||!Number.isFinite(scale)||scale<.5||scale>4||![1,16].includes(alignment))return;
  const a=Math.max(2,alignment),align=(n:number)=>Math.ceil(Math.ceil(Math.fround(n*scale))/a)*a;
  const w=align(width),h=align(height);return w<=8192&&h<=8192&&w*h<=16777216?{width:w,height:h}:undefined;
}
export function planAtlas(input:AtlasItem[],scale:number,alignment=16) {
  scale=Math.fround(scale);
  if(!Number.isFinite(scale)||scale<.5||scale>4||![1,16].includes(alignment))return;
  const items=[...input].sort((a,b)=>b.width-a.width||b.height-a.height);
  const widths=new Set([0]);let totalHeight=0;
  for(const item of items){if(!Number.isInteger(item.width)||!Number.isInteger(item.height)||item.width<1||item.height<1||item.width>8192||item.height>8192)return;for(const w of [...widths])if(w+item.width+8<=16384)widths.add(w+item.width+8);totalHeight=Math.min(16384,totalHeight+item.height+8);}
  if(!items.length){const physical=atlasAllocation(16,16,scale,alignment);return physical?{width:16,height:16,scale,physical}:undefined;}
  let best:{width:number;height:number;scale:number;physical:AtlasItem}|undefined;
  const rank=(p:NonNullable<typeof best>)=>[p.physical.width*p.physical.height,Math.max(p.physical.width,p.physical.height),p.width,p.height];
  for(let width of [...widths].sort((a,b)=>a-b)) {
    width=Math.max(16,width);const strip=atlasAllocation(width,16,scale,alignment);if(!strip)continue;
    const a=Math.max(2,alignment),physicalHeight=Math.floor(Math.min(8192,Math.floor(16777216/strip.width))/a)*a;
    let height=Math.max(16,Math.min(totalHeight,16384,Math.floor(Math.fround(physicalHeight/scale))));
    while(height>=16&&!atlasAllocation(width,height,scale,alignment))height--;
    if(height<16)continue;const placed=pack(width,height,items);if(!placed)continue;
    const cw=Math.max(16,...placed.map(p=>p.x+p.width)),ch=Math.max(16,...placed.map(p=>p.y+p.height));
    if(pack(cw,ch,items)){width=cw;height=ch;}
    const physical=atlasAllocation(width,height,scale,alignment);if(!physical)continue;
    const candidate={width,height,scale,physical};if(!best||less(rank(candidate),rank(best)))best=candidate;
  }
  return best;
}
const dprCache = new Map<string, number>();
/** The physical atlas allocation bound may reduce DPR; DIP stays intact. */
export function feasibleDpr(items:AtlasItem[],requested:number) {
  const ceiling=Math.max(.5,Math.min(4,requested));
  const key=JSON.stringify([ceiling,items.map(({width,height})=>({width,height})).sort((a,b)=>b.width-a.width||b.height-a.height)]);
  const cached=dprCache.get(key);if(cached!==undefined)return cached;
  const remember=(value:number)=>{ dprCache.set(key,value);if(dprCache.size>64)dprCache.delete(dprCache.keys().next().value!);return value; };
  if(!planAtlas(items,.5))throw new Error('Visible viewports cannot fit the 8192-axis / 16Mi-pixel atlas at minimum DPR 0.5');
  if(planAtlas(items,ceiling))return remember(Math.fround(ceiling));
  let low=.5,high=ceiling;
  for(let i=0;i<24;i++){const mid=(low+high)/2;if(planAtlas(items,mid))low=mid;else high=mid;}
  // Leave one float ULP below the geometric boundary for serialization/platform rounding.
  return remember(Math.max(.5,Math.fround(low*(1-1.2e-7))));
}
