// Local integration test for the RemoteKit binary built by this repository.
// No external browser/profile, npm package, or third-party page is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const data = process.argv[2];
const fixtureURL = process.argv[3] || 'http://127.0.0.1:8765/input.html';
if (!data) throw Error('Usage: node tools/verify-browser.mjs <demo-data-directory>');
const port = Number((await fs.readFile(path.join(data, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
assert(port > 0 && port < 65536);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter(t => t.type === 'page' && t.url === fixtureURL);
pages.sort((a,b)=>a.id.localeCompare(b.id));
assert.equal(pages.length, 2, 'Launch remotekit_browser_demo with two fixture pages and --sessions=2');

class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.onmessage = e => {
      const response = JSON.parse(e.data);
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      response.error ? pending.reject(Error(JSON.stringify(response.error))) : pending.resolve(response.result);
    };
  }
  static async open(url) {
    assert(new URL(url).hostname === '127.0.0.1');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    return new CDP(socket);
  }
  call(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}
const clients = [];
try {
  for (const page of pages) clients.push(await CDP.open(page.webSocketDebuggerUrl));
  for (const client of clients) {
    const deadline = Date.now() + 10000;
    while (!await client.evaluate("!!document.getElementById('editor') && !!navigator.userAgentData")) {
      if (Date.now() > deadline) throw Error('Fixture document did not become ready');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  if (process.argv[4] === 'pointer-proof') {
    let types;
    const deadline=Date.now()+5000;
    do {
      types=await Promise.all(clients.map(c=>c.evaluate('fixtureEvents.map(e=>e.type)')));
      if(types.some(t=>t.includes('touchstart')&&t.includes('touchend')&&t.includes('pointerdown')&&t.includes('keydown'))) break;
      if(Date.now()>deadline) throw Error(JSON.stringify(types));
      await new Promise(resolve=>setTimeout(resolve,50));
    } while(true);
    console.log(JSON.stringify({passed:true,remoteInputEvents:types},null,2));
  } else if (process.argv[4] === 'control-proof') {
    const values = await Promise.all(clients.map(c=>c.evaluate('editor.value')));
    assert(values.includes('远程输入😀'), JSON.stringify(values));
    const touchCenter=await clients[0].evaluate('(()=>{const r=touch.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
    console.log(JSON.stringify({remoteAdapterText:values,touchCenter,passed:true},null,2));
    process.exitCode = 0;
  } else {
  const identity = await clients[0].evaluate(`(async()=>({
    ua:navigator.userAgent, brands:navigator.userAgentData.brands,
    high:await navigator.userAgentData.getHighEntropyValues(['fullVersionList','architecture','bitness','platformVersion']),
    chrome:Object.keys(chrome), csi:typeof chrome.csi, loadTimes:typeof chrome.loadTimes,
    appInstalled:chrome.app.isInstalled, runtime:typeof chrome.runtime,
    frames:document.querySelectorAll('iframe').length
  }))()`);
  assert.match(identity.ua, /Chrome\/157\.0\.0\.0/);
  assert(identity.brands.some(b => b.brand === 'Google Chrome' && b.version === '157'));
  assert(identity.brands.some(b => b.brand === 'Chromium'));
  assert(identity.high.fullVersionList.some(b => b.brand === 'Google Chrome' && b.version === '157.0.8103.15'));
  assert.equal(identity.csi, 'function'); assert.equal(identity.loadTimes, 'function');
  assert.equal(identity.appInstalled, false); assert.equal(identity.runtime, 'undefined');
  assert.equal(await clients[0].evaluate('chrome.app.runningState()'), 'cannot_run');
  assert.equal(await clients[0].evaluate('new Promise(resolve=>chrome.app.installState(resolve))'), 'not_installed');
  assert.equal(identity.frames, 1);

  const key = `remotekit-isolation-${Date.now()}`;
  await clients[0].evaluate(`localStorage.setItem(${JSON.stringify(key)}, 'tenant-a')`);
  assert.equal(await clients[1].evaluate(`localStorage.getItem(${JSON.stringify(key)})`), null);
  await clients[0].evaluate(`localStorage.removeItem(${JSON.stringify(key)})`);

  await clients[0].evaluate(`editor.focus(); editor.value=''; fixtureEvents.length=0`);
  await clients[0].call('Input.insertText', { text: 'RemoteKit 中文 😀' });
  assert.equal(await clients[0].evaluate('editor.value'), 'RemoteKit 中文 😀');
  await clients[0].evaluate(`editor.value=''; fixtureEvents.length=0; editor.focus()`);
  await clients[0].call('Input.imeSetComposition', { text: '拼音', selectionStart: 0, selectionEnd: 2 });
  assert.equal(await clients[0].evaluate('editor.value'), '拼音');
  await clients[0].call('Input.insertText', { text: '中文' });
  assert.equal(await clients[0].evaluate('editor.value'), '中文');
  const events = await clients[0].evaluate('fixtureEvents.map(e=>e.type)');
  assert(events.includes('compositionstart') && events.includes('compositionend'));
  console.log(JSON.stringify({ passed: true, identity, isolation: true, unicode: true,
    composition: events, limitation: 'CDP validates Chromium execution; remote adapter and native IME require separate tests.' }, null, 2));
  for (const client of clients) await client.evaluate("editor.focus();editor.value='';fixtureEvents.length=0");
  }
} finally { for (const client of clients) client.close(); }
