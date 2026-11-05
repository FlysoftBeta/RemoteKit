// Contract fixture only. It is never selected by the production launcher.
import { createInterface } from 'node:readline';
const views = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const tenant = views.get(request.tenantId) ?? new Set();
  views.set(request.tenantId, tenant);
  let result = {};
  if (request.method === 'session.snapshot') result = { views: [...tenant].map((viewId) => ({ viewId })) };
  if (request.method === 'view.ensure') tenant.add(request.viewId);
  if (request.method === 'view.close') {
    tenant.delete(request.viewId);
    result = { closed: true };
  }
  if (request.method === 'test.exit') {
    process.exit(3);
  }
  if (request.method === 'test.loopbackEnv')
    result = { loopback: process.env.REMOTEKIT_RTC_LOOPBACK_TEST ?? null };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
  if (request.method === 'shutdown') process.exit(0);
});
