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
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('page ' + m.type() + ':', m.text()); });
    page.on('requestfailed', (r) => console.log('request failed:', r.url(), r.failure() && r.failure().errorText));
    page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
    const resp = await page.goto(`${base}/${PAGE}`, { waitUntil: 'load' });
    console.log('Page status:', resp && resp.status(), '-', PAGE);
    if (!resp || resp.status() !== 200) throw new Error('Page not found at "' + PAGE + '". Fix PAGE_PATH in the workflow file.');

    // wait until the polygons and owners have loaded
    try {
      await page.waitForFunction(() => {
        try { return drawnItems.getLayers().length > 0 && ownerMap.size > 0; }
        catch (e) { return false; }
      }, null, { timeout: 90000 });
    } catch (e) {
      const state = await page.evaluate(() => {
        const g = (f) => { try { return f(); } catch (err) { return 'n/a'; } };
        return {
          islandsOnMap: g(() => drawnItems.getLayers().length),
          ownerRows: g(() => ownerMap.size),
          crewColors: g(() => nationColor.size),
          status: g(() => document.getElementById('status').textContent),
          islandFileError: g(() => !document.getElementById('loadError').hidden)
        };
      });
      console.log('State at timeout:', JSON.stringify(state));
      throw e;
    }
    await page.waitForTimeout(15000); // let the crew sheet (colors/flags) and 3rd sheet (links) finish
    console.log('Crew colors loaded:', await page.evaluate(() => nationColor.size));

    const rows = await page.evaluate(async () => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const q = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
      return polygonList().map(({ id, layer, name }) => {
        const p = layer.feature.properties;
        const owner = resolveOwner(p);
        const colors = groupColorsOf(owner);
        const cols = colors.length ? colors : [ownerMap.has(islandKey(p.name)) ? SHEET_NO_OWNER_COLOR : NO_OWNER_COLOR];
        const w = worldOf(p.name);
        const links = [...new Set([...linksOf(p.name), ...(w && w.link ? [w.link] : [])])];
        // same flag choice as the page: Marines first, and stripes (several crews) win over a flag
        let flag = '';
        if (cols.length < 2) {
          const url = preferMarines(ownersOf(owner).flatMap(groupsOf)).map(flagFor).find(Boolean);
          if (url) flag = new URL(url, location.href).href;
        }
        // bounding box of the island, as 0..65535 of the map size (u/v, v counted from the bottom)
        const g = layer.toGeoJSON().geometry;
        const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
        let x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
        polys.forEach((rings) => {
          const off = Math.floor(rings[0][0][0] / W) * W;
          rings.forEach((ring) => ring.forEach((pt) => {
            const x = pt[0] - off, y = pt[1];
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }));
        });
        return {
          id, name,
          color: cols.map(hexOf).join(' '),
          owner: String(owner || ''),
          link: links.join(' '),
          flag,
          unowned: ownersOf(owner).length ? 0 : 1,
          unknown: String(p.name || '').includes('???') ? 1 : 0,
          groups: preferMarines(ownersOf(owner).flatMap(groupsOf)).map((g) => ({ name: g, color: hexOf(GROUP_COLORS[norm(g)] || DEFAULT_GROUP_COLOR) })),
          box: [q(x0 / W), q(y0 / H), q((x1 - x0) / W), q((y1 - y0) / H)]
        };
      });
    });
    if (!rows.length) throw new Error('No polygons found - not saving anything.');

    // flag atlas: one cell per unique flag, sorted by link so cells stay stable
    const urls = [...new Set(rows.map((r) => r.flag).filter(Boolean))].sort();
    if (urls.length > COLS * COLS) throw new Error('More than 256 flags.');
    const cellOf = new Map(urls.map((u, i) => [u, i]));
    const parts = [];
    const aspectOf = new Map(); // flag link -> width/height * 50 (1..255)
    for (const [i, u] of urls.entries()) {
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(buf).metadata();
        aspectOf.set(u, Math.max(1, Math.min(255, Math.round((meta.width / meta.height) * 50))));
        const img = await sharp(buf).resize(CELL, CELL, { fit: 'fill' }).png().toBuffer();
        parts.push({ input: img, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL });
      } catch (e) { console.log('flag failed:', u, e.message); cellOf.delete(u); }
    }
    let atlas = sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    if (parts.length) atlas = atlas.composite(parts);
    await atlas.png().toFile('island-flags.png');

    // groups: owning groups first (most islands first), groups with no islands last
    const extra = await page.evaluate(() => {
      const m = new Map();
      leaderMap.forEach((crews) => crews.forEach((n) => m.set(n.toLowerCase(), n)));
      return [...m.values()].map((n) => ({ name: n, color: hexOf(GROUP_COLORS[norm(n)] || DEFAULT_GROUP_COLOR) }));
    });
    const groupMap = new Map();
    rows.forEach((r) => {
      const seen = new Set();
      r.groups.forEach((g) => {
        const k = g.name.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        if (!groupMap.has(k)) groupMap.set(k, { name: g.name, color: g.color, count: 0 });
        groupMap.get(k).count++;
      });
    });
    extra.forEach((g) => { const k = g.name.toLowerCase(); if (!groupMap.has(k)) groupMap.set(k, { name: g.name, color: g.color, count: 0 }); });
    const ordered = [...groupMap.values()]
      .sort((a, b) => (b.count > 0) - (a.count > 0) || b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 255);
    const gidOf = new Map(ordered.map((g, i) => [g.name.toLowerCase(), i + 1]));
    fs.writeFileSync('island-groups.tsv', ['ID\tGroup\tColor\tIslands', ...ordered.map((g, i) => [i + 1, clean(g.name), g.color, g.count].join('\t'))].join('\n') + '\n');

    const lines = ['ID\tIsland Name\tColor\tOwner\tLink\tFlag\tBoxX\tBoxY\tBoxW\tBoxH\tFlagAspect\tUnowned\tUnknown\tGroup1\tGroup2\tGroup3', ...rows.map((r) => {
      const ids = [...new Set(r.groups.map((g) => gidOf.get(g.name.toLowerCase()) || 0).filter(Boolean))].slice(0, 3);
      while (ids.length < 3) ids.push(0);
      return [r.id, clean(r.name), r.color, clean(r.owner), clean(r.link), cellOf.has(r.flag) ? cellOf.get(r.flag) : -1, ...r.box,
        cellOf.has(r.flag) ? aspectOf.get(r.flag) : 0, r.unowned, r.unknown, ...ids].join('\t');
    })];
    fs.writeFileSync('island-colors.tsv', lines.join('\n') + '\n');
    console.log(`Saved ${rows.length} islands and ${parts.length} flags.`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
