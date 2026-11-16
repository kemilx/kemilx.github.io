import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';

// Real-browser regressions, using the installed Edge and Node built-ins only.
test('portfolio browser acceptance', { timeout: 60000 }, async (t) => {
  const root = new URL('../', import.meta.url);
  const scratch = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'portfolio-browser-'));
  const allowed = new Set(['index.html', 'styles.css', 'script.js', 'favicon.svg', 'K_Martinez_CV.pdf']);
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html';
    if (!allowed.has(name)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(new URL(name, root));
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'Content-Type': types[extname(name)] }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const edge = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'profile')}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge DevTools startup timed out')), 15000);
      let stderr = '';
      edge.on('error', (error) => { clearTimeout(timer); reject(error); });
      edge.stderr.on('data', (data) => {
        stderr += data;
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timed out`)); }, 10000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Page.enable');
    await cdp('Network.enable');
    await cdp('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const load = async (width = 1440, disabled = false) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cdp('Emulation.setScriptExecutionDisabled', { value: disabled });
      await cdp('Page.navigate', { url: `${url}/?case=${width}-${disabled}-${Date.now()}` });
      for (let n = 0; n < 100; n++) {
        if (await evaluate('document.readyState === "complete" && !!document.querySelector("#contacto")')) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Page did not finish loading');
    };
    await load();
    await t.test('hero_identity_visible', async () => {
      const identity = await evaluate('({ name: document.querySelector("h1").textContent, role: document.querySelector(".hero-role")?.textContent })');
      assert.match(identity.name, /Kemil Martínez/);
      assert.match(identity.role || '', /Backend Developer/);
    });
    await t.test('cv_downloads_available', async () => {
      const links = await evaluate('[...document.querySelectorAll("a[download]")].map(a => ({ href: a.href, hero: !!a.closest(".hero"), contact: !!a.closest(".contact") }))');
      assert.ok(links.some((a) => a.hero), 'CV must be reachable from the hero');
      assert.ok(links.some((a) => a.contact), 'CV must remain reachable from contact');
      for (const link of links) {
        const response = await fetch(link.href);
        assert.equal(response.status, 200);
        assert.equal((await response.text()).slice(0, 5), '%PDF-');
      }
    });
    await t.test('responsive_cards_no_overlap', async () => {
      for (const width of [320, 375, 680, 768, 1024, 1440]) {
        await load(width);
        const layout = await evaluate(`(() => {
          const cards = [...document.querySelectorAll('.system-card')].map(e => e.getBoundingClientRect());
          const overlap = cards.some((a,i) => cards.slice(i+1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
          return { overflow: document.documentElement.scrollWidth > innerWidth, overlap };
        })()`);
        assert.equal(layout.overflow, false, `horizontal overflow at ${width}px`);
        assert.equal(layout.overlap, false, `system cards overlap at ${width}px`);
      }
    });
    await t.test('mobile_menu_navigation', async () => {
      await load(375);
      const open = await evaluate(`(() => { document.querySelector('.menu-button').click(); return { expanded: document.querySelector('.menu-button').getAttribute('aria-expanded'), visible: getComputedStyle(document.querySelector('nav')).display !== 'none' }; })()`);
      assert.deepEqual(open, { expanded: 'true', visible: true });
      const closed = await evaluate(`(() => { document.querySelector('nav a').click(); return { expanded: document.querySelector('.menu-button').getAttribute('aria-expanded'), visible: getComputedStyle(document.querySelector('nav')).display !== 'none' }; })()`);
      assert.deepEqual(closed, { expanded: 'false', visible: false });
    });
    await t.test('no_js_content_navigation', async () => {
      await load(375, true);
      const state = await evaluate(`({
        hidden: [...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity === '0' || getComputedStyle(e).visibility === 'hidden').length,
        navVisible: getComputedStyle(document.querySelector('nav')).display !== 'none'
      })`);
      assert.equal(state.hidden, 0, 'content must not depend on scroll JavaScript');
      assert.equal(state.navVisible, true, 'navigation must work without JavaScript');
    });
    await cdp('Emulation.setScriptExecutionDisabled', { value: false });
    for (const width of [375, 1440]) {
      await load(width);
      const screenshot = await cdp('Page.captureScreenshot', { captureBeyondViewport: false });
      const path = join(scratch, `portfolio-${width}.png`);
      await writeFile(path, Buffer.from(screenshot.data, 'base64'));
      console.log(`SCREENSHOT ${path}`);
      for (const section of ['proyectos', 'stack', 'contacto']) {
        await evaluate(`document.getElementById('${section}').scrollIntoView({ behavior: 'instant' })`);
        const sectionShot = await cdp('Page.captureScreenshot', { captureBeyondViewport: false });
        await writeFile(join(scratch, `portfolio-${width}-${section}.png`), Buffer.from(sectionShot.data, 'base64'));
      }
    }
    console.log(`ARTIFACTS ${scratch}`);
  } finally {
    socket?.close();
    edge.kill();
    await new Promise((resolve) => server.close(resolve));
    // Keep screenshots for inspection; remove only this run's disposable browser profile.
    await new Promise((resolve) => edge.exitCode !== null ? resolve() : edge.once('exit', resolve));
    await rm(join(scratch, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
});
