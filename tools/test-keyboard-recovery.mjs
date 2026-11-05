/** Real H264 + immutable remote inputs; only the OS keyboard geometry is simulated.
 * args: playwright module, viewer exe, endpoint exe, browser exe, unused output dir,
 *       [port=34501] [expect=stable|loop] [geometry=visual|content]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const [modulePath, viewer, endpoint, browser, output, portArg='34501', expect='stable', geometry='visual'] = process.argv.slice(2);
const run=resolve(output), port=Number(portArg), origin=`http://127.0.0.1:${port}`;
const { chromium }=createRequire(import.meta.url)(resolve(modulePath));
await mkdir(run);
const remote=[];
const fixture=createServer(async (req,res)=>{
  if(req.method==='POST') {
    let body=''; for await(const chunk of req) body+=chunk;
    remote.push(JSON.parse(body)); res.end(); return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyboard recovery</title>
    <style>body{margin:0}input{position:absolute;left:24px;top:24px;width:280px;height:48px;font-size:20px}button{position:absolute;left:24px;top:140px}</style>
    <input id="text"><button id="blur">Blur</button><script>
    const report=type=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,value:text.value,focused:document.activeElement===text,width:innerWidth,height:innerHeight,at:performance.now()})});
    for(const type of ['focus','blur','input','compositionstart','compositionend'])text.addEventListener(type,()=>report(type));
    window.addEventListener('resize',()=>report('resize')); report('ready');
    </script>`);
});
await new Promise(r=>fixture.listen(port+1,'127.0.0.1',r));
const control=spawn(process.execPath,[resolve('control/dist/server.mjs')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:String(port),REMOTEKIT_CONTROL_ORIGINS:origin,REMOTEKIT_CONTROL_DB:join(run,'control.db'),REMOTEKIT_ENDPOINT:resolve(endpoint),REMOTEKIT_ENDPOINT_ARGS:JSON.stringify(['--browser='+resolve(browser),'--data-path='+join(run,'endpoint')])}});
control.stdout.on('data',d=>void appendFile(join(run,'control.stdout.log'),d));
control.stderr.on('data',d=>void appendFile(join(run,'control.stderr.log'),d));
const stopped=new Promise(r=>control.once('exit',r));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let context,page;
const deadline=setTimeout(()=>void context?.close(),90000);
try {
  for(let n=0; ;n++){if(await fetch(origin+'/api/auth/registration').then(r=>r.ok).catch(()=>false))break;assert.ok(n<60);await pause(100)}
  context=await chromium.launchPersistentContext(join(run,'viewer-profile'),{executablePath:resolve(viewer),headless:false,viewport:{width:820,height:1040},deviceScaleFactor:2,isMobile:true,hasTouch:true,args:['--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required']});
  page=context.pages()[0];
  await page.addInitScript(({geometry})=>{
    const q=window.recoveryQA={events:[],wire:[],peers:[],channels:[],armed:false,height:1040,geometry,open:false,offset:0,held:[]};
    const ids=new WeakMap();let next=0;q.id=o=>o?(ids.has(o)?ids.get(o):(ids.set(o,++next),next)):null;
    q.record=(kind,data={})=>q.events.push({kind,at:performance.now(),...data});
    const vv=visualViewport;
    Object.defineProperty(vv,'height',{get:()=>q.height});
    Object.defineProperty(vv,'offsetTop',{get:()=>q.offset});
    if(geometry==='content')Object.defineProperty(window,'innerHeight',{get:()=>q.height});
    q.resize=height=>{q.height=height;if(geometry==='content')window.dispatchEvent(new Event('resize'));vv.dispatchEvent(new Event('resize'))};
    q.feedback=()=>{if(!q.armed)return;clearTimeout(q.timer);q.timer=setTimeout(()=>{
      if(!q.armed)return;
      const el=document.activeElement,open=!!el?.matches('.remote-input')&&el.inputMode!=='none';
      if(q.open===open)return;q.open=open;q.record('keyboard',{open});q.resize(open?620:1040);
    },110)};
    for(const type of ['focusin','focusout','compositionstart','compositionend'])document.addEventListener(type,e=>{
      if(e.target.matches?.('.remote-input')){q.record(type,{mode:e.target.inputMode,trusted:e.isTrusted});q.feedback()}
    },true);
    let recovery=false;
    new MutationObserver(records=>{
      if(records.some(r=>r.type==='attributes'&&r.target.matches?.('.remote-input')))q.feedback();
      const active=document.body?.innerText.includes('正在恢复页面');
      if(active!==recovery){recovery=active;q.record('recovery',{active})}
    }).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['inputmode']});
    const send=RTCDataChannel.prototype.send;
    const onmessage=Object.getOwnPropertyDescriptor(RTCDataChannel.prototype,'onmessage');
    Object.defineProperty(RTCDataChannel.prototype,'onmessage',{configurable:true,get:onmessage.get,set(handler){
      onmessage.set.call(this,event=>{
        if(q.hold&&this.label!=='remotekit-auth')q.held.push(()=>handler.call(this,event));
        else handler.call(this,event);
      });
    }});
    q.resume=()=>{q.hold=false;for(const deliver of q.held.splice(0))deliver()};
    RTCDataChannel.prototype.send=function(raw){if(this.label!=='remotekit-auth'&&typeof raw==='string')try{q.wire.push({direction:'out',at:performance.now(),message:JSON.parse(raw)})}catch{}return send.call(this,raw)};
    const Peer=RTCPeerConnection;window.RTCPeerConnection=class extends Peer {
      constructor(...args){super(...args);q.peers.push(this)}
      createDataChannel(...args){const ch=super.createDataChannel(...args);q.channels.push(ch);if(ch.label!=='remotekit-auth')ch.addEventListener('message',e=>{try{const message=JSON.parse(e.data);if(['layout','input.editable','focus','input.result'].includes(message.type))q.wire.push({direction:'in',at:performance.now(),message})}catch{}});return ch}
    };
    q.sample=()=>({events:q.events,wire:q.wire,focus:document.activeElement?.matches('.remote-input'),height:q.height,preview:[...document.querySelectorAll('.remote-viewport canvas')].map(c=>({cls:c.className,w:c.width,h:c.height,rect:c.getBoundingClientRect().toJSON()})),media:{peers:q.peers.map(p=>[q.id(p),p.connectionState,p.getReceivers().map(r=>q.id(r.track))]),channels:q.channels.map(c=>[q.id(c),c.readyState]),videos:[...document.querySelectorAll('video')].map(v=>[q.id(v),q.id(v.srcObject)])}});
  },{geometry});
  await page.goto(origin);
  const wait=fn=>page.waitForFunction(fn,undefined,{timeout:15000});
  const click=async name=>{
    const point=await page.evaluate(name=>{const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===name||e.getAttribute('aria-label')===name);if(!el)return null;const b=el.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}},name);
    assert.ok(point,`Missing ${name}`);await page.mouse.click(point.x,point.y);
  };
  await wait(()=>document.querySelector('.viewer-lock-blank'));await pause(650);
  for(const key of ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight']){await page.keyboard.press(key);await pause(55)}
  await click('创建账户');
  await page.locator('input[autocomplete=username]').fill('keyboard-recovery');
  await page.locator('input[autocomplete=new-password]').fill(randomBytes(18).toString('hex'));
  await page.locator('button[type=submit]').click();
  await wait(()=>recoveryQA.channels.filter(c=>c.readyState==='open').length===2);
  await click('新建窗口');
  const ready=()=>wait(()=>{const v=document.querySelector('.remote-viewport');return v&&!v.classList.contains('resize-waiting')&&v.querySelector('canvas[data-video-input]:not(.no-frame)')&&v.querySelector('video')?.videoWidth>0});
  const navigate=async path=>{await page.locator('.address-form input').fill(`http://127.0.0.1:${port+1}/${path}`);await page.keyboard.press('Enter');await ready();await pause(500)};
  await navigate('background');await click('新建标签页');await navigate('foreground');
  const before=await page.evaluate(()=>{recoveryQA.armed=true;recoveryQA.events=[];recoveryQA.wire=[];return recoveryQA.sample()});
  const box=await page.locator('.remote-viewport').boundingBox();
  await page.touchscreen.tap(box.x+150,box.y+48);
  await pause(6500);
  const after=await page.evaluate(()=>recoveryQA.sample());
  const opens=after.events.filter(e=>e.kind==='keyboard'&&e.open).length;
  const closes=after.events.filter(e=>e.kind==='keyboard'&&!e.open).length;
  const empty=after.wire.filter(e=>e.message.type==='layout'&&e.message.generation==='0'&&!e.message.reconfiguring).length;
  const summary={expect,geometry,opens,closes,ordinaryEmptyLayouts:empty,focus:after.focus,mediaStable:JSON.stringify(before.media)===JSON.stringify(after.media)};
  await writeFile(join(run,'trace.json'),JSON.stringify({before,after,remote},null,2));
  await writeFile(join(run,'summary.json'),JSON.stringify(summary,null,2));console.log(summary);
  if(expect==='loop'){assert.ok(opens>=2&&closes>=1,'Did not reproduce focus/geometry feedback');assert.ok(empty>0)}
  else {
    assert.equal(opens,1);assert.equal(closes,0);assert.equal(after.focus,true);assert.equal(summary.mediaStable,true);
    assert.equal(after.events.filter(e=>e.kind==='recovery'&&e.active).length,0,'Resize must not display page recovery');
    await ready();await page.keyboard.insertText('stable');await pause(500);
    assert.ok(remote.some(e=>e.path==='/foreground'&&e.value==='stable'),'Text not delivered after recovery');
    // Android IME candidate text + candidate-panel height changes. CDP exercises
    // real Blink composition; 229 and OS geometry are deliberately simulated.
    const cdp=await context.newCDPSession(page);
    const imeKey=type=>cdp.send('Input.dispatchKeyEvent',{type,windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
    const version=await cdp.send('Browser.getVersion');
    if(Number(version.product.match(/\/(\d+)/)?.[1])>=100) {
      await imeKey('keyDown');await cdp.send('Input.imeSetComposition',{text:'你',selectionStart:1,selectionEnd:1});await imeKey('keyUp');
      await pause(200);
    }
    // Hold media/control delivery beyond the old 1.8s preview deadline. The
    // local IME continues; input must remain buffered behind the frame barrier.
    await page.evaluate(()=>{recoveryQA.hold=true;recoveryQA.resize(540)});
    await pause(2200);
    const pending=await page.evaluate(()=>({focus:document.activeElement?.matches('.remote-input'),freeze:!!document.querySelector('.remote-resize-freeze.keyboard-peek'),waiting:!!document.querySelector('.resize-waiting'),recovery:document.body.innerText.includes('正在恢复页面')}));
    if(!pending.freeze)console.log('preview',await page.evaluate(()=>recoveryQA.sample().preview));
    assert.deepEqual(pending,{focus:true,freeze:true,waiting:true,recovery:false});
    if(Number(version.product.match(/\/(\d+)/)?.[1])>=100) {
      await imeKey('keyDown');await cdp.send('Input.insertText',{text:'你'});await imeKey('keyUp');
    }
    await page.evaluate(()=>recoveryQA.resume());await ready();await pause(350);
    const expectedText=Number(version.product.match(/\/(\d+)/)?.[1])>=100?'stable你':'stable';
    assert.ok(remote.some(e=>e.path==='/foreground'&&e.value===expectedText),'Composition was not delivered once after resize');
    if(expectedText.endsWith('你')) {
      assert.ok(remote.some(e=>e.path==='/foreground'&&e.type==='compositionend'&&e.value===expectedText));
      const commits=await page.evaluate(()=>recoveryQA.wire.filter(e=>e.direction==='out'&&e.message.type==='input'&&e.message.event?.type==='ime_commit'&&e.message.event.text==='你'));
      assert.equal(commits.length,1,'The IME candidate must commit exactly once');
    }
    // Caret panning changes offsets but must not configure a new remote size.
    const epochs=()=>page.evaluate(()=>recoveryQA.wire.filter(e=>e.message.type==='layout').length);
    const beforePan=await epochs();
    await page.evaluate(()=>{recoveryQA.offset=24;visualViewport.dispatchEvent(new Event('scroll'))});await pause(400);
    assert.equal(await epochs(),beforePan);
    await page.evaluate(()=>{recoveryQA.offset=0;visualViewport.dispatchEvent(new Event('scroll'));recoveryQA.resize(620)});await pause(700);await ready();
    // Android Back: geometry restoration does not blur the DOM editor.
    await page.evaluate(()=>{recoveryQA.armed=false;clearTimeout(recoveryQA.timer);recoveryQA.open=false;recoveryQA.resize(1040)});await pause(1000);await ready();
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('.remote-input')),true);
    await page.evaluate(()=>{recoveryQA.armed=true});await click('显示键盘');await pause(1600);await ready();
    assert.equal(await page.evaluate(()=>recoveryQA.open),true);
    // A window-focus loss can be an IME-owned dialog, not a DOM blur.
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await pause(350);
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('.remote-input')),true);
    await page.keyboard.insertText('!');await pause(500);
    assert.ok(remote.some(e=>e.path==='/foreground'&&e.value===expectedText+'!'));
    const b=await page.locator('.remote-viewport').boundingBox();await page.touchscreen.tap(b.x+50,b.y+150);await pause(1000);
    assert.equal(await page.evaluate(()=>recoveryQA.open),false,'Real remote blur must close keyboard');
    await writeFile(join(run,'verified.json'),JSON.stringify({browser:version.product,cdpComposition:expectedText.endsWith('你'),sample:await page.evaluate(()=>recoveryQA.sample()),remote},null,2));
    console.log(`${expectedText.endsWith('你')?'IME candidate/229':'Direct text (Chrome89)'}, slow resize preview, caret pan, Back/reopen, IME window blur, remote blur: passed`);
  }
} finally {
  if(page&&!page.isClosed())await writeFile(join(run,'final-trace.json'),JSON.stringify({sample:await page.evaluate(()=>recoveryQA.sample()).catch(()=>null),remote},null,2));
  clearTimeout(deadline);await context?.close();if(control.connected)control.disconnect();
  await Promise.race([stopped,pause(10000)]);fixture.close();
}
