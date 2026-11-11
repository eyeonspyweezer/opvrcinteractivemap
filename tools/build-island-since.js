// tools/build-island-since.js
// Reads the history/ folder (saved by build-island-data.js) and writes island-since.tsv:
//   Island Name <tab> Owner <tab> Since (YYYY-MM-DD) <tab> AtLeast
// "Since" = the first saved day of the current, unbroken run of the same owner.
// AtLeast = 1 when the owner was already like this in the OLDEST saved version,
// so the real date may be earlier ("since at least").
// No extra tools needed: plain Node.

const fs = require('fs');

const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
// same owners in any order count as the same ("A/B" = "B / a")
const ownerKey = (s) => clean(s).toLowerCase().split(/[\/,&]/).map((x) => x.trim()).filter(Boolean).sort().join('|');

const idxPath = 'history/index.tsv';
if (!fs.existsSync(idxPath)) {
  console.log('No history/index.tsv yet, nothing to do.');
  process.exit(0);
}

const idx = fs.readFileSync(idxPath, 'utf8').split('\n').filter(Boolean).slice(1).map((l) => l.split('\t'))
  .filter((e) => e[0] && e[1]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const state = new Map(); // island name -> { key, owner, since, atLeast }
let first = true;
for (const [date, file] of idx) {
  const p = 'history/' + file;
  if (!fs.existsSync(p)) continue;
  const rows = fs.readFileSync(p, 'utf8').split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split('\t'));
  const seen = new Set();
  for (const c of rows) {
    const name = clean(c[1]);
    if (!name || name.includes('???')) continue; // unknown islands have no stable name
    const owner = clean(c[3]);
    const key = ownerKey(owner);
    seen.add(name);
    const cur = state.get(name);
    if (!cur || cur.key !== key) state.set(name, { key, owner, since: date, atLeast: first });
    else cur.owner = owner;
  }
  for (const n of [...state.keys()]) if (!seen.has(n)) state.delete(n);
  first = false;
}

const out = ['Island Name\tOwner\tSince\tAtLeast'];
for (const [name, s] of state) out.push([name, s.owner, s.since, s.atLeast ? 1 : 0].join('\t'));
fs.writeFileSync('island-since.tsv', out.join('\n') + '\n');
console.log(`Wrote island-since.tsv with ${state.size} islands from ${idx.length} history entries.`);
