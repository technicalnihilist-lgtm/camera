#!/usr/bin/env node
/*
 * Regression check for Liquid Glass Camera.
 *
 *   node tests/regress.js [path-to-index.html]
 *
 * Drives the real page in headless Chromium with a fake camera and asserts the
 * behaviour that must not break. Exits 1 on any failure. Safe to run in the
 * sandbox: needs only node + puppeteer-core + /usr/local/bin/chromium.
 */
const path = require('path');
function loadPuppeteer() {
  const tries = ['puppeteer-core', '/usr/lib/node_modules/puppeteer-core',
    '/usr/local/lib/node_modules/puppeteer-core',
    (process.env.HOME || '') + '/.npm-global/lib/node_modules/puppeteer-core'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('puppeteer-core not installed');
}
const puppeteer = loadPuppeteer();

const TARGET = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + path.resolve(TARGET);
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const wait = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  ' + detail : ''));
  if (!ok) failures++;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 840 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  await page.evaluateOnNewDocument(() => {
    addEventListener('unhandledrejection', e =>
      console.error('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
  });

  await page.goto(URL, { waitUntil: 'load' });
  await wait(2500);

  const state = () => page.evaluate(() => {
    const q = s => document.querySelector(s);
    return {
      gate: q('#gate').hidden,
      vw: q('#v').videoWidth,
      vh: q('#v').videoHeight,
      thumb: !!q('#thumb img'),
      sheetHidden: q('#sheet').hidden,
      hasSections: [...document.querySelectorAll('#sheet .sec')].map(e => e.textContent.trim()),
      depth: q('#app').classList.contains('depth'),
      par: q('#app').classList.contains('par'),
      hasDepthCtl: !!(q('#sheet #eDepth') && q('#sheet #rD') && q('#sheet #rP')),
      depthInEngine: !!q('#eng #eDepth'),
    };
  });

  const s0 = await state();
  check('camera starts', s0.gate === true && s0.vw > 0, s0.vw + 'x' + s0.vh);
  check('settings sheet closed at boot', s0.sheetHidden === true);
  check('depth + 4D on by default', s0.depth && s0.par);
  check('depth controls live in settings', s0.hasDepthCtl === true);
  check('capture engine has no depth controls', s0.depthInEngine === false);

  // use the small stream so the suite stays quick on a 2-core pod
  await page.click('#bE'); await wait(900);
  await page.click('#qseg button[data-q="std"]'); await wait(2200);
  await page.click('#edone'); await wait(1400);

  // photo capture, framing must match the preview aspect
  await page.click('#shut');
  for (let i = 0; i < 40 && !(await page.evaluate(() => !!document.querySelector('#thumb img'))); i++) await wait(500);
  const shot = await page.evaluate(() => new Promise(res => {
    const img = document.querySelector('#thumb img');
    if (!img) return res(null);
    const done = () => {
      const st = document.querySelector('#stage').getBoundingClientRect();
      res({ w: img.naturalWidth, h: img.naturalHeight, aspect: st.width / st.height });
    };
    img.complete ? done() : (img.onload = done, setTimeout(() => res(null), 4000));
  }));
  check('photo captured', !!shot, shot ? shot.w + 'x' + shot.h : 'no image');
  if (shot) {
    const got = shot.w / shot.h;
    check('photo framing matches preview', Math.abs(got - shot.aspect) < 0.03,
      'got ' + got.toFixed(3) + ' want ' + shot.aspect.toFixed(3));
  }

  // settings sheet
  await page.click('#bS');
  await wait(900);
  const s1 = await state();
  check('settings sheet opens', s1.sheetHidden === false);
  check('settings has both sections',
    s1.hasSections.length === 2 && /glass/i.test(s1.hasSections[0]) && /4d/i.test(s1.hasSections[1]),
    JSON.stringify(s1.hasSections));

  // 4D parallax responds to pointer movement
  await page.mouse.move(60, 300); await wait(80); await page.mouse.move(340, 700);
  await wait(500);
  const parMove = await page.evaluate(() => document.querySelector('.top').style.translate || '');
  check('4D parallax moves layers', /\d/.test(parMove) && parMove !== '0px 0px', parMove);

  // toggles
  await page.click('#eDepth'); await wait(250);
  const off = await state();
  check('depth toggle turns effect off', off.depth === false);
  await page.click('#eDepth'); await wait(250);
  const on = await state();
  check('depth toggle turns effect back on', on.depth === true);

  await page.click('#sdone'); await wait(1400);
  const closed = await state();
  check('settings sheet closes', closed.sheetHidden === true);

  // video recording
  await page.click('.modes button[data-m="video"]'); await wait(400);
  await page.click('#shut'); await wait(2500);
  const rec = await page.evaluate(() => document.querySelector('#app').classList.contains('rec'));
  check('recording starts', rec === true);
  await page.click('#shut'); await wait(2200);
  await page.click('#thumb'); await wait(1000);
  const vid = await page.evaluate(() => new Promise(res => {
    const v = document.querySelector('#vm video');
    if (!v) return res(null);
    const done = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
    v.readyState >= 1 ? done() : (v.onloadedmetadata = done, setTimeout(() => res(null), 3000));
  }));
  check('video recorded and playable', !!vid && vid.w > 0 && vid.d > 0,
    vid ? vid.w + 'x' + vid.h + ' ' + vid.d.toFixed(1) + 's' : 'no video');

  // native save through the Android bridge (only wired when window.AndroidCam exists)
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 400, height: 840 });
  p2.on('pageerror', e => errors.push('pageerror(native): ' + e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push('console(native): ' + m.text().slice(0, 160)); });
  await p2.evaluateOnNewDocument(() => {
    const acc = [];
    window.__br = { calls: 0, maxB64: 0, bytes: 0, mime: '', aborted: false };
    window.AndroidCam = {
      open(mime) { window.__br.mime = mime; return 1; },
      write(id, b64) {
        // stand in for the Java-side Base64.decode + FileOutputStream.write: an
        // @JavascriptInterface call does not return until that work is done, so
        // the JS thread is blocked for the whole round trip
        const end = performance.now() + b64.length * 3 / 1e6;
        while (performance.now() < end) { /* block */ }
        window.__br.calls++;
        if (b64.length > window.__br.maxB64) window.__br.maxB64 = b64.length;
        const s = atob(b64), u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        acc.push(u); window.__br.bytes += u.length;
        return 'ok';
      },
      close() { window.__br.acc = acc; return 'ok ' + window.__br.bytes; },
      abort() { window.__br.aborted = true; },
    };
    window.__saved = () => {
      const out = new Uint8Array(window.__br.bytes);
      let o = 0;
      for (const u of window.__br.acc) { out.set(u, o); o += u.length; }
      return out;
    };
  });
  await p2.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  // a clip of known size: 8 MB goes through the bridge in many slices however the
  // chunk size is set, and the bytes are known, so the loop is checked end to end
  const CLIP = 8 * 1024 * 1024;
  await p2.evaluate(n => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 997) b[i] = (i * 31) & 255;
    items.push({ t: 'v', u: URL.createObjectURL(new Blob([b], { type: 'video/webm' })), x: 'webm', p: '' });
    vi = items.length - 1;
    window.__st = { max: 0, last: 0, on: true };
    const tick = () => {
      const t = performance.now();
      if (window.__st.last) window.__st.max = Math.max(window.__st.max, t - window.__st.last);
      window.__st.last = t;
      if (window.__st.on) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    document.querySelector('#vs').click();
  }, CLIP);
  let toastTxt = '';
  for (let i = 0; i < 80; i++) {
    await wait(250);
    toastTxt = await p2.evaluate(() => document.querySelector('#toast').textContent);
    if (/Saved to your Gallery|Could not save/.test(toastTxt)) break;
  }
  const save = await p2.evaluate(async () => {
    window.__st.on = false;
    const it = items[items.length - 1];
    const src = new Uint8Array(await (await fetch(it.u)).arrayBuffer());
    const got = window.__saved();
    let same = src.length === got.length;
    if (same) for (let i = 0; i < src.length; i++) if (src[i] !== got[i]) { same = false; break; }
    return { toast: document.querySelector('#toast').textContent, src: src.length, got: got.length,
      same, calls: window.__br.calls, maxB64: window.__br.maxB64,
      stall: +window.__st.max.toFixed(1), aborted: window.__br.aborted };
  });
  check('native save writes the clip byte for byte',
    save.same && save.src === save.got && save.src > 0 && !save.aborted,
    save.src + ' bytes in ' + save.calls + ' calls');
  check('native save hands the bridge small slices', save.maxB64 <= 768 * 1024,
    'largest ' + (save.maxB64 / 1024).toFixed(0) + ' KB base64, longest stall ' + save.stall + ' ms');

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
