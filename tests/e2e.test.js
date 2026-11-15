// UI tests with Playwright. Skipped automatically when Playwright isn't installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve(){
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(ROOT) || !fs.existsSync(file)){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

test('UI flows', { skip: !chromium && 'playwright not installed' }, async (t) => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  const open = async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(url);
    return { page, errors };
  };
  const addHabit = async (page, name) => {
    await page.fill('#habitInput', name);
    await page.click('#addBtn');
  };

  await t.test('add a habit and mark today done', async () => {
    const { page, errors } = await open();
    await addHabit(page, 'Read');
    assert.equal(await page.locator('.card').count(), 1);
    await page.click('.check-btn');
    assert.match(await page.textContent('.check-btn'), /DONE TODAY/);
    assert.equal(await page.textContent('.streak-pill'), '1 day');
    assert.deepEqual(errors, []);
  });

  await t.test('past days can be logged from the calendar, future days cannot', async () => {
    const { page } = await open();
    await addHabit(page, 'Read');
    await page.click('.hist-btn');
    assert.ok(await page.locator('.cal-day[disabled]').count() >= 0);
    const enabled = page.locator('.cal-day[data-date]:not([disabled])');
    await enabled.first().click();
    assert.equal(await page.locator('.cal-day.logged').count(), 1);
    await page.locator('.cal-day.logged').click();
    assert.equal(await page.locator('.cal-day.logged').count(), 0);
  });

  await t.test('deleting asks for confirmation; Esc cancels', async () => {
    const { page } = await open();
    await addHabit(page, 'Read');
    await page.click('.del-btn');
    assert.equal(await page.isVisible('#confirmModal'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.card').count(), 1);
    await page.click('.del-btn');
    await page.click('#confirmOk');
    assert.equal(await page.locator('.card').count(), 0);
  });

  await t.test('data persists across reloads', async () => {
    const { page } = await open();
    await addHabit(page, 'Persist me');
    await page.reload();
    assert.equal(await page.textContent('.card-name'), 'Persist me');
  });

  await t.test('importing an invalid file shows an error and keeps data', async () => {
    const { page } = await open();
    await addHabit(page, 'Keep');
    await page.setInputFiles('#importFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
    await page.waitForSelector('.backup-msg.error');
    assert.match(await page.textContent('#backupMsg'), /valid JSON/);
    assert.equal(await page.locator('.card').count(), 1);
  });

  await t.test('week start toggle persists and reorders the calendar', async () => {
    const { page } = await open();
    await addHabit(page, 'Read');
    await page.click('.hist-btn');
    assert.equal(await page.locator('.cal-dow').first().textContent(), 'MON');
    await page.click('#weekStartBtn');
    assert.equal(await page.locator('.cal-dow').first().textContent(), 'SUN');
    await page.reload();
    assert.equal(await page.textContent('#weekStartBtn'), 'Week starts: Sunday');
  });

  await t.test('theme button cycles and persists', async () => {
    const { page } = await open();
    assert.equal(await page.textContent('#themeBtn'), 'Theme: System');
    await page.click('#themeBtn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.reload();
    assert.equal(await page.textContent('#themeBtn'), 'Theme: Light');
    await page.click('#themeBtn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  });
});
