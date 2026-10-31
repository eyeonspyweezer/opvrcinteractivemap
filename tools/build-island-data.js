// Runs in GitHub Actions. Opens your real debug page in a headless browser, lets it load the
// Google Sheets, then saves island-colors.tsv and island-flags.png in the repo root.
const { chromium } = require('playwright');
const sharp = require('sharp');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PAGE = process.env.PAGE_PATH || 'debugging/index.html';
const CELL = 128, COLS = 16, SIZE = CELL * COLS; // flag atlas: 2048 x 2048, 16 x 16 cells of 128 px

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.tsv': 'text/tab-separated-values', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'Content-Type': TYPES[ext] || (ext === '.png' ? 'image/png' : 'application/octet-stream') });
  fs.createReadStream(p).pipe(res);
});

const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => console.log('page error:', e.message));
    await page.goto(`${base}/${PAGE}`, { waitUntil: 'load' });

    // wait until the polygons, owners and crew colors have loaded
    await page.waitForFunction(() => {
      try { return drawnItems.getLayers().length > 0 && ownerMap.size > 0 && nationColor.size > 0; }
      catch (e) { return false; }
    }, null, { timeout: 120000 });
    await page.waitForTimeout(10000); // let the 3rd sheet (links) finish too

    const rows = await page.evaluate(() => polygonList().map(({ id, layer, name }) => {
      const p = layer.feature.properties;
      const owner = resolveOwner(p);
      const colors = groupColorsOf(owner);
      const cols = colors.length ? colors : [ownerMap.has(islandKey(p.name)) ? SHEET_NO_OWNER_COLOR : NO_OWNER_COLOR];
      const w = worldOf(p.name);
      const links = [...new Set([...linksOf(p.name), ...(w && w.link ? [w.link] : [])])];
      let flag = '';
      for (const raw of ownersOf(owner)) {
        for (const n of groupsOf(raw)) { const f = flagFor(n); if (f) { flag = f; break; } }
        if (flag) break;
      }
      return {
        id, name,
        color: cols.map(hexOf).join(' '),
        owner: String(owner || ''),
        link: links.join(' '),
        flag: flag ? new URL(flag, location.href).href : ''
      };
    }));
    if (!rows.length) throw new Error('No polygons found - not saving anything.');

    // flag atlas: one cell per unique flag, sorted by link so cells stay stable
    const urls = [...new Set(rows.map((r) => r.flag).filter(Boolean))].sort();
    if (urls.length > COLS * COLS) throw new Error('More than 256 flags.');
    const cellOf = new Map(urls.map((u, i) => [u, i]));
    const parts = [];
    for (const [i, u] of urls.entries()) {
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const img = await sharp(Buffer.from(await res.arrayBuffer()))
          .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png().toBuffer();
        parts.push({ input: img, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL });
      } catch (e) { console.log('flag failed:', u, e.message); cellOf.delete(u); }
    }
    let atlas = sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    if (parts.length) atlas = atlas.composite(parts);
    await atlas.png().toFile('island-flags.png');

    const lines = ['ID\tIsland Name\tColor\tOwner\tLink\tFlag', ...rows.map((r) =>
      [r.id, clean(r.name), r.color, clean(r.owner), clean(r.link), cellOf.has(r.flag) ? cellOf.get(r.flag) : -1].join('\t'))];
    fs.writeFileSync('island-colors.tsv', lines.join('\n') + '\n');
    console.log(`Saved ${rows.length} islands and ${parts.length} flags.`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
