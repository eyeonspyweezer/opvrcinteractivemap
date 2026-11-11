// Runs in GitHub Actions. Opens your real debug page in a headless browser, lets it load the
// Google Sheets, then saves these files in the repo:
//   island-colors.tsv  island-groups.tsv  island-flags.png  island-labels.png  island-map.png  history/
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
const WORLD_ID = /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// sort key for "rainbow" order: colors by hue (red -> purple), then greys, then black last
function colorKey(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
  if (!m) return [3, 0, 0];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const s = mx === 0 ? 0 : d / mx;
  if (mx < 0.15) return [2, 0, 0];
  if (s < 0.15) return [1, -mx, 0];
  let h;
  if (d === 0) h = 0;
  else if (mx === r) h = ((g - b) / d + 6) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [0, h * 60, -mx];
}
const cmpKey = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// island ownership signature: used to decide if the map really changed since the last history entry
function signature(tsv) {
  return tsv.split('\n').slice(1).map((l) => { const c = l.split('\t'); return (c[1] || '') + '\t' + (c[3] || ''); })
    .filter((s) => s.trim()).sort().join('\n');
}

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

    // ---------- islands ----------
    const rows = await page.evaluate(async () => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const q = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
      const abs = (u) => (u ? new URL(u, location.href).href : '');
      return polygonList().map(({ id, layer, name }) => {
        const p = layer.feature.properties;
        const owner = resolveOwner(p);
        const colors = groupColorsOf(owner);
        const cols = colors.length ? colors : [ownerMap.has(islandKey(p.name)) ? SHEET_NO_OWNER_COLOR : NO_OWNER_COLOR];
        const w = worldOf(p.name);
        const links = [...new Set([...linksOf(p.name), ...(w && w.link ? [w.link] : [])])];
        const groupNames = preferMarines(ownersOf(owner).flatMap(groupsOf));
        // same flag choice as the page: Marines first, and stripes (several crews) win over a flag
        let flag = '';
        if (cols.length < 2) flag = abs(groupNames.map(flagFor).find(Boolean));
        // bounding box + label point, as 0..1 of the map size (v counted from the bottom)
        const geo = layer.toGeoJSON();
        const g = geo.geometry;
        const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
        let x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
        polys.forEach((rings) => {
          const off = Math.floor(rings[0][0][0] / W) * W;
          rings.forEach((ring) => ring.forEach((pt) => {
            const x = pt[0] - off, y = pt[1];
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }));
        });
        let label = [(x0 + x1) / 2 / W, (y0 + y1) / 2 / H];
        try {
          const c = turf.pointOnFeature(geo).geometry.coordinates;
          const off0 = Math.floor(polys[0][0][0][0] / W) * W;
          label = [(c[0] - off0) / W, c[1] / H];
        } catch (e) { /* keep the box center */ }
        return {
          id, name,
          color: cols.map(hexOf).join(' '),
          owner: String(owner || ''),
          link: links.join(' '),
          flag,
          unowned: ownersOf(owner).length ? 0 : 1,
          unknown: String(p.name || '').includes('???') ? 1 : 0,
          groups: groupNames.map((n) => ({ name: n, color: hexOf(GROUP_COLORS[norm(n)] || DEFAULT_GROUP_COLOR), flag: abs(flagFor(n)) })),
          box: [q(x0 / W), q(y0 / H), q((x1 - x0) / W), q((y1 - y0) / H)],
          label: [q(label[0]), q(label[1])]
        };
      });
    });
    if (!rows.length) throw new Error('No polygons found - not saving anything.');

    // ---------- groups (also crews with no islands) ----------
    const extra = await page.evaluate(() => {
      const m = new Map();
      leaderMap.forEach((crews) => crews.forEach((n) => m.set(n.toLowerCase(), n)));
      return [...m.values()].map((n) => {
        const f = flagFor(n);
        return { name: n, color: hexOf(GROUP_COLORS[norm(n)] || DEFAULT_GROUP_COLOR), flag: f ? new URL(f, location.href).href : '' };
      });
    });
    const groupMap = new Map();
    rows.forEach((r) => {
      const seen = new Set();
      r.groups.forEach((g) => {
        const k = g.name.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        if (!groupMap.has(k)) groupMap.set(k, { name: g.name, color: g.color, flag: g.flag, count: 0 });
        groupMap.get(k).count++;
      });
    });
    extra.forEach((g) => {
      const k = g.name.toLowerCase();
      if (!groupMap.has(k)) groupMap.set(k, { name: g.name, color: g.color, flag: g.flag, count: 0 });
      else if (!groupMap.get(k).flag && g.flag) groupMap.get(k).flag = g.flag;
    });
    const ordered = [...groupMap.values()]
      .sort((a, b) => (b.count > 0) - (a.count > 0) || b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 255);
    const gidOf = new Map(ordered.map((g, i) => [g.name.toLowerCase(), i + 1]));
    const nameRank = new Map([...ordered].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((g, i) => [g.name.toLowerCase(), i + 1]));
    const colorRank = new Map([...ordered].sort((a, b) => cmpKey(colorKey(a.color), colorKey(b.color)) || a.name.localeCompare(b.name)).map((g, i) => [g.name.toLowerCase(), i + 1]));

    // ---------- flag atlas: islands' flags + every crew's flag, sorted by link so cells stay stable ----------
    let urls = [...new Set([...rows.map((r) => r.flag), ...ordered.map((g) => g.flag)].filter(Boolean))].sort();
    if (urls.length > COLS * COLS) { console.log('More than 256 flags - using the first 256.'); urls = urls.slice(0, COLS * COLS); }
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
        fs.mkdirSync('flags', { recursive: true });
        await sharp(buf).resize({ height: 128, fit: 'inside' }).png().toFile(`flags/${i}.png`);
        parts.push({ input: img, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL });
      } catch (e) { console.log('flag failed:', u, e.message); cellOf.delete(u); }
    }
    if (urls.length && parts.length < urls.length * 0.5) {
      throw new Error('Too many flags failed to download (' + (urls.length - parts.length) + ' of ' + urls.length + '). Keeping the previous files.');
    }
    let atlas = sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    if (parts.length) atlas = atlas.composite(parts);
    await atlas.png().toFile('island-flags.png');

    fs.writeFileSync('island-groups.tsv', ['ID\tGroup\tColor\tIslands\tFlag\tFlagAspect\tNameRank\tColorRank', ...ordered.map((g, i) => {
      const k = g.name.toLowerCase();
      return [i + 1, clean(g.name), g.color, g.count, cellOf.has(g.flag) ? cellOf.get(g.flag) : -1,
        cellOf.has(g.flag) ? aspectOf.get(g.flag) : 0, nameRank.get(k), colorRank.get(k)].join('\t');
    })].join('\n') + '\n');

    // ---------- islands file ----------
    const lines = ['ID\tIsland Name\tColor\tOwner\tLink\tFlag\tBoxX\tBoxY\tBoxW\tBoxH\tFlagAspect\tUnowned\tUnknown\tGroup1\tGroup2\tGroup3\tWorldId\tLabelX\tLabelY', ...rows.map((r) => {
      const ids = [...new Set(r.groups.map((g) => gidOf.get(g.name.toLowerCase()) || 0).filter(Boolean))].slice(0, 3);
      while (ids.length < 3) ids.push(0);
      const wid = (WORLD_ID.exec(r.link) || [''])[0];
      return [r.id, clean(r.name), r.color, clean(r.owner), clean(r.link), cellOf.has(r.flag) ? cellOf.get(r.flag) : -1, ...r.box,
        cellOf.has(r.flag) ? aspectOf.get(r.flag) : 0, r.unowned, r.unknown, ...ids, wid, ...r.label].join('\t');
    })];
    const islandsTsv = lines.join('\n') + '\n';
    fs.writeFileSync('island-colors.tsv', islandsTsv);
    console.log(`Saved ${rows.length} islands, ${ordered.length} crews and ${parts.length} flags.`);

    // ---------- history: a new entry only when island ownership really changed ----------
    try {
      fs.mkdirSync('history', { recursive: true });
      const idxPath = 'history/index.tsv';
      let idx = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8').split('\n').filter(Boolean).slice(1).map((l) => l.split('\t')) : [];
      const last = idx.length ? idx[idx.length - 1] : null;
      const lastFile = last ? 'history/' + last[1] : null;
      const lastSig = lastFile && fs.existsSync(lastFile) ? signature(fs.readFileSync(lastFile, 'utf8')) : null;
      if (lastSig !== signature(islandsTsv)) {
        const date = new Date().toISOString().slice(0, 10);
        fs.writeFileSync('history/' + date + '.tsv', islandsTsv);
        idx = idx.filter((e) => e[0] !== date);
        idx.push([date, date + '.tsv']);
        fs.writeFileSync(idxPath, ['Date\tFile', ...idx.map((e) => e.join('\t'))].join('\n') + '\n');
        console.log('History entry saved for', date);
      } else {
        console.log('History: no ownership change.');
      }
    } catch (e) { console.log('history failed:', e.message); }

    // ---------- names overlay image (one picture, no per-island objects) ----------
    try {
      const items = rows.filter((r) => !r.unknown && r.name).map((r) => ({ name: r.name, lx: r.label[0] / 65535, ly: r.label[1] / 65535, bw: r.box[2] / 65535 }));
      const dataUrl = await page.evaluate(async ({ items, maxSide }) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const cw = Math.round(img.naturalWidth * k), ch = Math.round(img.naturalHeight * k);
        await document.fonts.ready;
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        const c = cv.getContext('2d');
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.lineJoin = 'round';
        items.forEach((it) => {
          const size = Math.max(9, Math.min(26, (it.bw * cw * 1.6) / Math.max(4, it.name.length * 0.6)));
          c.font = 'bold ' + size + 'px PlayfairDisplay, "Helvetica Neue", Arial, sans-serif';
          c.lineWidth = Math.max(2, size / 5);
          c.strokeStyle = 'rgba(0,0,0,0.9)';
          c.fillStyle = '#ffffff';
          const x = it.lx * cw, y = (1 - it.ly) * ch;
          c.strokeText(it.name, x, y);
          c.fillText(it.name, x, y);
        });
        return cv.toDataURL('image/png');
      }, { items, maxSide: 2048 });
      fs.writeFileSync('island-labels.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log('Saved island-labels.png');
    } catch (e) { console.log('labels failed:', e.message); }

    // ---------- picture of the colored map (for phones / Discord) ----------
    try {
      const dim = await page.evaluate(async () => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
      });
      const k = Math.min(1, 2048 / Math.max(dim[0], dim[1]));
      await page.setViewportSize({ width: Math.max(256, Math.round(dim[0] * k)), height: Math.max(256, Math.round(dim[1] * k)) });
      await page.addStyleTag({ content: '.leaflet-control-container{display:none!important}' });
      await page.evaluate(([w, h]) => {
        const m = document.getElementById('map');
        m.style.position = 'fixed'; m.style.inset = '0'; m.style.width = '100vw'; m.style.height = '100vh';
        map.options.zoomSnap = 0;
        map.invalidateSize();
        map.fitBounds([[0, 0], [h, w]], { animate: false, padding: [0, 0] });
      }, dim);
      await page.waitForTimeout(4000);
      await page.locator('#map').screenshot({ path: 'island-map.png' });
      console.log('Saved island-map.png');
    } catch (e) { console.log('screenshot failed:', e.message); }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
