import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
async function startGestureFixture({ port: fixturePort, run, call }) {
  const latest = new Map(),
    commands = new Map(),
    fixtureHtml = await readFile(new URL('../fixtures/native-gestures.html', import.meta.url));
  const fixture = createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') {
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === '/record' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4 * 1024 * 1024) throw Error('Evidence too large');
        }
        await writeFile(join(run, `evidence-${Date.now()}.json`), JSON.stringify(JSON.parse(body)));
        res.end('saved');
        return;
      }
      if (url.pathname === '/command') {
        const id = url.searchParams.get('id') ?? '';
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 4096) throw Error('command too large');
          }
          const value = JSON.parse(body);
          if (value.type !== 'remove-child') throw Error('unknown fixture command');
          commands.set(id, [...(commands.get(id) ?? []), value]);
          res.end('queued');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(commands.get(id) ?? []));
        commands.delete(id);
        return;
      }
      if (url.pathname === '/telemetry' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
        }
        const value = JSON.parse(body);
        latest.set(`${value.id}:${value.child ? 'child' : 'root'}`, value);
        await appendFile(join(run, 'telemetry.jsonl'), body + '\n');
        res.end('ok');
        return;
      }
      if (url.pathname === '/inspect') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ run, telemetry: Object.fromEntries(latest), users: await call('snapshots') }),
        );
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fixtureHtml);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  await new Promise((done, reject) => {
    fixture.once('error', reject);
    fixture.listen(fixturePort, '0.0.0.0', done);
  });
  return fixture;
}

export async function startFixture(kind, port, context = {}) {
  if (kind === 'gestures') return startGestureFixture({ ...context, port });
  const server = createServer(await fixtureHandlers[kind](context));
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return server;
}
const fixtureHandlers = {
  'keyboard-occlusion':
    ({ events }) =>
    async (request, response) => {
      if (request.method === 'POST') {
        let bytes = '';
        for await (const part of request) bytes += part;
        events.push(JSON.parse(bytes));
        return response.end();
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Occlusion</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(40,90,160);overflow:hidden}
      input{position:absolute;left:24px;top:24px;width:260px;height:48px;font-size:20px}
      #footer{position:fixed;bottom:0;height:12px;left:0;right:0;background:rgb(220,20,180)}
      #motion{position:absolute;top:210px;width:8px;height:8px;background:#0f0}</style>
      <input id="text"><div id="footer"></div><div id="motion"></div><script>
      const report=type=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,height:innerHeight,visualHeight:visualViewport.height,width:innerWidth,value:text.value,focused:document.activeElement===text,at:performance.now()})});
      for(const type of ['focus','blur','input','compositionstart','compositionend'])text.addEventListener(type,()=>report(type));
      document.addEventListener('pointerdown',e=>fetch('/event',{method:'POST',body:JSON.stringify({type:'pointer',x:e.clientX,y:e.clientY,path:location.pathname})}));
      window.addEventListener('resize',()=>report('resize'));report('ready');
      function animate(t){motion.style.left=(t/10%120)+'px';requestAnimationFrame(animate)}requestAnimationFrame(animate);
      </script>`);
    },
  workspace: async ({ run }) => {
    const icon = await readFile(new URL('./fixture-icon.png', import.meta.url));
    const events = [];
    return async (req, res) => {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path === '/icon.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(icon);
      if (path === '/manifest.json')
        return res.writeHead(200, { 'Content-Type': 'application/manifest+json' }).end(
          JSON.stringify({
            name: 'Workspace Notes',
            short_name: 'Notes',
            start_url: '/notes/',
            scope: '/notes/',
            display: 'standalone',
            theme_color: '#2660b5',
            icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }],
          }),
        );
      if (path === '/events')
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(events));
      if (path === '/event') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const event = JSON.parse(body);
        events.push(event);
        await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
        return res.end('ok');
      }
      const label =
        path === '/fs/'
          ? 'File System regression'
          : path.startsWith('/flow/')
            ? path.split('/').pop()
            : 'Workspace Notes';
      const filesystem =
        path === '/fs/'
          ? `<script>
      const report = (api, status, error) => fetch('/event', {method:'POST',body:JSON.stringify({api,status,error})});
      (async () => {
        try {
          const directory = await navigator.storage.getDirectory();
          const handle = await directory.getFileHandle('regression.txt', {create:true});
          const writer = await handle.createWritable();
          await writer.write('RemoteKit File System regression');
          await writer.close();
          await report('getDirectory', 'ok');
        } catch (error) { await report('getDirectory', 'error', String(error)); }
      })();
      if (window.webkitRequestFileSystem) window.webkitRequestFileSystem(TEMPORARY, 1024 * 1024, fs => {
        fs.root.getFile('legacy.txt', {create:true}, entry => entry.createWriter(writer => {
          writer.onwriteend = () => report('webkitRequestFileSystem','ok');
          writer.onerror = error => report('webkitRequestFileSystem','error',String(error));
          writer.write(new Blob(['RemoteKit legacy File System regression']));
        }), error => report('webkitRequestFileSystem','error',String(error)));
      }, error => report('webkitRequestFileSystem','error',String(error)));
      else report('webkitRequestFileSystem','unavailable');
    </script>`
          : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        `<!doctype html>
        <html lang="en">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>${label}</title>
          <link rel="manifest" href="/manifest.json">
          <link rel="icon" href="/icon.png">
          <style>
            body { margin: 0; padding: 32px; font: 18px system-ui; background: #edf3fb; color: #234567; }
            h1 { font-size: 32px; }
            a, button, input { display: block; margin: 18px 0; }
            button { padding: 10px 18px; }
            textarea { width: 90%; height: 96px; font: 18px system-ui; }
          </style>
          <h1>${label}</h1>
          <p>A real remote page inside RemoteKit.</p>
          <textarea placeholder="Write a note"></textarea>
          <a href="/outside">Outside scope</a>
          <button onclick="window.open('/notes/popup','notes-popup','width=500,height=500')">Open popup</button>
          <a target="_blank" href="/notes/new-tab">Open browser tab</a>
          <input id="upload" type="file" multiple>
          <nav>
            <a href="/flow/A">A</a>
            <a href="/flow/B">B</a>
            <a href="/flow/C">C</a>
            <a href="/flow/D">D</a>
          </nav>
          <script>
            const note = document.querySelector('textarea');
            note.addEventListener('input', () => fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ path: location.pathname, type: 'note', value: note.value }),
            }));
            document.querySelector('#upload').onchange = async event => fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ files: await Promise.all([...event.target.files].map(async file => ({
                name: file.name,
                text: await file.text(),
              }))) }),
            });
            const geometry = () => fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ path: location.pathname, width: innerWidth, height: innerHeight, geometry: Object.fromEntries([...document.querySelectorAll('textarea,button,a,input')].map((el,i) => [el.tagName.toLowerCase()+'-'+i, el.getBoundingClientRect().toJSON()])) }),
            });
            geometry(); addEventListener('resize', geometry);
          </script>
          ${filesystem}
        </html>`,
      );
    };
  },
  'test-files-ui':
    ({ events, output }) =>
    async (request, response) => {
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        events.push(JSON.parse(body));
        await writeFile(join(output, 'fixture-events.json'), JSON.stringify(events, null, 2));
        return response.end('ok');
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <title>Files UI fixture</title><style>body{font:20px system-ui;background:#eef3fb}
    input{position:fixed;top:42%;left:32px;width:300px;height:44px}</style>
    <h1>Files UI fixture</h1><input type="file" multiple id="upload">
    <script>
      const input = document.querySelector('input');
      const report = () => fetch('/event', {method:'POST',body:JSON.stringify({
        width:innerWidth,height:innerHeight,box:input.getBoundingClientRect().toJSON()
      })});
      addEventListener('resize', report); report();
      input.onchange = () => fetch('/event', {method:'POST',body:JSON.stringify({
        files:[...input.files].map(file => file.name)
      })});
    </script>`);
    },
  'test-context-menu': async ({ remote }) => {
    const html = await readFile(new URL('../fixtures/context-menu.html', import.meta.url));
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQT99AEmIY1TCqYfhqAACGij4QoSpHPwAAAABJRU5ErkJggg==',
      'base64',
    );
    return async (request, response) => {
      if (request.method === 'POST' && request.url === '/event') {
        let body = '';
        for await (const chunk of request) body += chunk;
        remote.push(JSON.parse(body));
        response.end();
      } else if (request.url === '/image.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
      } else
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(html);
    };
  },
  'test-touch-selection': async ({ remote }) => {
    const html = (await readFile(new URL('../fixtures/touch-selection.html', import.meta.url), 'utf8'))
      .replace(
        'let serial = 0;',
        "let serial = 0; let clicks = 0; document.querySelector('#blank').onclick = () => ++clicks;",
      )
      .replace('scrollY,', 'scrollY, clicks,');
    return async (request, response) => {
      if (request.method === 'POST' && request.url === '/event') {
        let body = '';
        for await (const chunk of request) body += chunk;
        remote.push(JSON.parse(body));
        response.end();
      } else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    };
  },
  'test-clipboard': async ({ remote, marker, oversizeMarker }) => {
    const html = (await readFile(new URL('../fixtures/clipboard.html', import.meta.url), 'utf8'))
      .replaceAll('CLIPBOARD_MARKER', marker)
      .replaceAll('OVERSIZE_MARKER', oversizeMarker);
    return async (request, response) => {
      if (request.method === 'POST' && request.url === '/event') {
        let body = '';
        for await (const chunk of request) body += chunk;
        remote.push(JSON.parse(body));
        response.end();
      } else
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(html);
    };
  },
  'test-file-library':
    ({ events }) =>
    async (req, res) => {
      if (req.method === 'POST') {
        let body = '';
        for await (const bytes of req) body += bytes;
        events.push(JSON.parse(body));
        return res.end();
      }
      if (req.url === '/self-close') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
      <button id="closeSelf" style="position:fixed;inset:0" onclick="window.close()">Close page</button>
      <script>
        const report = () => fetch('/event', {method:'POST',body:JSON.stringify({
          type:'geometry',width:innerWidth,height:innerHeight,
          boxes:{closeSelf:document.getElementById('closeSelf').getBoundingClientRect().toJSON()}
        })});
        report();addEventListener('resize',report);
      </script>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>File library regression</title>
    <style>body{font:18px system-ui;margin:24px;background:#eaf2fc}input,button{display:block;margin:24px 0;height:44px;width:320px}canvas{position:fixed;right:0;bottom:0}</style>
    <h1>Native file selection</h1><input id="single" type="file" accept=".txt"><input id="multiple" type="file" multiple>
    <button id="download">Download a file</button>
    <button id="closePage" onclick="window.open('/self-close')">Open self-closing page</button><canvas width="16" height="16"></canvas>
    <script>
      const report = (type, extra = {}) => fetch('/event', {
        method: 'POST', body: JSON.stringify({ type, ...extra }),
      });
      const controls = ['single', 'multiple', 'download', 'closePage'].map(id => document.getElementById(id));
      controls[2].onclick = event => {
        report('download-click', { trusted: event.isTrusted });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['RemoteKit download import'], { type: 'text/plain' }));
        link.download = 'download.txt';
        link.click();
      };
      const geometry = () => report('geometry', {
        width: innerWidth, height: innerHeight,
        boxes: Object.fromEntries(controls.map(element => [element.id, element.getBoundingClientRect().toJSON()])),
      });
      geometry();
      addEventListener('resize', geometry);
      for (const input of controls.slice(0, 2)) {
        input.onchange = async () => {
          const files = await Promise.all([...input.files].map(async file => ({
            name: file.name, size: file.size,
            hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
              byte => byte.toString(16).padStart(2, '0')).join(''),
          })));
          report('selected', { id: input.id, files });
          input.value = '';
        };
      }
      let tick = 0;
      setInterval(() => {
        const drawing = document.querySelector('canvas').getContext('2d');
        drawing.fillStyle = ++tick % 2 ? 'red' : 'blue';
        drawing.fillRect(0, 0, 16, 16);
      }, 120);
    </script>`);
    },
  'test-camera-scan':
    ({ events }) =>
    async (request, response) => {
      if (request.method === 'POST') {
        let body = '';
        for await (const bytes of request) body += bytes;
        events.push(JSON.parse(body));
        return response.end('ok');
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Camera scan selection</title>
    <style>body{font:18px system-ui;margin:24px;background:#eaf2fc}input{display:block;margin:24px 0;height:44px;width:320px}</style>
    <h1>Camera scan selection</h1>
    <input id="single" type="file" accept="image/png">
    <input id="multiple" type="file" accept="image/*" multiple>
    <script>
      const report = event => fetch('/event', {method:'POST', body:JSON.stringify(event)});
      const inputs = [...document.querySelectorAll('input')];
      const geometry = () => report({type:'geometry', width:innerWidth, height:innerHeight,
        boxes:Object.fromEntries(inputs.map(input => [input.id, input.getBoundingClientRect().toJSON()]))});
      geometry(); addEventListener('resize', geometry);
      for (const input of inputs) input.onchange = async event => {
        const files = await Promise.all([...input.files].map(async file => {
          try {
            const bitmap = await createImageBitmap(file);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0);
            const pixel = [...drawing.getImageData(0, 0, 1, 1).data];
            bitmap.close();
            return {name:file.name, type:file.type, size:file.size,
              width:canvas.width, height:canvas.height, pixel};
          } catch (error) { return {name:file.name, type:file.type, error:String(error)}; }
        }));
        await report({type:'selected', id:input.id, trusted:event.isTrusted, files});
        input.value = '';
      };
    </script>`);
    },
  'test-mobile-ime': async ({ fixtureEvents, run }) => {
    const fixturePage = await readFile(new URL('../fixtures/keyboard-viewport.html', import.meta.url));
    return async (request, response) => {
      if (request.url === '/event' && request.method === 'POST') {
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 65536) {
              response.writeHead(413).end();
              return;
            }
          }
          const event = JSON.parse(body);
          fixtureEvents.push(event);
          if (fixtureEvents.length > 2048) fixtureEvents.shift();
          await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
          response.end();
        } catch {
          response.writeHead(400).end();
        }
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(fixturePage);
    };
  },
  'test-fullscreen': async ({ fixtureEvents, run }) => {
    const fixturePage = `<!doctype html><meta charset="utf-8"><title>Fullscreen fixture</title>
<style>
  body { margin:0; font:16px Arial; background:#d0e5fc; }
  main { position:relative; width:100vw; height:100vh; background:#d0e5fc; }
  main:fullscreen { background:#125267; color:white; }
  button { font:inherit; padding:12px; margin:8px; }
  #hit { position:absolute; bottom:8%; right:5%; }
  canvas { position:absolute; bottom:8px; left:8px; }
</style>
<main><button id="enter">Enter fullscreen</button><button id="exit">Exit fullscreen</button>
<button id="navigate">Navigate in fullscreen</button><button id="hit">Hit bottom right</button>
<canvas width="24" height="24"></canvas></main>
<script>
  const main = document.querySelector('main');
  const buttons = Array.from(main.querySelectorAll('button'));
  const context = document.querySelector('canvas').getContext('2d');
  let tick = 0;
  setInterval(() => {
    context.fillStyle = tick++ % 2 ? '#ef512a' : '#0463aa';
    context.fillRect(0, 0, 24, 24);
  }, 80);
  const report = (type, details) => fetch('/event', {
    method:'POST', keepalive:true, headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type, documentId:performance.timeOrigin, path:location.pathname,
      width:innerWidth, height:innerHeight, fullscreen:document.fullscreenElement?.id || document.fullscreenElement?.tagName || null,
      geometry:Object.fromEntries(buttons.map(button => [button.id, button.getBoundingClientRect().toJSON()])), ...details}),
  }).catch(() => {});
  for (const button of buttons) button.addEventListener('click', async event => {
    const details = {target:button.id, trusted:event.isTrusted, active:navigator.userActivation.isActive,
      x:event.clientX, y:event.clientY};
    void report('click', details);
    try {
      if (button.id === 'enter') await main.requestFullscreen();
      if (button.id === 'exit') await document.exitFullscreen();
      if (button.id === 'navigate') location.assign('/navigated');
    } catch (error) { void report('fullscreen-error', {...details, error:String(error)}); }
  });
  document.addEventListener('fullscreenchange', event => void report('fullscreenchange', {trusted:event.isTrusted}));
  addEventListener('resize', () => void report('resize'));
  void report('ready');
</script>`;
    return async (request, response) => {
      if (request.method === 'POST' && request.url === '/event') {
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 16384) {
              response.writeHead(413).end();
              return;
            }
          }
          const event = JSON.parse(body);
          fixtureEvents.push(event);
          await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
          response.end();
        } catch {
          response.writeHead(400).end();
        }
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(fixturePage);
    };
  },
  'test-diagnostic-collection':
    ({ onVisit }) =>
    (request, response) => {
      if (request.url === '/') onVisit();
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta charset="utf-8"><title>Diagnostic collection fixture</title>
    <style>body { margin:24px; font:16px Arial; background:#d0e5fc; }</style>
    <h1>Diagnostic collection fixture</h1><canvas width="24" height="24"></canvas>
    <script>
      console.warn('diagnostic-fixture-console-marker');
      const ctx = document.querySelector('canvas').getContext('2d');
      let frame = 0;
      setInterval(() => {
        ctx.fillStyle = frame++ % 2 ? '#ef512a' : '#0463aa';
        ctx.fillRect(0, 0, 24, 24);
      }, 80);
    </script>`);
    },
  'test-cluster-nodes':
    ({ events }) =>
    async (request, response) => {
      if (request.method === 'POST') {
        let raw = '';
        for await (const bytes of request) raw += bytes;
        events.push(JSON.parse(raw));
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Cluster ${request.url}</title>
    <style>body{margin:20px;background:#e3effa}button,input{display:block;margin-bottom:20px}</style>
    <button id="store">Persist state</button><input id="file" type="file"><canvas width="24" height="24"></canvas>
    <script>
    const report=(type,extra={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,cookie:document.cookie,storage:localStorage.getItem('cluster'),...extra})});
    store.onclick=()=>{document.cookie='cluster=persisted; Max-Age=86400; SameSite=Lax';localStorage.setItem('cluster','stored-value');report('stored')};
    file.onchange=async()=>{const f=file.files[0];report('attached',{name:f.name,size:f.size,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')})};
    document.addEventListener('click',event=>report('clicked',{id:event.target.id,trusted:event.isTrusted}));
    const geometry=()=>report('ready',{width:innerWidth,height:innerHeight,boxes:Object.fromEntries([store,file].map(el=>[el.id,el.getBoundingClientRect().toJSON()]))});
    geometry();addEventListener('resize',geometry);
    let tick=0;setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=++tick%2?'red':'blue';c.fillRect(0,0,24,24)},100);
    </script>`);
    },
  'cluster-user-journeys':
    ({ events, run }) =>
    async (req, res) => {
      if (req.method === 'POST') {
        let raw = '';
        for await (const part of req) raw += part;
        const value = JSON.parse(raw);
        events.push(value);
        await appendFile(join(run, 'fixture.jsonl'), JSON.stringify(value) + '\n');
        return res.end('ok');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Cluster ${req.url}</title>
  <style>body{margin:20px;background:#e3effa;font:18px Arial}input,button,a{display:block;margin:20px 0;padding:10px}input{width:200px}</style>
  <h1>Cluster ${req.url}</h1><input id="value" value="${req.url.includes('mutated') ? 'isolated-new-value' : 'before-crash'}"><button id="store">Persist state</button><p id="state"></p><a href="/history">Visit history</a><input id="file" type="file"><canvas width="24" height="24"></canvas>
  <script>const report=(type)=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,cookie:document.cookie,storage:localStorage.getItem('cluster'),width:innerWidth,height:innerHeight,boxes:Object.fromEntries([...document.querySelectorAll('input,button,a')].map(e=>[e.id||'link',e.getBoundingClientRect().toJSON()]))})});
  store.onclick=()=>{document.cookie='cluster='+value.value+'; Max-Age=86400; SameSite=Lax';localStorage.setItem('cluster',value.value);report('stored')};
  const show=()=>state.textContent='Cookie: '+document.cookie+' | localStorage: '+localStorage.getItem('cluster');show();store.addEventListener('click',show);
  report('ready');addEventListener('resize',()=>report('ready'));let i=0;setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=i++%2?'red':'blue';c.fillRect(0,0,24,24)},150);</script>`);
    },
  'shell-avail-cluster':
    ({}) =>
    (_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<title>Unavailable browser fixture</title><h1>Browser restored</h1><input value="dirty session"><script>localStorage.setItem("shell-avail","dirty")</script>',
      );
    },
  'input-user-journeys':
    ({ pendingImages, telemetry, root }) =>
    async (req, res) => {
      if (req.url.startsWith('/slow-image.png')) {
        pendingImages.add(res);
        res.on('close', () => pendingImages.delete(res));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const value = JSON.parse(body);
        telemetry.set(value.caseId, value);
        await appendFile(join(root, 'journey-fixture.jsonl'), body + '\n');
        return res.end('ok');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Input journey form</title><style>body{margin:0;padding:16px;font:18px/1.5 Arial;background:#f6f8fc;color:#193450}h1{font-size:24px;margin:0 0 12px}label{display:block;margin:16px 0}input,textarea{display:block;box-sizing:border-box;width:100%;padding:10px;font:20px Arial}p{font:22px/1.7 monospace}a,button{padding:12px;display:inline-block}#words{white-space:nowrap;font:20px monospace}#tail{height:200px;background:#bed3ec}</style>
  <h1>Conference registration / 报名表</h1><div id="words">alpha bravo charlie delta</div>
  <a id="link" href="/next${new URL(req.url, 'http://fixture').search}">Open next page</a>
  <label>Name / 姓名<input id="name" autocomplete="name"></label>
  <label>Email<input id="email" type="email"></label><label>Notes<textarea id="notes"></textarea></label>
  ${Array.from({ length: 10 }, (_, i) => `<label>Question ${i + 1}<input id="q${i}"></label>`).join('')}
  <button id="submit" onclick="document.querySelector('#status').textContent='Submitted';report('submit')">Submit</button><div id="status"></div><div id="tail">End of long form</div>
  ${req.url.startsWith('/loading') ? '<img src="/slow-image.png" alt="Loading illustration">' : ''}
  <script>
  const caseId=new URLSearchParams(location.search).get('case');let n=0;
  function report(type){const nodes=[...document.querySelectorAll('[id]')];const word=()=>{const r=document.createRange();r.setStart(words.firstChild,6);r.setEnd(words.firstChild,11);return r.getBoundingClientRect().toJSON()};fetch('/event',{method:'POST',body:JSON.stringify({caseId,type,n:++n,path:location.pathname,width:innerWidth,height:innerHeight,scrollY,scale:visualViewport.scale,active:document.activeElement.id,selection:getSelection().toString(),values:Object.fromEntries(nodes.filter(x=>x.matches('input,textarea')).map(x=>[x.id,x.value])),geometry:{...Object.fromEntries(nodes.map(x=>[x.id,x.getBoundingClientRect().toJSON()])),word:word()}})})}
  for(const t of ['input','focusin','focusout','selectionchange','compositionstart','compositionupdate','compositionend','scroll','resize'])addEventListener(t,()=>report(t));
  report('ready');setInterval(()=>report('sample'),600);
  </script>`);
    },
  'test-coordination-reconnect':
    ({ getClosePage, setGeometry, onChildLoad }) =>
    async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/close') {
        response.end(JSON.stringify(getClosePage()));
        return;
      }
      if (request.method === 'POST') {
        let text = '';
        for await (const bytes of request) text += bytes;
        setGeometry(JSON.parse(text));
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/child') {
        onChildLoad();
        response.end(
          '<title>Self closing child</title><script>setInterval(async()=>{if(await(await fetch("/close")).json()) window.close()},100)</script>',
        );
        return;
      }
      response.end(
        '<title>Parent</title><button style="position:fixed;inset:0;width:100vw;height:100vh" onclick="window.open(\'/child\')">Open child</button><canvas width="24" height="24"></canvas><script>const report=()=>fetch("/geometry",{method:"POST",body:JSON.stringify({width:innerWidth,height:innerHeight})});report();addEventListener("resize",report);let tick=0;setInterval(()=>{const c=document.querySelector("canvas").getContext("2d");c.fillStyle=++tick%2?"red":"blue";c.fillRect(0,0,24,24)},100)</script>',
      );
    },
};

export async function cameraFixtures(run, samples = [3, 4]) {
  const { launchBrowser } = await import('./viewer.mjs');
  const browser = await launchBrowser({ channel: 'msedge' });
  const cameras = new Map();
  try {
    const page = await browser.newPage();
    for (const sample of samples) {
      const bytes = await readFile(new URL(`../fixtures/camera-scan-${sample}.jpg`, import.meta.url));
      const encoded = await page.evaluate(
        async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          const width = 1920,
            height = 1080;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const drawing = canvas.getContext('2d');
          drawing.imageSmoothingQuality = 'high';
          const scale = Math.max(width / image.width, height / image.height);
          const imageWidth = Math.round(image.width * scale),
            imageHeight = Math.round(image.height * scale);
          drawing.drawImage(
            image,
            Math.floor((width - imageWidth) / 2),
            Math.floor((height - imageHeight) / 2),
            imageWidth,
            imageHeight,
          );
          const pixels = drawing.getImageData(0, 0, width, height).data;
          // Fake camera files use planar YUV420 with limited-range BT.601 samples.
          const frame = new Uint8Array((width * height * 3) / 2);
          const plane = width * height;
          const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const index = (y * width + x) * 4;
              frame[y * width + x] = clamp(
                16 + 0.257 * pixels[index] + 0.504 * pixels[index + 1] + 0.098 * pixels[index + 2],
              );
              if (x % 2 || y % 2) continue;
              let red = 0,
                green = 0,
                blue = 0;
              for (const offset of [0, 4, width * 4, width * 4 + 4]) {
                red += pixels[index + offset] / 4;
                green += pixels[index + offset + 1] / 4;
                blue += pixels[index + offset + 2] / 4;
              }
              const chroma = (y / 2) * (width / 2) + x / 2;
              frame[plane + chroma] = clamp(128 - 0.148 * red - 0.291 * green + 0.439 * blue);
              frame[plane + plane / 4 + chroma] = clamp(128 + 0.439 * red - 0.368 * green - 0.071 * blue);
            }
          const chunks = [];
          for (let offset = 0; offset < frame.length; offset += 32768)
            chunks.push(String.fromCharCode(...frame.subarray(offset, offset + 32768)));
          return btoa(chunks.join(''));
        },
        'data:image/jpeg;base64,' + bytes.toString('base64'),
      );
      const target = join(run, `camera-${sample}.y4m`);
      await writeFile(
        target,
        Buffer.concat([
          Buffer.from('YUV4MPEG2 W1920 H1080 F30:1 Ip A1:1 C420jpeg\nFRAME\n'),
          Buffer.from(encoded, 'base64'),
        ]),
      );
      cameras.set(sample, target);
    }
    return cameras;
  } finally {
    await browser.close();
  }
}
