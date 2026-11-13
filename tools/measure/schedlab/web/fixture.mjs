const params = new URLSearchParams(location.search);
const tenant = Number(params.get('tenant'));
const kind = params.get('kind');
const epoch = Number(params.get('t0') || 0);
const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/fixture?tenant=${tenant}`);
const now = () => performance.timeOrigin + performance.now();
const pending = [];
function record(value) {
  const data = { ...value, tenant };
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  else pending.push(data);
}
socket.onopen = () => {
  for (const value of pending.splice(0)) socket.send(JSON.stringify(value));
};
async function initialize() {
  if (kind === 'V') {
    const video = document.createElement('video');
    video.src = '/video.mp4';
    video.autoplay = Boolean(epoch);
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    document.body.append(video);
    const offset = Number(params.get('offset'));
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Video metadata failed')), { once: true });
    });
    video.currentTime = offset;
    if (epoch) {
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, epoch - now())));
      video.currentTime = offset + Math.max(0, (now() - epoch) / 1000);
      await video.play();
      record({ type: 'videoStart', epochMs: now(), mediaTime: video.currentTime });
    }
  } else if (kind.startsWith('U')) {
    const rate = Number(kind.slice(1));
    const article = document.createElement('article');
    article.innerHTML = `<p class="eyebrow">River observatory - live field journal</p><h1>A changing landscape</h1><p>Field observations connect the life of a river with the people around it.</p><section id="changing"><img id="landscape"/><h2 id="headline"></h2><p id="detail"></p></section>`;
    document.body.append(article);
    const pictures = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        const picture = new Image();
        picture.src = `/landscape-${i}.png`;
        await picture.decode();
        return picture.src;
      }),
    );
    let update = 0;
    const headlines = [
      'Paths through the landscape',
      'A season of shared discoveries',
      'Building a resilient neighbourhood',
      'What the river teaches us',
    ];
    function change(scheduled) {
      const index = update++ % 4;
      document.querySelector('#landscape').src = pictures[index];
      document.querySelector('#headline').textContent = headlines[index];
      document.querySelector('#detail').textContent =
        `Observation ${update}: ${['The water reflects the warm light of the market, where residents gather beneath the trees.', 'Along the shaded path, researchers compare the spring vegetation with last seasonal survey.', 'New bridges connect the riverbank gardens with homes and a busy neighbourhood square.', 'A quiet stretch of marsh supports migrating birds and helps the city manage heavy rainfall.'][index]}`;
      record({ type: 'contentUpdate', epochMs: now(), scheduled, update, rate });
      setTimeout(() => change(scheduled + 1000 / rate), Math.max(0, scheduled + 1000 / rate - now()));
    }
    if (epoch) setTimeout(() => change(epoch), Math.max(0, epoch - now()));
  } else {
    const article = document.createElement('article');
    const paragraph = `Cities change through the decisions people make every day. A shaded path, a reliable connection and a place to pause can shape an entire neighbourhood. Along the river, researchers have followed these small changes through the seasons, comparing observations with the memories of residents. The results reveal a landscape built by many hands, where practical choices create room for new possibilities.`;
    article.innerHTML = `<p class="eyebrow">Field journal · Design and environment</p><h1>The living river and the city around it</h1><p>How thoughtful places connect daily life, public space and a changing landscape.</p><div class="banner"></div>`;
    for (let section = 0; section < 16; section++) {
      article.insertAdjacentHTML(
        'beforeend',
        `<h2>${section + 1}. ${['Paths through the landscape', 'A season of shared discoveries', 'Building a resilient neighbourhood', 'What the river teaches us'][section % 4]}</h2><p>${paragraph}</p><img src="/landscape-${section % 4}.png" alt="Illustrated river landscape"/><p>${paragraph}</p><p>${paragraph}</p>`,
      );
      if (section % 3 === 0) {
        article.insertAdjacentHTML(
          'beforeend',
          `<table><thead><tr><th>District</th><th>Green space</th><th>Daily journeys</th><th>Year</th></tr></thead><tbody>${['Riverside', 'Westbank', 'Old Market', 'Woodlands'].map((name, i) => `<tr><td>${name}</td><td>${18 + i * 7}%</td><td>${1400 + i * 850}</td><td>202${i + 2}</td></tr>`).join('')}</tbody></table>`,
        );
      }
    }
    document.body.append(article);
    let motion = null;
    let direction = 1;
    let previousY = scrollY;
    let quiet = 0;
    function finish() {
      if (!motion) return;
      record({ type: 'scrollEnd', command: motion.command, start: motion.start, end: now(), scrollY });
      motion = null;
    }
    addEventListener('scrollend', finish);
    function observe() {
      if (!motion) return;
      quiet = Math.abs(scrollY - previousY) < 0.1 ? quiet + 1 : 0;
      previousY = scrollY;
      if (quiet >= 6 && now() - motion.start > 150) finish();
      else requestAnimationFrame(observe);
    }
    let command = 0;
    const period = Number(kind.slice(1)) * 1000;
    const phase = Number(params.get('phase')) * 1000;
    function scroll(next) {
      if (scrollY >= document.documentElement.scrollHeight - innerHeight - 1000) direction = -1;
      else if (scrollY < 100) direction = 1;
      finish();
      motion = { command: ++command, start: now() };
      quiet = 0;
      record({ type: 'scrollStart', ...motion, scheduled: next, scrollY, delta: direction * 800 });
      scrollBy({ top: direction * 800, behavior: 'smooth' });
      requestAnimationFrame(observe);
      setTimeout(() => scroll(next + period), Math.max(0, next + period - now()));
    }
    if (epoch && kind !== 'static') {
      const first = epoch + phase + Math.max(0, Math.ceil((now() - epoch - phase) / period)) * period;
      setTimeout(() => scroll(first), Math.max(0, first - now()));
    }
  }
}
initialize().then(
  () => record({ type: 'fixtureReady', epochMs: now(), t0: epoch, kind }),
  (error) => record({ type: 'fixtureError', message: String(error) }),
);
