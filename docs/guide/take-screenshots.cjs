// Retakes the guide's screenshots from a running dev server (npm run dev).
//   node docs/guide/take-screenshots.cjs <main photo> <second photo> <photo with dust spots>
// The first two should be RAW files; the third can be any image with small blemishes.
// Screenshots are written next to this file as PNG; convert them to JPEG afterwards.
const { chromium } = require('playwright');
const [main, second, dusty] = process.argv.slice(2);
const OUT = __dirname + '/';
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://localhost:5173/');
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + 'start.png' });
  await p.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'tmp'; i.style.display = 'none'; document.body.append(i); });
  await p.setInputFiles('#tmp', [second, main]);
  // Shown in the strip under camera-style names.
  await p.evaluate(async () => { const f = [...document.getElementById('tmp').files]; await window.rawlab.browser.show([{ name: 'DSC_0398.NEF', getFile: async () => f[0] }, { name: 'DSC_0412.NEF', getFile: async () => f[1] }], 'DCIM'); });
  await p.waitForFunction(() => document.querySelectorAll('#strip canvas').length >= 2, null, { timeout: 120000 });
  await p.locator('#strip li button').first().click();
  await p.waitForFunction(() => window.rawlab.state.source && document.getElementById('busy').hidden, null, { timeout: 180000 });
  await p.waitForTimeout(1200);
  const quiet = async () => { await p.evaluate(() => { document.getElementById('toast').hidden = true; document.getElementById('fileName').textContent = 'DSC_0412.NEF  ·  6192 × 4128'; }); await p.waitForTimeout(500); };
  const setSlider = async (label, v, nth = 0) => { await p.locator('input[type=range][aria-label="' + label + '"]').nth(nth).evaluate((n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, v); };
  await p.keyboard.press('3'); await quiet();
  await p.screenshot({ path: OUT + 'main.png' });
  await setSlider('Highlights', -45); await setSlider('Shadows', 35); await setSlider('Vibrance', 20); await quiet();
  await p.screenshot({ path: OUT + 'basic.png', clip: { x: 1140, y: 44, width: 300, height: 640 } });
  // preset with its strength slider
  await p.getByText('Warm evening').click(); await quiet();
  await p.screenshot({ path: OUT + 'preset.png', clip: { x: 0, y: 44, width: 220, height: 330 } });
  await p.keyboard.press('Control+z'); await quiet();
  // crop
  await p.keyboard.press('r'); await setSlider('Angle', 3); await quiet();
  await p.screenshot({ path: OUT + 'crop.png', clip: { x: 220, y: 44, width: 920, height: 658 } });
  await p.evaluate(() => { document.querySelector('#cropbar button:nth-last-child(2)').click(); }); await p.keyboard.press('Enter'); await quiet();
  // local adjustment: a radial over the bridge
  await p.getByText('+ Radial').click(); await quiet();
  const box = await p.locator('#overlay').boundingBox();
  const cx = box.x + box.width * 0.36, cy = box.y + box.height * 0.6;
  await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx + 110, cy + 60, { steps: 6 }); await p.mouse.up();
  await setSlider('Exposure', 0.9, 1); await setSlider('Saturation', 30, 1); await quiet();
  await p.screenshot({ path: OUT + 'local.png', clip: { x: 220, y: 44, width: 920, height: 658 } });
  await p.keyboard.press('Escape');
  // heal
  await p.keyboard.press('h'); await quiet();
  await p.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.52); await p.waitForTimeout(300);
  await p.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3); await quiet();
  await p.screenshot({ path: OUT + 'heal.png', clip: { x: 220, y: 44, width: 920, height: 658 } });
  await p.keyboard.press('Escape');
  // compare
  await p.keyboard.press('y'); await quiet();
  await p.screenshot({ path: OUT + 'compare.png', clip: { x: 220, y: 0, width: 920, height: 702 } });
  await p.keyboard.press('y');
  // export
  await p.click('#btnExport'); await p.waitForFunction(() => !document.getElementById('exGo').disabled, null, { timeout: 180000 });
  await p.evaluate(() => { document.getElementById('exName').value = 'DSC_0412'; }); await p.waitForTimeout(300);
  const d = await p.locator('#exportDlg').boundingBox();
  await p.screenshot({ path: OUT + 'export.png', clip: { x: d.x - 8, y: d.y - 8, width: d.width + 16, height: d.height + 16 } });
  await p.keyboard.press('Escape');
  // show spots, on the photo with blemishes
  if (dusty) {
    await p.setInputFiles('#fileInput', dusty);
    const n = dusty.split('/').pop();
    await p.waitForFunction((n) => window.rawlab.state.source?.name === n && document.getElementById('busy').hidden, n, { timeout: 120000 });
    await p.evaluate(() => { document.getElementById('strip').hidden = true; });
    await p.keyboard.press('h'); await p.keyboard.press('s'); await quiet();
    await p.mouse.move(600, 300); await p.waitForTimeout(300);
    await p.screenshot({ path: OUT + 'spots.png', clip: { x: 220, y: 44, width: 920, height: 816 } });
  }
  await b.close();
})();
