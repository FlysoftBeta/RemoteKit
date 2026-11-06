// Test site for session import end to end. Serves http://127.0.0.1:8090; the emulator reaches the
// same origin through `adb reverse tcp:8090 tcp:8090`, so a login made in the app can be checked
// in the RemoteKit Browser at the same address.
//
// Logging in sets an HttpOnly session cookie (only the server can read it), a script-visible
// cookie and two localStorage items. The page shows what the server and the page script see.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const port = 8090;
const sessions = new Set();

const cookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes('='))
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]),
  );

const escape = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(request) {
  const seen = cookies(request.headers.cookie);
  const session = seen.rk_session;
  const loggedIn = session !== undefined && sessions.has(session);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:site_name" content="导入测试站">
<title>导入测试站</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 640px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .status { padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-weight: 600; }
  .yes { background: #d4f1d9; color: #0e5225; }
  .no { background: #f3e1e1; color: #7a1d1d; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 16px; font-size: 14px; }
  td, th { border-bottom: 1px solid #ddd; padding: 6px 4px; text-align: left; word-break: break-all; }
  button { font: inherit; padding: 8px 16px; margin-right: 8px; }
</style>
</head>
<body>
<h1>导入测试站</h1>
<div id="server" class="status ${loggedIn ? 'yes' : 'no'}">
  服务端：${loggedIn ? `已登录（会话 ${escape(session.slice(0, 8))}…）` : '未登录'}
</div>
<h2>服务端收到的 Cookie</h2>
<table>${Object.entries(seen)
    .map(([name, value]) => `<tr><td>${escape(name)}</td><td>${escape(value)}</td></tr>`)
    .join('') || '<tr><td>（无）</td></tr>'}</table>
<h2>页面脚本可见的 Cookie</h2>
<table id="script-cookies"></table>
<h2>localStorage</h2>
<table id="storage"></table>
<button id="login">登录</button><button id="logout">退出</button>
<script>
  const rows = (pairs) =>
    pairs.length
      ? pairs.map(([k, v]) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>').join('')
      : '<tr><td>（无）</td></tr>';
  document.getElementById('script-cookies').innerHTML = rows(
    document.cookie ? document.cookie.split('; ').map((c) => c.split('=')) : [],
  );
  document.getElementById('storage').innerHTML = rows(
    Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]),
  );
  document.getElementById('login').onclick = async () => {
    await fetch('/login', { method: 'POST' });
    document.cookie = 'rk_theme=dark; path=/; max-age=86400; samesite=lax';
    localStorage.setItem('rk_user', 'demo-user');
    localStorage.setItem('rk_note', '导入测试 ✓');
    location.reload();
  };
  document.getElementById('logout').onclick = async () => {
    await fetch('/logout', { method: 'POST' });
    document.cookie = 'rk_theme=; path=/; max-age=0';
    localStorage.clear();
    location.reload();
  };
</script>
</body>
</html>`;
}

createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/login') {
    const session = randomBytes(16).toString('hex');
    sessions.add(session);
    response.writeHead(204, {
      'Set-Cookie': `rk_session=${session}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`,
    });
    return response.end();
  }
  if (request.method === 'POST' && request.url === '/logout') {
    sessions.delete(cookies(request.headers.cookie).rk_session);
    response.writeHead(204, { 'Set-Cookie': 'rk_session=; Path=/; Max-Age=0' });
    return response.end();
  }
  if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(page(request));
  }
  response.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`Session import test site http://127.0.0.1:${port}`));
