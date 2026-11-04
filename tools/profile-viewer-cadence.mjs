/**
 * Isolated blank-page RAF before/during/after GPU/Viz trace (4 seconds each).
 * node tools/profile-viewer-cadence.mjs <playwright index.js> <viewer.exe> <new output directory>
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile, open} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [playwright, viewer, output] = process.argv.slice(2);
assert(playwright && viewer && output, 'Expected Playwright, Viewer and new output directory');
const {chromium} = createRequire(import.meta.url)(resolve(playwright));
const run = resolve(output);
await mkdir(run);
const context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
  executablePath:resolve(viewer), headless:true, viewport:{width:1920, height:888}, deviceScaleFactor:1,
  args:['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const session = await context.browser().newBrowserCDPSession();
  const version = await session.send('Browser.getVersion');
  const command = await session.send('Browser.getBrowserCommandLine').catch(error => ({unavailable:String(error)}));
  const system = await session.send('SystemInfo.getInfo');
  const processes = await session.send('SystemInfo.getProcessInfo');
  let processCommands;
  if (process.platform === 'win32') {
    const ids = processes.processInfo.map(row => row.id).filter(Number.isSafeInteger);
    const query = 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(' + ids.join(',') +
      ') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 4';
    const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile','-Command',query], {windowsHide:true,maxBuffer:1024*1024});
    processCommands = JSON.parse(stdout);
  }
  await page.goto('data:text/html,<!doctype html><title>RAF calibration</title><body>Isolated RAF calibration</body>');
  const measure = () => page.evaluate(async () => {
    const times = [], longTasks = [];
    const started = performance.now();
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= started)
        longTasks.push({start:entry.startTime, duration:entry.duration});
    });
    observer.observe({type:'longtask', buffered:true});
    await new Promise(resolve => {
      function next(time) {
        times.push(time);
        if (time - started >= 4000) resolve();
        else requestAnimationFrame(next);
      }
      requestAnimationFrame(next);
    });
    observer.disconnect();
    const intervals = times.slice(1).map((time,index) => time-times[index]);
    const sorted = [...intervals].sort((a,b) => a-b);
    return {times, intervals, longTasks, visibility:document.visibilityState,
      meanFps:(times.length-1)*1000/(times.at(-1)-times[0]),
      medianIntervalMs:sorted[Math.floor(sorted.length/2)],
      p95IntervalMs:sorted[Math.ceil(sorted.length*.95)-1],
      screen:{width:screen.width,height:screen.height}, timeOrigin:performance.timeOrigin};
  });
  const before = await measure();
  const completed = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
  await session.send('Tracing.start', {categories:'benchmark,gpu,viz,toplevel,disabled-by-default-gpu.service', transferMode:'ReturnAsStream'});
  const measurement = await measure();
  await session.send('Tracing.end');
  const {stream} = await completed;
  const trace = await open(join(run, 'trace.json'), 'wx');
  try {
    for (;;) {
      const chunk = await session.send('IO.read', {handle:stream});
      await trace.write(chunk.base64Encoded ? Buffer.from(chunk.data,'base64') : chunk.data);
      if(chunk.eof)break;
    }
  } finally {await trace.close();await session.send('IO.close',{handle:stream});}
  const after = await measure();
  const summary = value => ({meanFps:value.meanFps,medianIntervalMs:value.medianIntervalMs,
    p95IntervalMs:value.p95IntervalMs,callbacks:value.times.length,longTasks:value.longTasks.length});
  await writeFile(join(run,'measurement.json'),JSON.stringify({version,command,system,processes,processCommands,before,measurement,after},null,2));
  console.log(JSON.stringify({before:summary(before),during:summary(measurement),after:summary(after),
    processes:processes.processInfo.map(row=>({type:row.type,id:row.id})),trace:join(run,'trace.json')},null,2));
} finally {await context.close();}
