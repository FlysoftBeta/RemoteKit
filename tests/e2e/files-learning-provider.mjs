import assert from 'node:assert/strict';
import { createCipheriv, createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { link, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = join(root, 'control/test/fixtures/learning');
const jwt = (payload) =>
  'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';

export async function fakeLearningProvider(run, browser) {
  const requests = [];
  const events = [];
  const files = new Map();
  const types = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
    png: 'image/png',
    mp3: 'audio/mpeg',
  };
  for (const extension of Object.keys(types)) {
    const bytes = await readFile(join(fixtures, 'files/lesson.' + extension));
    files.set(extension, { bytes, md5: createHash('md5').update(bytes).digest('hex') });
  }
  const zhixue = JSON.parse(await readFile(join(fixtures, 'zhixue.json'), 'utf8'));
  const questions = JSON.parse(await readFile(join(fixtures, 'questions.json'), 'utf8'));
  const published = Date.now() - 2 * 86400_000;
  const homeworks = ['homework-one', 'homework-two'].map((id, index) => ({
    ...zhixue.definition,
    hwId: id,
    stuHwId: 'student-' + id,
    title: '数学作业 ' + (index + 1),
    beginTime: published,
    endDateTime: published + 86400_000,
    commit: false,
    questions: [],
  }));
  const materials = ['pdf', 'png', 'mp3'].map((extension) => ({
    resourceId: extension,
    resourceName: '班级资料 ' + extension,
    extension,
    resourceLength: files.get(extension).bytes.length,
    resourceMd5: files.get(extension).md5,
    subjectCode: '02',
    subjectName: '数学',
    shareTime: published,
    learnState: 0,
    sharePersonId: 'teacher',
    sharePersonName: '老师',
  }));
  let signInCount = 0;
  let expired = false;
  const tokens = new Map();
  const sessions = new Map();
  const md5 = (value) => createHash('md5').update(value).digest('hex');
  const handshake = createCipheriv('aes-256-ecb', Buffer.from('6f0c5ba452b24fa28989e9524d77407a'), null);
  const safeCode = Buffer.concat([handshake.update('learning-safe-code'), handshake.final()]).toString(
    'base64',
  );
  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'https://www.xinjiaoyu.com');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      if (raw)
        body = req.headers['content-type']?.includes('json')
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw));
      requests.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        authorized: !!req.headers.authorization,
        at: Date.now(),
      });
      const json = (data) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const cy = (data) => json({ code: 200, data });
      const zx = (result) => json({ code: '000000', result });
      if (url.pathname === '/fixture/expire') {
        expired = true;
        return json({ ok: true });
      }
      if (url.pathname === '/files-journey')
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>Device upload journey</title>
        <style>body{margin:16px;font:18px system-ui;background:#eaf2fc}input,button{display:block;width:280px;height:44px;margin:20px 0}</style>
        <h2>Files journey</h2><input id="single" type="file" accept=".txt"><input id="multiple" type="file" multiple><input id="images" type="file" accept="image/*" multiple><button id="download">Download notes</button>
        <script>
        const report=e=>fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)});
        const inputs=[...document.querySelectorAll('input,button')];
        const geometry=()=>report({type:'file-geometry',width:innerWidth,height:innerHeight,boxes:Object.fromEntries(inputs.map(i=>[i.id,i.getBoundingClientRect().toJSON()]))});
        addEventListener('resize',geometry);geometry();
        for(const i of document.querySelectorAll('input'))i.onchange=async e=>{await report({type:'file-selected',id:i.id,trusted:e.isTrusted,files:await Promise.all([...i.files].map(async f=>({name:f.name,type:f.type,size:f.size})))});i.value='';};
        document.querySelector('button').onclick=e=>{report({type:'download-click',trusted:e.isTrusted});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Downloaded notes'],{type:'text/plain'}));a.download='page-notes.txt';a.click();};
        </script>`);
      if (expired && url.pathname.startsWith('/api/v3/') && !url.pathname.includes('/auth/login'))
        return json({ code: 416, msg: '登录已过期' });
      if (url.pathname === '/v4/gt4.js')
        return res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(`
window.initGeetest4 = (options, done) => {
 const widget = {onReady(fn){setTimeout(fn, 0);}, onClose(){}, onError(){}, onSuccess(){}, showCaptcha(){
  if (!document.getElementById('fixture-captcha')) { const button=document.createElement('button'); button.id='fixture-captcha'; button.textContent='Fixture verification'; document.querySelector('main').append(button); }
 }}; done(widget);
};`);
      if (url.pathname === '/event') {
        events.push(body);
        return json({ ok: true });
      }
      if (url.pathname === '/auth/login') {
        const clientSessionId = 'learning-page-' + ++signInCount;
        const timestamp = Date.now();
        const headers = {
          clientsession: clientSessionId,
          client: 'front',
          device: 'mobile',
          devicetype: 'Other',
          platformtype: '1',
          t: String(timestamp),
          encrypt: md5('learning-safe-code' + timestamp + clientSessionId + 'front'),
        };
        const query = new URLSearchParams({
          clientSessionId,
          t: String(timestamp),
          client: 'front',
          encrypt: md5('front' + clientSessionId + timestamp),
        });
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>新教育测试登录</title>
          <style>body{margin:24px;font:18px system-ui;background:#edf3fb;color:#234567}input,button{display:block;box-sizing:border-box;width:280px;height:44px;margin:16px 0;font:inherit}canvas{position:fixed;right:0;bottom:0}</style>
          <h1>新教育</h1><label>用户名<input id="username" autocomplete="username"></label>
          <button id="login">登录题库</button><canvas width="16" height="16"></canvas>
          <script>
            const username = document.getElementById('username');
            const login = document.getElementById('login');
            const report = (type, extra = {}) => fetch('/event', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, ...extra }),
            });
            const geometry = () => report('geometry', {
              width: innerWidth, height: innerHeight,
              username: username.getBoundingClientRect().toJSON(),
              login: login.getBoundingClientRect().toJSON(),
            });
            geometry();
            addEventListener('resize', geometry);
            username.oninput = () => report('input', { value: username.value });
            username.onfocus = () => report('focus');
            const headers = ${JSON.stringify(headers)};
            const ready = fetch('/api/v3/server_system/system/code?${query}', { headers });
            login.onclick = async () => {
              await ready;
              const response = await fetch('/api/v3/server_system/auth/login', { method: 'POST', headers });
              const { data } = await response.json();
              await fetch('/api/v3/server_system/audit/cfg/query', {
                headers: { ...headers, authorization: 'JBY ' + data.token, accesstoken: 'learning-access' },
              });
            };
            let tick = 0;
            setInterval(() => {
              const drawing = document.querySelector('canvas').getContext('2d');
              drawing.fillStyle = ++tick % 2 ? '#235caa' : '#edf3fb';
              drawing.fillRect(0, 0, 16, 16);
            }, 150);
          </script>`);
      }
      if (url.pathname === '/sso/v1/api') {
        if (body.method === 'sso.get.captcha.type')
          return json({
            code: 'success',
            data: {
              captchaConf: JSON.stringify({
                gt: 'test-captcha',
                captchaType: 'third',
                notCheckCaptcha: process.env.FILES_CAPTCHA === '1' ? 'false' : 'true',
              }),
            },
          });
        assert(['sso.login.account.v2', 'sso.create.token', 'sso.extend.tgt'].includes(body.method));
        return json({
          code: 'success',
          data: {
            tgt: 'test-tgt',
            at: 'test-at',
            userId: 'student',
            token: 'changyan-token',
            expireIn: 3600,
          },
        });
      }
      if (url.pathname === '/container/app/login/casLogin') {
        const seconds = Math.floor(Date.now() / 1000);
        return json({
          errorCode: 0,
          result: {
            token: jwt({ iat: seconds, exp: seconds + 3600 }),
            id: 'student',
            role: 'student',
            userInfo: { name: '测试同学' },
            clazzInfo: { id: 'class' },
          },
        });
      }
      if (url.pathname === '/hw/answer/homework/subjects') return zx([{ code: '02', name: '数学' }]);
      if (url.pathname === '/hw/stu/stuHwList') {
        const content = body.params.status === 0 ? homeworks : [];
        return zx({
          page: 1,
          size: 10,
          totalElements: content.length,
          totalPages: content.length ? 1 : 0,
          content,
        });
      }
      if (url.pathname === '/hw/answer/homework/detail')
        return zx(homeworks.find((h) => h.hwId === body.params.hwId));
      if (url.pathname === '/hw/answer/stuhomework/get')
        return zx({ id: 'student-' + body.params.hwId, hwId: body.params.hwId, commit: false });
      if (url.pathname === '/hw/homework/attachment/list')
        return zx([
          {
            id: body.params.hwId + '-docx',
            name: '共享数学讲义.docx',
            path: 'https://cdn.example/lesson.docx',
            size: files.get('docx').bytes.length,
            md5: files.get('docx').md5,
          },
        ]);
      if (url.pathname.endsWith('/taskSubjectList'))
        return cy({ data: [{ subjectCode: '02', subjectName: '数学' }] });
      if (url.pathname.endsWith('/taskListOrderByState')) {
        const data = url.searchParams.get('learnState') === '0' ? materials : [];
        return cy({ total: data.length, data });
      }
      if (url.pathname.endsWith('/learnTaskByResId'))
        return cy({ data: materials.filter((m) => m.resourceId === url.searchParams.get('resourceId')) });
      if (url.pathname.endsWith('/getDownloadUrl'))
        return cy({ fileUrl: 'https://cdn.example/lesson.' + url.searchParams.get('resId') });
      if (url.pathname.endsWith('/school/md5'))
        return cy([
          { resId: url.searchParams.get('resId'), md5: files.get(url.searchParams.get('resId')).md5 },
        ]);
      if (url.pathname === '/api/v3/server_system/system/code') {
        const clientSessionId = url.searchParams.get('clientSessionId');
        assert(clientSessionId);
        assert.equal(req.headers.clientsession, clientSessionId);
        assert.equal(
          url.searchParams.get('encrypt'),
          md5('front' + clientSessionId + url.searchParams.get('t')),
        );
        sessions.set(clientSessionId, (sessions.get(clientSessionId) ?? 0) + 1);
        return cy(safeCode);
      }
      if (url.pathname.startsWith('/api/v3/')) {
        const clientSessionId = req.headers.clientsession;
        if (!sessions.has(clientSessionId)) return json({ code: 410, msg: '签名会话不存在' });
        assert.equal(
          req.headers.encrypt,
          md5('learning-safe-code' + req.headers.t + clientSessionId + 'front'),
        );
        assert.equal(req.headers.device, 'mobile');
        assert.equal(req.headers.devicetype, 'Other');
        if (url.pathname === '/api/v3/server_system/auth/login') {
          const token = jwt({
            sid: clientSessionId,
            sub: JSON.stringify({
              id: 'account',
              name: '测试账户',
              school: { schoolId: 'school' },
            }),
          });
          tokens.set(token, clientSessionId);
          return cy({ token });
        }
        const boundSession = tokens.get(req.headers.authorization?.replace(/^JBY /, ''));
        if (
          !boundSession ||
          boundSession !== clientSessionId ||
          req.headers.accesstoken !== 'learning-access'
        ) {
          events.push({ type: 'binding-rejected' });
          return json({ code: 416, msg: '登录会话不匹配' });
        }
      }
      if (url.pathname === '/api/v3/server_system/audit/cfg/query')
        return cy({
          unints: [
            {
              auditGroups: [
                { phaseId: '10000', phaseName: '高中', courseId: '02', course: '数学' },
                { phaseId: '10000', phaseName: '高中', courseId: '03', course: '英语' },
              ],
            },
          ],
        });
      if (url.pathname.endsWith('/type/management/list/byScene'))
        return cy([
          {
            questionsTypeList: [
              { id: 'choice', name: '选择题', children: [] },
              { id: 'calculation', name: '计算题', children: [] },
            ],
          },
        ]);
      if (url.pathname.endsWith('/textbook/type/list')) return cy([{ key: 'edition' }]);
      if (url.pathname.endsWith('/textbook/list'))
        return cy([{ id: 'book', textBookName: '数学必修第一册', typeName: '人教版' }]);
      if (url.pathname.endsWith('/catalogNew/list'))
        return cy([
          {
            key: 'chapter',
            value: '第一章 集合',
            dimensionId: 'dimension',
            labelId: 'tag',
            labelStatus: 1,
            children: [],
          },
        ]);
      if (url.pathname.endsWith('/esDetail'))
        return cy({
          current: body.current,
          size: body.size,
          total: questions.length,
          realTotal: questions.length + 2,
          pages: 1,
          records: questions,
        });
      if (url.pathname.endsWith('.svg'))
        return res
          .writeHead(200, { 'Content-Type': 'image/svg+xml' })
          .end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="32"><text x="4" y="24">x = 2</text></svg>',
          );
      const ext = url.pathname.split('.').pop();
      if (files.has(ext))
        return res
          .writeHead(200, { 'Content-Type': types[ext], 'Content-Length': files.get(ext).bytes.length })
          .end(files.get(ext).bytes);
      throw Error('Unhandled provider path: ' + url.pathname);
    } catch (error) {
      events.push({ type: 'failure', message: String(error), path: req.url });
      res.writeHead(500).end(String(error));
    }
  }
  const http = createServer(handler);
  await new Promise((done) => http.listen(Number(process.env.FILES_PORT ?? 34200) + 6, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + http.address().port;
  const keyPath = join(run, 'provider.key');
  const certPath = join(run, 'provider.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=www.xinjiaoyu.com',
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const pin = createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const tls = createTlsServer({ key, cert }, handler);
  await new Promise((done) => tls.listen(Number(process.env.FILES_PORT ?? 34200) + 7, '127.0.0.1', done));
  const bin = join(run, 'browser-launcher');
  await mkdir(bin);
  for (const name of await readdir(resolve(browser, '..')))
    if (name.endsWith('.dll')) await link(join(resolve(browser, '..'), name), join(bin, name));
  const launcher = join(bin, 'learning-browser.exe');
  const setup = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\VsDevCmd.bat';
  const script = join(run, 'compile-launcher.cmd');
  await writeFile(
    script,
    `@echo off\r\ncall "${setup}" -arch=x64 -host_arch=x64 >nul\r\ncl /nologo /std:c++20 /EHsc /O2 "${join(root, 'tests/e2e/files-learning-browser-launcher.cpp')}" /Fo"${join(bin, 'launcher.obj')}" /Fe"${launcher}"\r\n`,
  );
  execFileSync('cmd.exe', ['/d', '/c', script], { windowsHide: true, stdio: 'pipe' });
  return {
    origin,
    requests,
    events,
    sessions,
    launcher,
    env: {
      NODE_ENV: 'test',
      REMOTEKIT_TEST_BROWSER: resolve(browser),
      REMOTEKIT_TEST_LEARNING_PORT: String(tls.address().port),
      REMOTEKIT_TEST_LEARNING_CERT_PIN: pin,
      REMOTEKIT_TEST_LEARNING_ENDPOINTS: JSON.stringify(
        Object.fromEntries(
          [
            'https://open.changyan.com',
            'https://xktptapi.changyan.com',
            'https://www.zhixue.com',
            'https://mhw.zhixue.com',
            'https://www.xinjiaoyu.com',
            'https://cdn.example',
          ].map((url) => [url, origin]),
        ),
      ),
    },
    async close() {
      http.closeAllConnections();
      tls.closeAllConnections();
      await Promise.all([new Promise((done) => http.close(done)), new Promise((done) => tls.close(done))]);
      await writeFile(join(run, 'provider-requests.json'), JSON.stringify(requests, null, 2));
      await writeFile(join(run, 'provider-events.json'), JSON.stringify(events, null, 2));
    },
  };
}
