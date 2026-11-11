// Cloudflare Worker: Discord app for the OPVRC map.
// Secrets needed (Settings > Variables and Secrets):
//   DISCORD_PUBLIC_KEY, DISCORD_APP_ID, DISCORD_TOKEN, REGISTER_KEY (any password you make up)

const BASE = "https://eyeonspyweezer.github.io/opvrcinteractivemap";
const IMG = "https://raw.githubusercontent.com/eyeonspyweezer/opvrcinteractivemap/bot-images";
const IMG_TEST = "https://raw.githubusercontent.com/eyeonspyweezer/opvrcinteractivemap/bot-images-test";

const LINKS = {
  mapurl: BASE + "/",
  maplink: BASE + "/",
  discord: "https://discord.gg/TeunYpsHb6",
  vrc: "https://vrchat.com/home/group/grp_677be38a-564d-432f-be95-f2e319bb4b13",
  marines: "https://vrchat.com/home/group/grp_c8c05ec4-4bb8-466b-a315-cdcc04ae6065",
  marinesdiscord: "https://discord.gg/pMAKMQ3B4y",
  revolutionary: "https://vrchat.com/home/group/grp_c65b67ca-f924-48da-94f8-02d18c654f9e",
};

const DESCRIPTIONS = {
  mapurl: "Link to the interactive island map",
  maplink: "Link to the interactive island map",
  discord: "Invite to the OPVRC Discord",
  vrc: "OPVRC VRChat group",
  marines: "Marines VRChat group",
  marinesdiscord: "Marines Discord invite",
  revolutionary: "Revolutionary Army VRChat group",
};

// order matches the mask: M U O P R K
const TOGGLES = [
  ["🔵🏳️", "Marines/WG"],
  ["❓", "Unknown islands"],
  ["⚪", "Unowned"],
  ["🏴‍☠️", "Pirates"],
  ["🚩", "Revolutionaries"],
  ["👑", "Kingdoms"],
];
const ALL_ON = "111111";
const ALL_OFF = "000000";
// button order on screen: Pirates, Marines, Revolutionaries, Unowned, Unknown, Kingdoms
const DISPLAY = [3, 0, 4, 2, 1, 5];

const REGIONS = [
  ["all", "Whole map"],
  ["nblue", "North Blue"],
  ["eblue", "East Blue"],
  ["wblue", "West Blue"],
  ["sblue", "South Blue"],
  ["newworld", "New World"],
  ["paradise", "Paradise"],
];

// ---------- Discord signature check ----------
const hex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

async function verify(request, body, publicKey) {
  const sig = request.headers.get("X-Signature-Ed25519");
  const ts = request.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  let key;
  try {
    key = await crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    key = await crypto.subtle.importKey(
      "raw", hex(publicKey), { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"]
    );
  }
  return crypto.subtle.verify(key.algorithm.name, key, hex(sig), new TextEncoder().encode(ts + body));
}

// ---------- TSV groups ----------
async function getGroups() {
  const [groups, metadata, islands] = await Promise.all([
    tsv("island-groups.tsv"),
    tsv("crew-links.tsv").catch(() => []),
    tsv("island-colors.tsv").catch(() => [])
  ]);
  const normalize = value => String(value || "").trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
  const metadataByName = new Map(
    metadata.map(row => [normalize(row.Group), row]).filter(([name]) => name)
  );

  // Use the most common mapped island fill color for each crew.
  const colorsByGroup = new Map();
  for (const island of islands) {
    const color = (String(island.Color || "").match(/#[0-9a-f]{6}/i) || [])[0];
    if (!color) continue;
    const groupIds = [island.Group1, island.Group2, island.Group3]
      .map(value => String(value || "").trim())
      .filter(value => value && value !== "0");
    for (const groupId of groupIds) {
      if (!colorsByGroup.has(groupId)) colorsByGroup.set(groupId, new Map());
      const counts = colorsByGroup.get(groupId);
      const key = color.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return groups.map((o) => {
    const f = parseInt(o.Flag, 10);
    const extra = metadataByName.get(normalize(o.Group)) || {};
    const colorCounts = colorsByGroup.get(String(o.ID)) || new Map();
    const mapColor = [...colorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || o.Color || "#005aff";
    return {
      id: o.ID || "",
      name: o.Group || "",
      islands: parseInt(o.Islands, 10) || 0,
      flag: Number.isNaN(f) ? -1 : f,
      mapColor,
      vrchatGroupUrl: extra.VRChatGroupURL || "",
      vrchatGroupId: extra.VRChatGroupID || "",
      discordInvite: extra.DiscordInvite || "",
      vrchatMembers: extra.VRChatMembers || "",
      vrchatOnline: extra.VRChatOnline || "",
      discordMembers: extra.DiscordMembers || "",
      flagUrl: extra.FlagURL || ""
    };
  });
}

// ---------- VRC Search public group data ----------
const VRC_SEARCH_API = "https://search.vrcwwt.com/api";
const VRC_SEARCH_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "OPVRC Interactive Map Discord Bot/1.0 (+https://github.com/eyeonspyweezer/opvrcinteractivemap)"
};
const vrcSearchCache = new Map();

async function vrcSearchJson(path, ttlMs = 15 * 60 * 1000) {
  const key = String(path);
  const cached = vrcSearchCache.get(key);
  if (cached && Date.now() - cached.savedAt < ttlMs) return cached.data;
  const response = await fetch(`${VRC_SEARCH_API}${path}`, { headers: VRC_SEARCH_HEADERS });
  if (!response.ok) {
    throw new Error(`VRC Search returned ${response.status}${response.status === 403 ? " (check the API User-Agent)" : ""}.`);
  }
  const data = await response.json();
  vrcSearchCache.set(key, { savedAt: Date.now(), data });
  return data;
}

async function getVrcGroupDetails(groupId) {
  if (!/^grp_[a-f0-9-]+$/i.test(String(groupId || ""))) return null;
  return vrcSearchJson(`/groups/${encodeURIComponent(groupId)}`);
}

async function getVrcGroupBatch(groups) {
  const ids = [...new Set(groups.map(g => String(g.vrchatGroupId || "").trim()).filter(id => /^grp_[a-f0-9-]+$/i.test(id)))];
  if (!ids.length) return [];
  if (ids.length > 100) throw new Error("More than 100 linked VRChat groups; split the lookup into batches.");
  const data = await vrcSearchJson(`/groups?ids=${encodeURIComponent(ids.join(","))}`);
  return Array.isArray(data.items) ? data.items : [];
}

function vrcMemberHistoryLines(detail) {
  const points = (detail?.member_history?.points || [])
    .filter(point => Number.isFinite(Number(point.ts)) && Number.isFinite(Number(point.new_member_count)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!points.length) return "No historical membership snapshots are available yet.";
  return points.slice(-7).map(point => {
    const rawTs = Number(point.ts);
    const date = new Date(rawTs < 1e12 ? rawTs * 1000 : rawTs);
    const dateLabel = Number.isNaN(date.getTime())
      ? "Unknown date"
      : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const delta = Number(point.delta);
    const deltaLabel = Number.isFinite(delta) ? ` (${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")})` : "";
    return `• ${dateLabel}: **${Number(point.new_member_count).toLocaleString("en-US")}** members${deltaLabel}`;
  }).join("\n");
}

// ---------- message builders ----------
const stamp = () => Math.floor(Date.now() / 300000); // new image URL every 5 minutes so Discord refreshes

function buttons(mask) {
  const btn = (i) => ({
    type: 2,
    style: mask[i] === "1" ? 1 : 2, // blue when ON, grey when OFF
    label: TOGGLES[i][1],
    emoji: undefined,
    custom_id: `t${i}_${mask}`,
  });
  const withEmoji = (i) => {
    const b = btn(i);
    b.label = `${TOGGLES[i][0]} ${TOGGLES[i][1]}`;
    return b;
  };
  return [
    { type: 1, components: DISPLAY.slice(0, 5).map(withEmoji) },
    {
      type: 1,
      components: [
        withEmoji(5),
        { type: 2, style: 2, label: "Reset (all on)", custom_id: `r_${mask}` },
      ],
    },
  ];
}

function regionMenu(mask) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `v_${mask}`,
        placeholder: "🧭 Zoom to a region",
        options: REGIONS.map(([value, label]) => ({ label, value })),
      },
    ],
  };
}

function groupMenu(mask, groups) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `g_${mask}`,
        placeholder: "🔍 Find a group's islands",
        options: groups.slice(0, 25).map((g) => ({
          label: g.name.slice(0, 100),
          value: g.id,
          description: `${g.islands} island${g.islands === 1 ? "" : "s"}`,
        })),
      },
    ],
  };
}

// when island-colors.tsv last changed on GitHub (cached 10 minutes)
async function lastUpdated() {
  try {
    const r = await fetch(
      "https://api.github.com/repos/eyeonspyweezer/opvrcinteractivemap/commits?path=island-colors.tsv&per_page=1",
      { headers: { "User-Agent": "opvrc-map-bot", Accept: "application/vnd.github+json" }, cf: { cacheTtl: 600, cacheEverything: true } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j[0]?.commit?.committer?.date || null;
  } catch {
    return null;
  }
}

// small flag picture made by the data Action (flags/<number>.png)
const flagUrl = (n) => (n >= 0 ? `${BASE}/flags/${n}.png?v=${stamp()}` : null);

async function mapMessage(mask, { title, description, image, thumbnail } = {}) {
  const groups = await getGroups();
  const updated = await lastUpdated();
  return {
    embeds: [
      {
        title: title || "OPVRC Island Map",
        description:
          description ||
          "Blue = shown, grey = hidden. Tap one button to show only that type, then tap more to add or remove.\n" +
            "Box colors: 🔵 Marines/WG · ⚫ Pirates · 🟣 Kingdoms · 🟡/🟢 Unowned · ⚪ Unknown\n" +
            "Not sure of a group name? Use the dropdown, or type /group and start typing.",
        url: BASE + "/",
        color: 0x005aff,
        ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
        ...(updated ? { footer: { text: "Map data last updated" }, timestamp: updated } : {}),
        image: {
          url:
            image ||
            (mask === ALL_ON ? `${BASE}/preview.png?v=${stamp()}` : `${IMG}/maps/${mask}.jpg?v=${stamp()}`),
        },
      },
    ],
    components: [...buttons(mask), groupMenu(mask, groups), regionMenu(mask)],
  };
}

// ---------- /island ----------
async function tsv(file) {
  // Visit snapshots are updated by GitHub Actions and must not be served
  // from an old Worker cache. Other map TSVs can keep the short cache.
  const isVisitData =
    file === "island-world-visits.tsv" ||
    file === "island-world-visit-history.tsv";
  const url = isVisitData
    ? `${BASE}/${file}?v=${Date.now()}`
    : `${BASE}/${file}`;
  const res = await fetch(url, {
    cf: { cacheTtl: isVisitData ? 0 : 300 }
  });
  if (res.ok === false) throw new Error(`${file} not found`);
  const txt = await res.text();
  const [head, ...rows] = txt.trim().split(/\r?\n/);
  const cols = head.split("\t");
  return rows.map((line) => {
    const v = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
}

// ---------- Owner Links Map ----------
async function getOwnerLinks() {
  try {
    const txt = await (await fetch(BASE + "/owner-links.tsv", { cf: { cacheTtl: 300 } })).text();
    const [head, ...rows] = txt.trim().split(/\r?\n/);
    const cols = head.split("\t");
    const map = {};
    for (const line of rows) {
      const v = line.split("\t");
      const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
      const name = (o.Owner || "").trim();
      if (!name) continue;
      map[name.toLowerCase()] = {
        link: o["Profile Link"] || "",
        discord: o["Discord ID"] || ""
      };
    }
    return map;
  } catch {
    return {};
  }
}

function islandDisplayName(island) {
  if (String(island.ID) === "2") return "New Kuraigana (On top of Onigashima)";
  return island["Island Name"];
}

async function islandChoices(query) {
  const q = query.toLowerCase();
  const islands = await tsv("island-colors.tsv");
  const hits = islands.filter((r) =>
    islandDisplayName(r).toLowerCase().includes(q)
  );
  // real names first, ??? islands last
  hits.sort((a, b) => (a.Unknown === "1") - (b.Unknown === "1"));
  return hits.slice(0, 25).map((r) => ({ name: islandDisplayName(r).slice(0, 100), value: r.ID }));
}

async function renameIslandChoices(query) {
  const q = query.toLowerCase();
  const islands = await tsv("island-colors.tsv");
  return islands
    .filter((r) => r["Island Name"] && r["Island Name"].toLowerCase().includes(q))
    .slice(0, 25)
    .map((r) => ({ name: r["Island Name"].slice(0, 100), value: r["Island Name"].slice(0, 100) }));
}
// ---------- VRChat world population (no authentication) ----------
async function getWorldPopulation(worldId) {
  try {
    const r = await fetch(
      `https://api.vrchat.cloud/api/1/worlds/${worldId}`,
      {
        headers: {
          "User-Agent": "OPVRCMapBot/1.1 https://discord.gg/TeunYpsHb6"
        },
        cf: { cacheTtl: 900 }
      }
    );

    if (!r.ok) return null;

    const world = await r.json();

    return {
      name: world.name || worldId,
      total: world.occupants,
      public: world.publicOccupants,
      private: world.privateOccupants,
      visits: world.visits
    };
  } catch {
    return null;
  }
}

// ---------- /worldactivity: crew-ranked activity scan ----------
let worldActivityInFlight = null;

function parseWorldActivityDuration(value) {
  const v = String(value || "7d").trim().toLowerCase();
  const m = v.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/);
  if (!m) return { label: "7 days", ms: 7 * 86400000 };

  const amount = Number(m[1]);
  const unitMs = {
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
  }[m[2]];

  const ms = amount * unitMs;
  if (!Number.isFinite(ms) || ms <= 0) return { label: "7 days", ms: 7 * 86400000 };

  const unitName = { m: "minute", h: "hour", d: "day", w: "week" }[m[2]];
  return {
    label: `${amount} ${unitName}${amount === 1 ? "" : "s"}`,
    ms
  };
}

function worldActivityDurationOptions() {
  return [
    { name: "1 hour", value: "1h" },
    { name: "6 hours", value: "6h" },
    { name: "24 hours", value: "24h" },
    { name: "3 days", value: "3d" },
    { name: "7 days (default)", value: "7d" },
    { name: "14 days", value: "14d" },
    { name: "30 days", value: "30d" }
  ];
}

async function buildWorldActivity(durationValue = "7d") {
  const duration = parseWorldActivityDuration(durationValue);

  const [islands, latestRows, historyRows, groups] = await Promise.all([
    tsv("island-colors.tsv"),
    tsv("island-world-visits.tsv"),
    tsv("island-world-visit-history.tsv"),
    tsv("island-groups.tsv")
  ]);

  const groupById = new Map(groups.map(g => [String(g.ID), g]));
  const worldIslands = new Map();
  const worldIds = new Set();
  const worldPattern = /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  for (const island of islands) {
    const links = `${island.Link || ""} ${island.WorldId || ""}`;
    const ids = links.match(worldPattern) || [];

    for (const rawId of ids) {
      const id = rawId.toLowerCase();
      worldIds.add(id);

      if (!worldIslands.has(id)) {
        worldIslands.set(id, []);
      }

      const groupNames = [island.Group1, island.Group2, island.Group3]
        .filter(id => id && id !== "0")
        .map(id => groupById.get(String(id))?.Group)
        .filter(Boolean);

      const label =
        groupNames[0] ||
        String(island.Owner || "").trim() ||
        (island.Unowned === "1" ? "Unowned" : "Unassigned");

      const existing = worldIslands.get(id);
      const entry = {
        islandId: String(island.ID),
        islandName: islandDisplayName(island),
        ownerLabel: label,
        ownerName: String(island.Owner || "").trim() || (island.Unowned === "1" ? "Unowned" : "Unassigned")
      };

      if (!existing.some(x => x.islandId === entry.islandId)) {
        existing.push(entry);
      }
    }
  }

  const latestById = new Map(
    latestRows.map(row => [(row["World ID"] || "").toLowerCase(), row])
  );

  const samplesById = new Map();

  for (const row of historyRows) {
    const id = (row["World ID"] || "").toLowerCase();
    const checkedAt = row["Checked At UTC"] || "";
    const visits = Number(row["Lifetime Visits"]);

    if (!worldIds.has(id) || !checkedAt || !Number.isFinite(visits)) continue;

    if (!samplesById.has(id)) {
      samplesById.set(id, []);
    }

    samplesById.get(id).push({
      checkedAt,
      visits
    });
  }

  const cutoff = Date.now() - duration.ms;
  const visitGrowth = [];

  for (const id of worldIds) {
    const latest = latestById.get(id);

    if (!latest || latest.Status !== "ok") continue;

    const samples = (samplesById.get(id) || [])
      .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));

    if (samples.length < 2) continue;

    const current = samples[samples.length - 1];

    // "7d" means the rolling past 7 days, not a snapshot exactly 7 days ago.
    // Prefer the newest snapshot at or before the cutoff. If no snapshot is
    // that old, use the oldest snapshot that is still inside the requested
    // window. Never compare against a snapshot older than the requested window.
    let baseline = null;

    for (let i = samples.length - 2; i >= 0; i--) {
      const sampleTime = Date.parse(samples[i].checkedAt);
      if (sampleTime <= cutoff) {
        baseline = samples[i];
        break;
      }
    }

    if (!baseline) {
      const oldest = samples[0];
      const oldestTime = Date.parse(oldest.checkedAt);
      if (oldestTime >= cutoff) {
        baseline = oldest;
      }
    }

    if (!baseline) continue;

    // Net change = current lifetime visits minus the selected baseline.
    // Do not discard the result just because the separate latest TSV fetch
    // has a slightly different cache generation.
    const gained = current.visits - baseline.visits;
    const comparisonMs = Math.max(0, Date.parse(current.checkedAt) - Date.parse(baseline.checkedAt));
    if (gained === 0) continue;

    visitGrowth.push({
      id,
      name: latest["World Name"] || id,
      gained,
      checkedAt: current.checkedAt,
      previousAt: baseline.checkedAt,
      comparisonMs,
      islands: worldIslands.get(id) || []
    });
  }

  // Aggregate each island into its primary crew/organization.
  // Group1 is treated as the primary organization; if there is no group,
  // the island owner name is used. This prevents shared Group2/Group3
  // assignments from double-counting the same island's visits.
  const buckets = new Map();

  for (const item of visitGrowth) {
    for (const island of item.islands) {
      const key = island.ownerLabel || "Unassigned";

      if (!buckets.has(key)) {
        buckets.set(key, {
          name: key,
          gained: 0,
          worldIds: new Set(),
          islandMap: new Map()
        });
      }

      const bucket = buckets.get(key);

      // A single VRChat world can be linked to several map islands.
      // Count that world's net visit change only once per crew.
      if (!bucket.worldIds.has(item.id)) {
        bucket.worldIds.add(item.id);
        bucket.gained += item.gained;
      }

      if (!bucket.islandMap.has(island.islandId)) {
        bucket.islandMap.set(island.islandId, {
          id: island.islandId,
          name: island.islandName,
          worldIds: [],
          worldVisitGain: 0
        });
      }

      const islandEntry = bucket.islandMap.get(island.islandId);
      islandEntry.worldVisitGain += item.gained;
      if (!islandEntry.worldIds.includes(item.id)) {
        islandEntry.worldIds.push(item.id);
      }
    }
  }

  const crewGrowth = [...buckets.values()]
    .map(bucket => ({
      ...bucket,
      islands: [...bucket.islandMap.values()]
        .sort((a, b) => b.worldVisitGain - a.worldVisitGain)
    }))
    .filter(bucket => bucket.gained !== 0)
    .sort((a, b) => b.gained - a.gained);

  // Rank actual island owners separately from Group1/crew organization rankings.
  const ownerBuckets = new Map();
  for (const item of visitGrowth) {
    const ownersForWorld = new Map();
    for (const island of item.islands) {
      const ownerName = island.ownerName || "Unassigned";
      if (!ownersForWorld.has(ownerName)) ownersForWorld.set(ownerName, []);
      ownersForWorld.get(ownerName).push(island);
    }
    for (const [ownerName, ownerIslands] of ownersForWorld) {
      if (!ownerBuckets.has(ownerName)) ownerBuckets.set(ownerName, { name: ownerName, gained: 0, islands: new Map(), worldIds: new Set() });
      const bucket = ownerBuckets.get(ownerName);
      bucket.gained += item.gained;
      bucket.worldIds.add(item.id);
      for (const island of ownerIslands) {
        if (!bucket.islands.has(island.islandId)) bucket.islands.set(island.islandId, { id: island.islandId, name: island.islandName, worldIds: [], worldVisitGain: 0 });
        const entry = bucket.islands.get(island.islandId);
        entry.worldVisitGain += item.gained;
        if (!entry.worldIds.includes(item.id)) entry.worldIds.push(item.id);
      }
    }
  }
  const ownerGrowth = [...ownerBuckets.values()].map(bucket => ({
    name: bucket.name,
    gained: bucket.gained,
    islands: [...bucket.islands.values()].sort((a, b) => b.worldVisitGain - a.worldVisitGain)
  })).filter(bucket => bucket.gained !== 0).sort((a, b) => b.gained - a.gained);

  // Island ranking uses the same historical net visit changes, counted once
  // for each mapped island/world association.
  const islandBuckets = new Map();
  for (const item of visitGrowth) {
    for (const island of item.islands) {
      if (!islandBuckets.has(island.islandId)) {
        islandBuckets.set(island.islandId, {
          id: island.islandId,
          name: island.islandName,
          gained: 0,
          worldIds: new Set()
        });
      }
      const bucket = islandBuckets.get(island.islandId);
      if (!bucket.worldIds.has(item.id)) {
        bucket.worldIds.add(item.id);
        bucket.gained += item.gained;
      }
    }
  }
  const islandGrowth = [...islandBuckets.values()]
    .map(bucket => ({ ...bucket, worldIds: [...bucket.worldIds] }))
    .filter(bucket => bucket.gained !== 0)
    .sort((a, b) => b.gained - a.gained);

  return {
    checkedAt: new Date().toISOString(),
    duration: duration.label,
    comparisonDays: visitGrowth.length ? Math.max(...visitGrowth.map(x => x.comparisonMs || 0)) / 86400000 : 0,
    crewGrowth,
    ownerGrowth,
    islandGrowth,
    trackedWorldCount: worldIds.size
  };
}

async function getWorldActivity(durationValue = "7d") {
  // Deduplicate simultaneous command requests in this Worker isolate.
  if (worldActivityInFlight) return await worldActivityInFlight;

  worldActivityInFlight = buildWorldActivity(durationValue);

  try {
    return await worldActivityInFlight;
  } finally {
    worldActivityInFlight = null;
  }
}

function worldActivityMessage(data) {
  const count = value => Number(value || 0).toLocaleString("en-US");
  const crewLines = data.crewGrowth.map((crew, index) => {
    const online = crew.activePlayersKnown
      ? ` · ${count(crew.activePlayers)} online now`
      : " · online count unavailable";
    const islands = crew.islands.slice(0, 8).map((island, n) =>
      `[#${n + 1}](https://vrchat.com/home/world/${island.worldIds?.[0] || ""})`
    );
    const sign = crew.gained > 0 ? "+" : "";
    return `**${index + 1}. ${crew.name}** — **${sign}${count(crew.gained)} net visits**${online} (${islands.join(", ")})`;
  });
  const description = crewLines.length ? crewLines.join("\n") : "No non-zero visit changes were found for the selected duration.";
  return { embeds: [{
    title: "VRChat World Activity — Crew Ranking",
    description: `Ranked by historical net visit change over ${data.duration}. Current online players are a separate snapshot and do not affect ranking.\n${data.historyNote || ""}\n\n${description}`.slice(0, 5900),
    color: 0x005aff,
    footer: { text: `Visit history: ${data.trackedWorldCount} linked worlds · live snapshot captured ${data.liveCheckedAt || "unavailable"}` },
    timestamp: data.checkedAt
  }] };
}

function historicalActivityMessage(data, live, kind) {
  const count = value => Number(value || 0).toLocaleString("en-US");
  const rows = kind === "island" ? data.islandGrowth : kind === "owner" ? data.ownerGrowth : data.crewGrowth;
  const liveRows = kind === "island" ? live.islandRankings : kind === "owner" ? live.ownerRankings : live.crewRankings;
  const liveByName = new Map(liveRows.map(row => [String(row.name).toLowerCase(), row]));
  const title = kind === "island" ? "Island" : kind === "owner" ? "Island Owner" : "Crew / Group";
  const lines = rows.slice(0, 20).map((row, index) => {
    const current = liveByName.get(String(row.name).toLowerCase());
    const online = current && current.knownWorlds
      ? ` · ${count(current.players)} online now`
      : "";
    const sign = row.gained > 0 ? "+" : "";
    const link = kind === "island" && row.worldIds?.[0]
      ? ` · [VRChat world](https://vrchat.com/home/world/${row.worldIds[0]})`
      : "";
    const extra = kind === "island" ? "" : ` · ${row.islands?.length || 0} islands`;
    return `**${index + 1}. ${row.name}** — **${sign}${count(row.gained)} net visits**${online}${extra}${link}`;
  });
  const description = lines.length ? lines.join("\n") : "No non-zero historical visit changes were found for the selected duration.";
  return { embeds: [{
    title: `VRChat World Activity — ${title} Ranking`,
    description: `Ranked by historical net visit change over ${data.duration}. Current online players are shown separately and do not affect ranking.\n${data.historyNote || ""}\n\n${description}`.slice(0, 5900),
    color: 0x005aff,
    footer: { text: `Historical visit tracker: ${data.trackedWorldCount} linked worlds · live snapshot captured ${live.checkedAt || "unavailable"}` },
    timestamp: data.checkedAt
  }] };
}

async function historicalActivityResponse(kind, durationValue = "7d") {
  try {
    const [data, live] = await Promise.all([getWorldActivity(durationValue), buildLiveActivity()]);
    const liveRows = kind === "island" ? live.islandRankings : kind === "owner" ? live.ownerRankings : live.crewRankings;
    const liveByName = new Map(liveRows.map(row => [String(row.name).toLowerCase(), row]));
    if (kind === "crew") {
      for (const row of data.crewGrowth) {
        const current = liveByName.get(String(row.name).toLowerCase());
        row.activePlayers = current?.players || 0;
        row.activePlayersKnown = Boolean(current?.knownWorlds);
      }
      const response = worldActivityMessage({
        ...data,
        liveCheckedAt: live.checkedAt,
        historyNote: data.comparisonDays > 0 && data.comparisonDays < parseWorldActivityDuration(durationValue).ms / 86400000
          ? `Only ${data.comparisonDays.toFixed(1)} days of recorded history are currently available.`
          : ""
      });
      try {
        const groups = await getGroups();
        const memberRows = await getVrcGroupBatch(groups);
        const growthRows = memberRows
          .filter(row => row.avg_daily_growth_90d !== null && row.avg_daily_growth_90d !== undefined && Number.isFinite(Number(row.avg_daily_growth_90d)))
          .sort((a, b) => Number(b.avg_daily_growth_90d) - Number(a.avg_daily_growth_90d));
        const memberLines = growthRows.slice(0, 15).map((row, index) => {
          const daily = Number(row.avg_daily_growth_90d);
          const estimate = Math.round(daily * 90);
          const sign = value => value > 0 ? "+" : "";
          const groupName = row.vrc_search_url ? `[${row.name}](${row.vrc_search_url})` : row.name;
          return `**${index + 1}. ${groupName}** — ${Number(row.member_count || 0).toLocaleString("en-US")} members · **${sign(daily)}${daily.toFixed(2)}/day** · ~${sign(estimate)}${estimate.toLocaleString("en-US")} over 90d`;
        });
        const memberSection = memberLines.length
          ? memberLines.join("\n")
          : "No linked groups currently have enough membership snapshots to calculate growth.";
        response.embeds[0].description = (response.embeds[0].description + `\n\n**VRChat Group Membership — 90-day average growth**\n${memberSection}\n\n[Data from VRC Search](https://search.vrcwwt.com/)`).slice(0, 5900);
        response.embeds[0].footer.text += " · Membership stats from VRC Search";
      } catch (error) {
        console.error("VRC Search crew activity lookup failed:", error);
        response.embeds[0].description = (response.embeds[0].description + "\n\n**VRChat group membership growth**\nMembership statistics are temporarily unavailable.").slice(0, 5900);
      }
      return response;
    }
    data.historyNote = data.comparisonDays > 0 && data.comparisonDays < parseWorldActivityDuration(durationValue).ms / 86400000
      ? `Only ${data.comparisonDays.toFixed(1)} days of recorded history are currently available.`
      : "";
    return historicalActivityMessage(data, live, kind);
  } catch (error) {
    return { content: `⚠️ Could not load historical activity: ${String(error?.message || error).slice(0, 250)}` };
  }
}

async function worldActivityResponse(durationValue = "7d") {
  return historicalActivityResponse("crew", durationValue);
}

async function ownerActivityResponse(durationValue = "7d") {
  return historicalActivityResponse("owner", durationValue);
}
// ---------- live online-player rankings ----------
// The GitHub Action refreshes all mapped worlds every 10 minutes. Reading one
// TSV avoids Cloudflare's per-invocation subrequest limit and avoids sampling.
async function buildLiveActivity() {
  const [islands, groups, populationRows] = await Promise.all([
    tsv("island-colors.tsv"),
    tsv("island-groups.tsv"),
    tsv("island-world-populations.tsv").catch(() => [])
  ]);

  const populationByWorld = new Map(
    populationRows.map(row => [String(row["World ID"] || "").toLowerCase(), row])
  );
  const checkedAt = populationRows
    .map(row => row["Checked At UTC"] || "")
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || "";

  const groupById = new Map(groups.map(group => [String(group.ID), group]));
  const worldPattern = /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const mappedIslands = islands.map(island => {
    const linkText = `${island.Link || ""} ${island.WorldId || ""}`;
    const worldIds = [...new Set((linkText.match(worldPattern) || []).map(id => id.toLowerCase()))];
    const groupIds = [...new Set([island.Group1, island.Group2, island.Group3].filter(id => id && id !== "0"))];
    const groupNames = groupIds.map(id => groupById.get(String(id))?.Group).filter(Boolean);
    const owner = String(island.Owner || "").trim() ||
      (island.Unowned === "1" ? "Unowned" : "Unassigned");

    return {
      id: String(island.ID || ""),
      name: islandDisplayName(island),
      owner,
      groupNames,
      worldIds
    };
  }).filter(island => island.worldIds.length > 0);

  const measure = worldIds => {
    let players = 0;
    let knownWorlds = 0;
    for (const id of worldIds) {
      const row = populationByWorld.get(id);
      const value = row ? Number(row["Total Players"]) : NaN;
      if (row?.Status === "ok" && row["Total Players"] !== "" && Number.isFinite(value) && value >= 0) {
        players += value;
        knownWorlds++;
      }
    }
    return { players, knownWorlds, worldCount: worldIds.size };
  };

  const islandRankings = mappedIslands.map(island => {
    const worldIds = new Set(island.worldIds);
    return {
      name: island.name,
      islandIds: new Set([island.id]),
      worldIds,
      ...measure(worldIds)
    };
  });

  const aggregate = (keyForIsland) => {
    const buckets = new Map();
    for (const island of mappedIslands) {
      for (const label of new Set(keyForIsland(island).filter(Boolean))) {
        if (!buckets.has(label)) {
          buckets.set(label, { name: label, islandIds: new Set(), worldIds: new Set() });
        }
        const bucket = buckets.get(label);
        bucket.islandIds.add(island.id);
        for (const worldId of island.worldIds) bucket.worldIds.add(worldId);
      }
    }
    return [...buckets.values()].map(bucket => ({ ...bucket, ...measure(bucket.worldIds) }));
  };

  const crewRankings = aggregate(island => island.groupNames);
  const ownerRankings = aggregate(island => [island.owner]);

  const sortRankings = rows => rows.sort((a, b) =>
    b.players - a.players || a.name.localeCompare(b.name)
  );

  return {
    checkedAt,
    trackedWorldCount: populationRows.length,
    islandRankings: sortRankings(islandRankings),
    crewRankings: sortRankings(crewRankings),
    ownerRankings: sortRankings(ownerRankings)
  };
}

function liveActivityMessage(data, kind) {
  const config = {
    island: { title: "Island Online Activity", rows: data.islandRankings, limit: 20, extra: row => `${row.knownWorlds}/${row.worldCount} worlds checked` },
    crew: { title: "Crew / Group Online Activity", rows: data.crewRankings, limit: 20, extra: row => `${row.islandIds.size} islands · ${row.knownWorlds}/${row.worldCount} worlds checked` },
    owner: { title: "Island Owner Online Activity", rows: data.ownerRankings, limit: 20, extra: row => `${row.islandIds.size} islands · ${row.knownWorlds}/${row.worldCount} worlds checked` }
  }[kind];

  if (!data.checkedAt || !data.trackedWorldCount) {
    return { content: "⚠️ The live player snapshot has not been generated yet. The GitHub Actions population tracker needs to complete its first run." };
  }

  const lines = config.rows.slice(0, config.limit).map((row, index) => {
    const worlds = [...row.worldIds].slice(0, 2).map(id => `[world](https://vrchat.com/home/world/${id})`).join(" · ");
    const players = row.knownWorlds ? `${row.players.toLocaleString("en-US")} players` : "Unavailable";
    const links = kind === "island" && worlds ? ` · ${worlds}` : "";
    return `**${index + 1}. ${row.name}** — **${players}** · ${config.extra(row)}${links}`;
  });

  const description = lines.length
    ? lines.join("\n")
    : "No mapped islands, crews, or owners were available to rank.";

  return {
    embeds: [{
      title: config.title,
      description: description.slice(0, 3900),
      color: 0x005aff,
      footer: {
        text: `Live VRChat snapshot · ${data.trackedWorldCount} world records · captured ${data.checkedAt} · scheduled every 10 minutes`
      },
      timestamp: data.checkedAt
    }]
  };
}

async function liveActivityResponse(kind) {
  try {
    return liveActivityMessage(await buildLiveActivity(), kind);
  } catch (error) {
    return { content: `⚠️ Could not load live player rankings: ${String(error?.message || error).slice(0, 300)}` };
  }
}

// "August 1st, 2026 (95 days ago)"; after 60 days it says months instead
function sinceText(sinceDate, atLeast) {
  const d = new Date(sinceDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  const month = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  let ago;
  if (days < 1) ago = "today";
  else if (days <= 60) ago = `${days} day${days === 1 ? "" : "s"} ago`;
  else {
    const months = Math.floor(days / 30.44);
    ago = `${months} month${months === 1 ? "" : "s"} ago`;
  }
  return `${atLeast ? "at least " : ""}${month} ${day}${suffix}, ${d.getUTCFullYear()} (${ago})`;
}


async function islandMessage(query) {
  const [islands, groups, sinceRows, islandVisitRows, worldVisitRows] =
    await Promise.all([
      tsv("island-colors.tsv"),
      tsv("island-groups.tsv"),
      tsv("island-since.tsv").catch(() => []),
      tsv("island-visits.tsv").catch(() => []),
      tsv("island-world-visits.tsv").catch(() => []),
    ]);

  const q = query.toLowerCase();
  const isl =
    islands.find((r) => r.ID === query) ||
    islands.find((r) => islandDisplayName(r).toLowerCase() === q) ||
    islands.find((r) => islandDisplayName(r).toLowerCase().includes(q));

  if (!isl) return { content: `I couldn't find an island called "${query}".` };

  const formatVisits = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString("en-US") : "";
  };

  const visitLine = (row, field) => {
    if (!row) return "";
    const status = String(row[`${field} Status`] || "").toLowerCase();
    const value = formatVisits(row[field]);

    if (status === "unavailable") return "Unavailable";
    if (status !== "ok" || !value || Number(row[field]) === 0) return "";

    return value;
  };

  const groupNames = [isl.Group1, isl.Group2, isl.Group3]
    .filter((id) => id && id !== "0")
    .map((id) => groups.find((g) => g.ID === id)?.Group)
    .filter(Boolean);

  const ids = [
    ...new Set(
      (isl.Link.match(
        /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
      ) || []).map((id) => id.toLowerCase())
    ),
  ];

  const urls = ids.length
    ? ids.map((id) => `https://vrchat.com/home/world/${id}`)
    : isl.Link.split(/\\s+/).filter(Boolean);

  const populations = await Promise.all(
    ids.map((id) => getWorldPopulation(id))
  );

  // A single linked world gets the simple "VRChat World" label.
  // Multiple linked worlds get numbered "#1", "#2", etc. and use
  // the actual VRChat world name returned by the API.
  const worldLabel = (n, p) => {
    const name = p?.name ? String(p.name).trim() : "";
    if (ids.length === 1) {
      return name ? `VRChat World — ${name}` : "VRChat World";
    }
    return name ? `#${n + 1} ${name}` : `#${n + 1} World`;
  };

  const links = urls
    .slice(0, 6)
    .map((u, n) => {
      const p = populations[n];
      const label = worldLabel(n, p);
      return `[${label}](${u})`;
    });

  const populationLines = populations
    .map((p, n) => {
      // If the world has zero total players, hide that world's details entirely.
      if (
        !p ||
        !Number.isFinite(Number(p.total)) ||
        Number(p.total) <= 0
      ) {
        return "";
      }

      const total = Number(p.total);
      const pub = Number(p.public);
      const priv = Number(p.private);
      const label = worldLabel(n, p);

      const worldVisit = worldVisitRows.find(
        (r) => (r["World ID"] || "").toLowerCase() === ids[n]
      );

      const visitParts = [];
      const visit24 = visitLine(worldVisit, "Visits 24h");
      const visit7 = visitLine(worldVisit, "Visits 7d");
      const visit30 = visitLine(worldVisit, "Visits 30d");

      if (visit24) visitParts.push(`Last 24 hours: ${visit24}`);
      if (visit7) visitParts.push(`Last 7 days: ${visit7}`);
      if (visit30) visitParts.push(`Last 30 days: ${visit30}`);

      const populationParts = [`👥 Total: ${total}`];

      // Hide a zero Public or Private value instead of displaying "0".
      if (Number.isFinite(pub) && pub > 0) {
        populationParts.push(`🌐 Public: ${pub}`);
      }
      if (Number.isFinite(priv) && priv > 0) {
        populationParts.push(`🔒 Private: ${priv}`);
      }

      const visitText = visitParts.length
        ? `\\n📈 ${visitParts.join(" · ")}`
        : "";

      return `**${label}**\\n${populationParts.join(" · ")}${visitText}`;
    })
    .filter(Boolean);

  const availablePopulations = populations.filter(
    (p) =>
      p &&
      Number.isFinite(Number(p.total)) &&
      Number(p.total) >= 0 &&
      Number.isFinite(Number(p.public)) &&
      Number.isFinite(Number(p.private))
  );

  // Island population is the combined total of all linked VRChat worlds.
  const islandTotal = availablePopulations.reduce(
    (sum, p) => sum + Number(p.total),
    0
  );
  const islandPublic = availablePopulations.reduce(
    (sum, p) => sum + Number(p.public),
    0
  );
  const islandPrivate = availablePopulations.reduce(
    (sum, p) => sum + Number(p.private),
    0
  );

  const populationSummaryParts = [`**Island total: ${islandTotal}**`];

  // Hide Public/Private when their combined value is zero.
  if (islandPublic > 0) {
    populationSummaryParts.push(`🌐 Public: ${islandPublic}`);
  }
  if (islandPrivate > 0) {
    populationSummaryParts.push(`🔒 Private: ${islandPrivate}`);
  }

  const populationSummary = availablePopulations.length
    ? populationSummaryParts.join(" · ") +
      (availablePopulations.length < ids.length
        ? `\\n⚠️ Only ${availablePopulations.length} of ${ids.length} worlds returned usable data.`
        : "")
    : "Population data unavailable";

  const islandVisits = islandVisitRows.find(
    (r) => String(r["Island ID"]) === String(isl.ID)
  );

  const islandVisitParts = [];
  const island24 = visitLine(islandVisits, "Visits 24h");
  const island7 = visitLine(islandVisits, "Visits 7d");
  const island30 = visitLine(islandVisits, "Visits 30d");

  if (island24) islandVisitParts.push(`Last 24 hours: ${island24}`);
  if (island7) islandVisitParts.push(`Last 7 days: ${island7}`);
  if (island30) islandVisitParts.push(`Last 30 days: ${island30}`);

  const flagNum = [
    isl.Flag,
    ...[isl.Group1, isl.Group2, isl.Group3].map(
      (id) => groups.find((g) => g.ID === id)?.Flag
    ),
  ]
    .map((x) => parseInt(x, 10))
    .find((n) => n >= 0);

  const since = sinceRows.find(
    (r) => r["Island Name"] === isl["Island Name"]
  );

  const sinceLine =
    since && isl.Unknown !== "1" && since.Since
      ? `${isl.Unowned === "1" ? "Unowned" : "Same owner"} since ${sinceText(
          since.Since,
          since.AtLeast === "1"
        )}`
      : "";

  const status =
    isl.Unknown === "1"
      ? "❓ Unknown island"
      : isl.Unowned === "1"
        ? "⚪ Unowned"
        : "Owned";

  const color =
    parseInt((isl.Color.split(/\\s+/)[0] || "#005aff").replace("#", ""), 16) ||
    0x005aff;

  const ownerLinks = await getOwnerLinks();
  const rawOwner = (isl.Owner || "").trim();
  const ownerData = ownerLinks[rawOwner.toLowerCase()] || {};

  let ownerDisplay = rawOwner || "—";

  if (rawOwner && rawOwner !== "—" && rawOwner !== "Unowned") {
    if (ownerData.link && ownerData.discord) {
      ownerDisplay = `[${rawOwner}](${ownerData.link}) (@${ownerData.discord})`;
    } else if (ownerData.link) {
      ownerDisplay = `[${rawOwner}](${ownerData.link})`;
    } else if (ownerData.discord) {
      ownerDisplay = `${rawOwner} (@${ownerData.discord})`;
    }
  }

  const firstGroupId = [isl.Group1, isl.Group2, isl.Group3]
    .find((id) => id && id !== "0");

  const firstGroup = firstGroupId
    ? groups.find((g) => g.ID === firstGroupId)?.Group
    : "";

  const gifSlug = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown";

  const gifUrl =
    `${IMG_TEST}/islandgifs/current/${gifSlug(firstGroup || "unowned")}/${gifSlug(isl["Island Name"])}.gif?v=${stamp()}`;

  const fields = [
    { name: "Status", value: status, inline: true },
    { name: "Owner", value: ownerDisplay, inline: true },
    { name: "Group", value: groupNames.join(", ") || "—", inline: true },
    ...(sinceLine ? [{ name: "Control", value: sinceLine }] : []),
    {
      name: "VRChat worlds",
      value: links.join("\\n") || "No world link yet",
    },
    {
      name: "👥 Current Players",
      value: populationSummary,
    },
    ...(populationLines.length
      ? [{
          name: "🌐 Individual World Populations",
          value: populationLines.join("\\n\\n").slice(0, 1024),
        }]
      : []),
  ];

  if (islandVisitParts.length) {
    fields.push({
      name: "📈 Island Visits",
      value: islandVisitParts.join("\\n"),
    });
  }

  const civilianRows = await tsv("civilians.tsv").catch(() => []);
  const hasCivilians = civilianRows.some(row => String(row.Island || "").trim().toLowerCase() === islandDisplayName(isl).toLowerCase());

  return {
    embeds: [
      {
        title: islandDisplayName(isl),
        url: BASE + "/",
        color,
        fields,
        ...(flagNum !== undefined
          ? { thumbnail: { url: flagUrl(flagNum) } }
          : {}),
        image: {
          url: gifUrl,
        },
      },
    ],
    ...(hasCivilians ? { components: [{ type: 1, components: [{ type: 2, style: 2, label: "Open civilian list", custom_id: "civilians_" + isl.ID }] }] } : {}),
  };
}

// ---------- groups ----------
async function groupData(g) {
  if (g.islands === 0) {
    return mapMessage(ALL_OFF, { description: `⚠️ **${g.name}** has no islands right now.`, thumbnail: flagUrl(g.flag) });
  }
  return mapMessage(ALL_OFF, {
    title: `${g.name} — ${g.islands} island${g.islands === 1 ? "" : "s"}`,
    description: "Only this group's islands are shown. Tap a button to show a type of island, or Reset for the full map.",
    image: `${IMG}/groups/${g.id}.jpg?v=${stamp()}`,
    thumbnail: flagUrl(g.flag),
  });
}

async function groupChoices(query) {
  const q = query.toLowerCase();
  const groups = await getGroups();
  return groups
    .filter((g) => g.name.toLowerCase().includes(q))
    .sort((a, b) => b.islands - a.islands)
    .slice(0, 25)
    .map((g) => ({ name: `${g.name} (${g.islands})`.slice(0, 100), value: g.id }));
}

// ---------- /googlesheet ----------
const SHEET_OWNERS = "https://docs.google.com/spreadsheets/d/14I31HO_9qbplW8LWP63-itFL1eAjL0O-ecEAxxCOJpM/";
const SHEET_CREWS = "https://docs.google.com/spreadsheets/d/1IcCHc-ERXwUGyJmyDChw5MXwShDeGDNqkCr7fIafoDk/";
const SHEET_PAGE = 20;
const esc = (t) => String(t).replace(/([*_~`|>\\])/g, "\\$1");

async function sheetPage(kind, page) {
  let title, rows;
  if (kind === "c") {
    title = "Crews and how many islands they own";
    rows = (await tsv("island-groups.tsv")).map((g) => `• **${esc(g.Group)}** — ${g.Islands} island${g.Islands === "1" ? "" : "s"}`);
  } else {
    title = "Islands and owners";
    rows = (await tsv("island-colors.tsv"))
      .filter((r) => r.Unknown !== "1")
      .map((r) => `• **${esc(islandDisplayName(r))}** — ${r.Unowned === "1" ? "Unowned" : esc(r.Owner || "—")}`);
  }
  const pages = Math.max(1, Math.ceil(rows.length / SHEET_PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const updated = await lastUpdated();
  return {
    embeds: [
      {
        title,
        description:
          rows.slice(p * SHEET_PAGE, (p + 1) * SHEET_PAGE).join("\n") +
          `\n\nOriginal sheets: [Owners](${SHEET_OWNERS}) · [Crews](${SHEET_CREWS})`,
        color: 0x005aff,
        footer: { text: `Page ${p + 1} of ${pages} · copied from the sheets every few hours, so check the sheet if in doubt` },
        ...(updated ? { timestamp: updated } : {}),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "◀ Back", custom_id: `gs_${kind}_${p - 1}`, disabled: p === 0 },
          { type: 2, style: 1, label: "Next ▶", custom_id: `gs_${kind}_${p + 1}`, disabled: p >= pages - 1 },
          { type: 2, style: 5, label: "Owners sheet", url: SHEET_OWNERS },
          { type: 2, style: 5, label: "Crews sheet", url: SHEET_CREWS },
        ],
      },
    ],
  };
}

const discordEmbedColor = value => {
  const match = String(value || "").match(/^#?([0-9a-f]{6})$/i);
  return match ? parseInt(match[1], 16) : 0x005aff;
};

// Distinct Discord header colors for each crew. World Government uses a deep navy.
function crewInfoColor(name, fallback) {
  const key = String(name || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
  const colors = {
    worldgovernment: "#10264f",
    marines: "#1676d2",
    revolutionaryarmy: "#b52b3a",
    rockspirates: "#30343b",
    starpirates: "#7046a8",
    thrillerbarkpirates: "#573b75",
    vaelpirates: "#167d78",
    rogerpirates: "#b58a32",
    tazmanianpirates: "#c56b2b",
    bloodsailpirates: "#8f2638",
    frostbitepirates: "#4d9bb8",
    infamousstrawhatpirates: "#d18b25",
    moonlightpirates: "#667b9a",
    requiempirates: "#49305f",
    strawhats: "#c64236",
    unknownpirates: "#59636f",
    olympuspirates: "#6f8d45",
    yingyongpirates: "#887b57",
    akazayapirates: "#a34835",
    donquixotepirates: "#a52b50"
  };
  return discordEmbedColor(colors[key] || fallback);
}

// ---------- /crewlist pagination ----------
const CREW_PAGE_SIZE = 10;
const CREW_SORTS = [["islands","Island count"],["az","A–Z"],["za","Z–A"],["vrchatMembers","VRChat members"],["vrchatOnline","VRChat online"],["discordMembers","Discord members"],["growth","Visit growth (7 days)"]];
async function crewListPage(page, sortBy = "islands") {
  const groups = await getGroups();
  const sortKey = CREW_SORTS.some(([key]) => key === sortBy) ? sortBy : "islands";
  let growthByName = new Map();
  if (sortKey === "growth") {
    try { const activity = await buildWorldActivity("7d"); growthByName = new Map((activity.crewGrowth || []).map(row => [row.name.toLowerCase(), row.gained])); } catch {}
  }
  const valueOf = g => {
    if (sortKey === "islands") return Number(g.islands);
    if (sortKey === "vrchatMembers") return g.vrchatMembers.trim() === "" ? null : Number(g.vrchatMembers);
    if (sortKey === "vrchatOnline") return g.vrchatOnline.trim() === "" ? null : Number(g.vrchatOnline);
    if (sortKey === "discordMembers") return g.discordMembers.trim() === "" ? null : Number(g.discordMembers);
    if (sortKey === "growth") return growthByName.has(g.name.toLowerCase()) ? growthByName.get(g.name.toLowerCase()) : null;
    return null;
  };
  groups.sort((a,b) => {
    if (sortKey === "az") return a.name.localeCompare(b.name);
    if (sortKey === "za") return b.name.localeCompare(a.name);
    const av=valueOf(a), bv=valueOf(b);
    if (av===null && bv===null) return a.name.localeCompare(b.name);
    if (av===null) return 1; if (bv===null) return -1; return bv-av;
  });
  const pages=Math.max(1,Math.ceil(groups.length/CREW_PAGE_SIZE)), p=Math.min(Math.max(page,0),pages-1);
  const slice=groups.slice(p*CREW_PAGE_SIZE,(p+1)*CREW_PAGE_SIZE);
  const fmt=v=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?null:Number(v).toLocaleString("en-US");
  const embeds=slice.map(g=>{
    const growth=growthByName.has(g.name.toLowerCase())?growthByName.get(g.name.toLowerCase()):null;
    const links=[];
    if(g.vrchatGroupUrl) links.push("[VRChat group]("+g.vrchatGroupUrl+")");
    if(g.discordInvite) links.push("[Discord invite]("+g.discordInvite+")");
    const image=g.flagUrl||flagUrl(g.flag);
    const fields=[{name:"Islands",value:String(g.islands),inline:true}];
    const optionalFields=[
      ["VRChat members",fmt(g.vrchatMembers)],
      ["VRChat online",fmt(g.vrchatOnline)],
      ["Discord members",fmt(g.discordMembers)],
      ["Visit growth (7 days)",fmt(growth)]
    ];
    for(const [name,value] of optionalFields) if(value!==null) fields.push({name,value,inline:true});
    return {title:g.name,...(links.length?{description:links.join(" · ")}:{}),color:discordEmbedColor(g.mapColor),fields,...(image?{thumbnail:{url:image}}:{})};
  });
  return {embeds,components:[
    {type:1,components:[{type:3,custom_id:`cls_${sortKey}_${p}`,placeholder:"Sort crews by…",options:CREW_SORTS.map(([value,label])=>({label,value,default:value===sortKey}))}]},
    {type:1,components:[
      {type:2,style:2,label:"◀ Back",custom_id:`cl_${sortKey}_${p-1}`,disabled:p===0},
      {type:2,style:1,label:"Next ▶",custom_id:`cl_${sortKey}_${p+1}`,disabled:p>=pages-1}
    ]}
  ]};
}
// ---------- restricted commands: /addcrew and /editcrew ----------
// Secrets needed: ADMIN_IDS (Discord user IDs, separated by commas), GITHUB_TOKEN,
// GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (from the Google service account), DISCORD_APP_ID.
const REPO_API = "https://api.github.com/repos/eyeonspyweezer/opvrcinteractivemap";
const FLAG_RAW = "https://raw.githubusercontent.com/eyeonspyweezer/opvrcinteractivemap/main/crewflags";
const CREW_SHEET_ID = "1IcCHc-ERXwUGyJmyDChw5MXwShDeGDNqkCr7fIafoDk";
const NATION_HEADERS = ["crews/groups", "nations", "nation"];
const FLAG_HEADERS = ["flag", "flag url"];
const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_FLAG_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const userId = (i) => i.member?.user?.id || i.user?.id || "";
const isAdmin = (env, i) => String(env.ADMIN_IDS || "").split(/[\s,]+/).filter(Boolean).includes(userId(i));
const notAllowed = (i) => ({
  type: 4,
  data: {
    flags: 64,
    content:
      "🔒 **Restricted command.** Only approved map editors can use this command.\n" +
      `If you should have access, send the map owner this number: \`${userId(i)}\``,
  },
});

const normName = (s) => String(s || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "crew";

function need(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Setup is missing in Cloudflare: ${missing.join(", ")}`);
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function googleToken(env) {
  need(env, ["GOOGLE_SA_EMAIL", "GOOGLE_SA_KEY"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const unsigned =
    b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." +
    b64url(enc.encode(JSON.stringify({
      iss: env.GOOGLE_SA_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })));
  const pem = env.GOOGLE_SA_KEY.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  if (!r.ok) throw new Error(`Google login failed (${r.status}). Check the service account secrets.`);
  return (await r.json()).access_token;
}

async function sheetsApi(token, path, init = {}) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CREW_SHEET_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const why = r.status === 403 ? " The sheet has not been shared with the bot's Google account as Editor." : "";
    throw new Error(`Google Sheets said ${r.status}.${why}`);
  }
  return r.json();
}

async function crewSheet(token) {
  const meta = await sheetsApi(token, "?fields=sheets.properties(title,sheetId)");
  const tab = meta.sheets.find((s) => s.properties.sheetId === 0) || meta.sheets[0];
  const title = tab.properties.title;
  const data = await sheetsApi(token, `/values/${encodeURIComponent(`'${title}'!A1:Z2000`)}`);
  const rows = data.values || [];
  const header = rows.findIndex((r) => NATION_HEADERS.includes(String(r[0] || "").trim().toLowerCase()));
  if (header < 0) throw new Error("I couldn't find the 'Crews/Groups' header row in the crews sheet.");
  const flagCol = rows[header].findIndex((c) => FLAG_HEADERS.includes(String(c || "").trim().toLowerCase()));
  if (flagCol < 0) throw new Error("The crews sheet has no column titled 'Flag' in its header row. Add one first.");
  return { title, rows, header, flagCol };
}

const colLetter = (n) => {
  let s = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

const findCrewRow = (sheet, name) =>
  sheet.rows.findIndex((r, idx) => idx > sheet.header && normName(r[0]) === normName(name) && normName(r[0]) !== "");

async function setCell(token, sheet, rowIndex, colIndex, value) {
  const range = encodeURIComponent(`'${sheet.title}'!${colLetter(colIndex)}${rowIndex + 1}`);
  await sheetsApi(token, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [[value]] }),
  });
}


async function uploadFlag(env, source, crewName) {
  need(env, ["GITHUB_TOKEN"]);

  const attachment = typeof source === "object" ? source : null;
  const url = attachment?.url || source;

  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("Please upload an image or provide a valid image URL.");
  }

  const img = await fetch(url);
  if (!img.ok) {
    throw new Error("I couldn't download that image. Try uploading the file directly instead.");
  }

  const responseType = (img.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const attachmentType = (attachment?.content_type || "").toLowerCase();

  const sourceContentType = responseType.startsWith("image/")
    ? responseType
    : attachmentType;

  let sourceExt = EXT_BY_TYPE[sourceContentType];

  // Fall back to the uploaded filename or URL extension.
  if (!sourceExt) {
    const filename = attachment?.filename || new URL(url).pathname;
    const match = filename.match(/\.(png|jpe?g|webp|gif)$/i);

    if (match) {
      sourceExt = match[1].toLowerCase();
      if (sourceExt === "jpeg") sourceExt = "jpg";
    }
  }

  if (!sourceExt) {
    throw new Error("Unsupported image. Use PNG, JPG, WEBP, or GIF.");
  }

  const bytes = new Uint8Array(await img.arrayBuffer());

  if (!bytes.length) {
    throw new Error("The image file is empty.");
  }

  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new Error("That image is over 20 MB. Please upload a smaller image.");
  }

  if (!env.IMAGES) {
    throw new Error("Automatic image resizing is not configured. Please contact the map owner.");
  }

  let optimized = await env.IMAGES.input(bytes)
    .transform({ width: 1024, height: 1024, fit: "scale-down" })
    .output({ format: "image/webp", quality: 82, anim: true });

  let optimizedResponse = optimized.response();
  let finalBytes = new Uint8Array(await optimizedResponse.arrayBuffer());

  if (finalBytes.length > MAX_FLAG_BYTES) {
    optimized = await env.IMAGES.input(bytes)
      .transform({ width: 768, height: 768, fit: "scale-down" })
      .output({ format: "image/webp", quality: 65, anim: true });

    optimizedResponse = optimized.response();
    finalBytes = new Uint8Array(await optimizedResponse.arrayBuffer());
  }

  if (finalBytes.length > MAX_FLAG_BYTES) {
    throw new Error("This image could not be compressed below 1 MB.");
  }

  const ext = "webp";

  let binary = "";
  for (let k = 0; k < finalBytes.length; k += 8192) {
    binary += String.fromCharCode(...finalBytes.subarray(k, k + 8192));
  }

  const path = `crewflags/${slugOf(crewName)}.${ext}`;

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "opvrc-map-bot",
    Accept: "application/vnd.github+json"
  };

  const cur = await fetch(`${REPO_API}/contents/${path}?ref=main`, { headers });
  const sha = cur.ok ? (await cur.json()).sha : undefined;

  const put = await fetch(`${REPO_API}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Flag for ${crewName}`,
      content: btoa(binary),
      branch: "main",
      ...(sha ? { sha } : {})
    })
  });

  if (!put.ok) {
    throw new Error(`GitHub said ${put.status} when saving the flag.`);
  }

  return `${FLAG_RAW}/${slugOf(crewName)}.${ext}`;
}


const optionOf = (i, name) => i.data.options?.find((o) => o.name === name)?.value;
const attachmentOf = (i, name) => {
  const id = optionOf(i, name);
  return id ? i.data.resolved?.attachments?.[id] : undefined;
};

async function addCrew(env, i) {
  const name = String(optionOf(i, "name") || "").trim();
  const inputUrl = String(optionOf(i, "flag_url") || "").trim();
  const inputFile = attachmentOf(i, "flag_file");

  if (!name) throw new Error("Type the crew name.");

  const flagSource = inputFile || inputUrl;

  if (!flagSource) {
    throw new Error("Please provide either a flag image URL or upload an image file.");
  }

  const token = await googleToken(env);
  const sheet = await crewSheet(token);

  if (findCrewRow(sheet, name) >= 0) {
    throw new Error(`"${name}" is already in the sheet. Use /editcrew to update it.`);
  }

  const flagUrl = await uploadFlag(env, flagSource, name);

  const row = [];
  row[0] = name;
  row[sheet.flagCol] = flagUrl;

  await sheetsApi(
    token,
    `/values/${encodeURIComponent(`'${sheet.title}'!A:A`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: [Array.from(row, (v) => v ?? "")] })
    }
  );

  return {
    content: `✅ Added **${name}** to the sheet with its flag.`,
    embeds: [{ thumbnail: { url: flagUrl }, description: `Flag stored at: ${flagUrl}` }]
  };
}

async function editCrew(env, i) {
  const crew = String(optionOf(i, "crew") || "").trim();
  const newName = String(optionOf(i, "new_name") || "").trim();
  const newFlagUrlInput = String(optionOf(i, "new_flag_url") || "").trim();
  const newFlagFile = attachmentOf(i, "new_flag_file");

  if (!newName && !newFlagUrlInput && !newFlagFile) {
    throw new Error("Please provide a new name, a flag URL, or an uploaded flag image.");
  }

  const token = await googleToken(env);
  const sheet = await crewSheet(token);
  const rowIndex = findCrewRow(sheet, crew);

  if (rowIndex < 0) {
    throw new Error(`I couldn't find a crew named "${crew}".`);
  }

  const oldName = String(sheet.rows[rowIndex][0]);

  let statusMsg = `✅ Edits applied to **${oldName}**: `;
  let embedData = [];

  // Edit Name if provided.
  if (newName) {
    if (normName(newName) !== normName(oldName) && findCrewRow(sheet, newName) >= 0) {
      throw new Error(`"${newName}" already exists.`);
    }

    await setCell(token, sheet, rowIndex, 0, newName);
    statusMsg += `Renamed to **${newName}**. `;
  }

  // Edit Flag if provided.
  const flagSource = newFlagFile || newFlagUrlInput;

  if (flagSource) {
    const finalFlagUrl = await uploadFlag(env, flagSource, newName || oldName);

    await setCell(token, sheet, rowIndex, sheet.flagCol, finalFlagUrl);

    statusMsg += "Updated flag picture.";

    embedData.push({
      thumbnail: { url: finalFlagUrl },
      description: `Flag URL: ${finalFlagUrl}`
    });
  }

  return { content: statusMsg, embeds: embedData };
}

async function runCrewCommand(env, i) {
  let message;
  try {
    message = i.data.name === "addcrew" ? await addCrew(env, i) : await editCrew(env, i);
  } catch (e) {
    message = { content: `❌ ${e.message}` };
  }
  await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

async function crewNameChoices(query) {
  const q = query.toLowerCase();
  try {
    // Fetch directly from GitHub raw TSV for instant autocomplete speed
    const txt = await (await fetch(BASE + "/island-groups.tsv", { cf: { cacheTtl: 300 } })).text();
    const [head, ...rows] = txt.trim().split(/\r?\n/);
    const cols = head.split("\t");
    const groups = rows.map((line) => {
      const v = line.split("\t");
      return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    });

    return groups
      .filter((g) => (g.Group || "").toLowerCase().includes(q))
      .slice(0, 25)
      .map((g) => ({ name: (g.Group || "").slice(0, 100), value: (g.Group || "").slice(0, 100) }));
  } catch {
    return [];
  }
}


/* ---------- Discord Add to Schedule ---------- */
// Only messages with an explicit date clue are eligible. The user always sees
// a preview and must confirm before anything is saved.
const SCHEDULE_FILE = "scheduled-events.txt";
const SCHEDULE_ARCHIVE_FILE = "scheduled-events-archive.txt";
const SCHEDULE_REMINDERS_FILE = "schedule-reminders.json";

function parseScheduleMessage(message) {
  const content = String(message.content || "").trim();
  if (!content) return null;
  const anchor = new Date(message.timestamp || Date.now());
  if (Number.isNaN(anchor.getTime())) return null;
  const text = content.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, ts) => new Date(Number(ts) * 1000).toISOString());
  let date = null;
  let dateHint = "";

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const monthDay = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i);
  const relative = text.match(/\b(?:in|after)\s+(\d{1,3})\s+(days?|weeks?)\b|\b(\d{1,3})\s+(days?|weeks?)\s+from\s+now\b/i);
  const relativeTomorrow = /\btomorrow\b/i.test(text);
  const relativeToday = /\btoday\b/i.test(text);
  const weekday = text.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);

  if (iso) {
    date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    dateHint = iso[0];
  } else if (monthDay) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const m = months.findIndex(x => x === monthDay[1].slice(0,3).toLowerCase());
    let year = Number(monthDay[3] || anchor.getUTCFullYear());
    date = new Date(Date.UTC(year, m, Number(monthDay[2])));
    if (date.getUTCMonth() !== m || date.getUTCDate() !== Number(monthDay[2])) return null;
    if (!monthDay[3] && date.getTime() < Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate())) {
      date = new Date(Date.UTC(year + 1, m, Number(monthDay[2])));
    }
    dateHint = monthDay[0];
  } else if (relative) {
    const amountValue = relative[1] || relative[3];
    const unitValue = relative[2] || relative[4];
    const amount = Number(amountValue) * (/weeks?/i.test(unitValue) ? 7 : 1);
    date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + amount));
    dateHint = relative[0];
  } else if (relativeTomorrow || relativeToday) {
    date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + (relativeTomorrow ? 1 : 0)));
    dateHint = relativeTomorrow ? "tomorrow" : "today";
  } else if (weekday) {
    const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const target = days.indexOf(weekday[2].toLowerCase());
    let delta = (target - anchor.getUTCDay() + 7) % 7;
    if (delta === 0 || weekday[1]) delta += 7;
    date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + delta));
    dateHint = weekday[0];
  } else {
    return null;
  }

  if (!date || Number.isNaN(date.getTime())) return null;
  if (iso && (date.getUTCFullYear() !== Number(iso[1]) || date.getUTCMonth() + 1 !== Number(iso[2]) || date.getUTCDate() !== Number(iso[3]))) return null;
  const timeMatch = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i) ||
    text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  let hour = 0, minute = 0, hasTime = false;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] || 0);
    if (timeMatch[3]) {
      const pm = /^p/i.test(timeMatch[3]);
      hour = (hour % 12) + (pm ? 12 : 0);
    }
    hasTime = true;
  } else if (/\b(noon)\b/i.test(text)) {
    hour = 12; hasTime = true;
  } else if (/\b(midnight)\b/i.test(text)) {
    hour = 0; hasTime = true;
  }
  const startsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute));
  const endsAt = new Date(startsAt.getTime() + (hasTime ? 2 * 3600000 : 86400000));
  if (endsAt.getTime() <= Date.now()) return null;
  const firstLine = content.split(/\r?\n/).map(x => x.trim()).find(Boolean) || "Scheduled event";
  const title = firstLine.replace(/^[-*#>\s]+/, "").slice(0, 120) || "Scheduled event";
  return {
    title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    allDay: !hasTime,
    dateHint,
    timeHint: hasTime ? timeMatch?.[0] || (/noon/i.test(text) ? "noon" : "midnight") : "No time stated",
    author: message.author?.global_name || message.member?.nick || message.author?.username || "Unknown author",
    sourceMessageUrl: `https://discord.com/channels/${message.guild_id || "@me"}/${message.channel_id}/${message.id}`,
    sourceMessageId: message.id,
    sourceChannelId: message.channel_id,
    createdAt: anchor.toISOString(),
    status: "upcoming",
    detectedAt: new Date().toISOString()
  };
}

function githubTextEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

async function readScheduleFile(env, path) {
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "opvrc-map-bot", Accept: "application/vnd.github+json" };
  const response = await fetch(`${REPO_API}/contents/${path}?ref=main`, { headers });
  if (response.status === 404) return { items: [], sha: null };
  if (!response.ok) throw new Error(`Could not read ${path} from GitHub (${response.status}).`);
  const data = await response.json();
  const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), c => c.charCodeAt(0));
  return { items: JSON.parse(new TextDecoder().decode(bytes)), sha: data.sha };
}

async function writeScheduleFile(env, path, items, sha, message) {
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "opvrc-map-bot", Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  const response = await fetch(`${REPO_API}/contents/${path}`, {
    method: "PUT", headers,
    body: JSON.stringify({ message, content: githubTextEncode(JSON.stringify(items, null, 2) + "\n"), branch: "main", ...(sha ? { sha } : {}) })
  });
  if (!response.ok) throw new Error(`Could not save ${path} to GitHub (${response.status}).`);
}

async function confirmScheduleMessage(env, interaction) {
  const parts = String(interaction.data.custom_id || "").split("_");
  const channelId = parts[2], messageId = parts[3];
  if (!channelId || !messageId) return { type: 4, data: { flags: 64, content: "This schedule confirmation is invalid. Please run Add to Schedule again." } };
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }
  });
  if (!response.ok) return { type: 4, data: { flags: 64, content: "I couldn't retrieve the original message. Make sure the bot can read that channel, then try again." } };
  const message = await response.json();
  message.channel_id = channelId;
  message.guild_id = interaction.guild_id || null;
  const event = parseScheduleMessage(message);
  if (!event) return { type: 4, data: { flags: 64, content: "I couldn't find a clear date clue in that message. Nothing was saved." } };
  need(env, ["GITHUB_TOKEN"]);
  const current = await readScheduleFile(env, SCHEDULE_FILE);
  if (current.items.some(item => item.sourceMessageId === event.sourceMessageId)) {
    return { type: 4, data: { flags: 64, content: "That message is already in the schedule." } };
  }
  current.items.push(event);
  await writeScheduleFile(env, SCHEDULE_FILE, current.items, current.sha, "Add scheduled event from Discord");
  return { type: 7, data: { content: `✅ Added **${event.title}** to the schedule.\n**When (UTC):** ${event.startsAt}\n**From:** ${event.author}\n[Original message](${event.sourceMessageUrl})`, components: [] } };
}

async function archiveExpiredScheduleEvents(env) {
  need(env, ["GITHUB_TOKEN"]);
  const [upcoming, archived] = await Promise.all([
    readScheduleFile(env, SCHEDULE_FILE),
    readScheduleFile(env, SCHEDULE_ARCHIVE_FILE)
  ]);
  const now = Date.now();
  const expired = upcoming.items.filter(item => Date.parse(item.endsAt) <= now);
  if (!expired.length) return;
  const remaining = upcoming.items.filter(item => Date.parse(item.endsAt) > now);
  const archiveIds = new Set(archived.items.map(item => item.sourceMessageId));
  const newArchive = expired.filter(item => !archiveIds.has(item.sourceMessageId)).map(item => ({ ...item, status: "archived", archivedAt: new Date().toISOString() }));
  // Archive first: if the second write fails, the next cron run can safely
  // retry removal without losing the event from both files.
  await writeScheduleFile(env, SCHEDULE_ARCHIVE_FILE, [...archived.items, ...newArchive], archived.sha, "Archive expired scheduled events");
  await writeScheduleFile(env, SCHEDULE_FILE, remaining, upcoming.sha, "Remove expired scheduled events");
}

const QUOTES_FILE = "quotes.txt";

async function readQuotesFile(env) {
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "opvrc-map-bot", Accept: "application/vnd.github+json" };
  const response = await fetch(`${REPO_API}/contents/${QUOTES_FILE}?ref=main`, { headers });
  if (response.status === 404) return { text: "", sha: null };
  if (!response.ok) throw new Error(`Could not read ${QUOTES_FILE} from GitHub (${response.status}).`);
  const data = await response.json();
  const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), c => c.charCodeAt(0));
  return { text: new TextDecoder().decode(bytes), sha: data.sha };
}

async function writeQuotesFile(env, text, sha, message) {
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "opvrc-map-bot", Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  const response = await fetch(`${REPO_API}/contents/${QUOTES_FILE}`, {
    method: "PUT", headers,
    body: JSON.stringify({ message, content: githubTextEncode(text.endsWith("\n") ? text : text + "\n"), branch: "main", ...(sha ? { sha } : {}) })
  });
  if (!response.ok) throw new Error(`Could not save ${QUOTES_FILE} to GitHub (${response.status}).`);
}

function quoteTsvLine(quote, displayName, username, messageId, messageUrl, addedAt) {
  const clean = value => String(value || "").replace(/[\\r\\n\\t]+/g, " ").trim();
  return [clean(quote), clean(displayName), clean(username), clean(messageId), clean(messageUrl), clean(addedAt)].join("\\t");
}

async function addQuoteFromMessage(env, interaction) {
  const message = interaction.data.resolved?.messages?.[interaction.data.target_id];
  const quote = String(message?.content || "").trim();
  if (!message || !quote) {
    return { type: 4, data: { flags: 64, content: "I couldn't find text in that message to save as a quote." } };
  }
  if (quote.length > 500) {
    return { type: 4, data: { flags: 64, content: "That message is over 500 characters. Shorten it before adding it as a quote." } };
  }
  need(env, ["GITHUB_TOKEN"]);
  const current = await readQuotesFile(env);
  const lines = current.text.split(/\\r?\\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
  const normalized = quote.toLowerCase().replace(/\\s+/g, " ").trim();
  if (lines.some(line => line.split("\\t")[0].toLowerCase().replace(/\\s+/g, " ").trim() === normalized)) {
    return { type: 4, data: { flags: 64, content: "That quote is already in the quote list." } };
  }
  const displayName = message.author?.global_name || message.member?.nick || message.author?.username || "Unknown";
  const username = message.author?.username || "";
  const messageUrl = `https://discord.com/channels/${interaction.guild_id || "@me"}/${interaction.channel_id}/${message.id}`;
  const addedAt = message.timestamp || new Date().toISOString();
  const newText = (current.text.trimEnd() ? current.text.trimEnd() + "\\n" : "") + quoteTsvLine(quote, displayName, username, message.id, messageUrl, addedAt) + "\\n";
  await writeQuotesFile(env, newText, current.sha, "Add quote from Discord message");
  return { type: 4, data: { flags: 64, content: "✅ Added quote by **" + displayName + "** (@" + username + ").\\n[Open original Discord message](" + messageUrl + ")" } };
}

const VIDEO_FILE = "opvrc-videos.json";

async function eventsListMessage(env) {
  const [stored, videos] = await Promise.all([
    readScheduleFile(env, SCHEDULE_FILE),
    readScheduleFile(env, VIDEO_FILE)
  ]);
  const now = Date.now();
  const messages = stored.items
    .filter(event => Number.isFinite(Date.parse(event.startsAt)) && Date.parse(event.endsAt) > now)
    .map(event => ({ ...event, type: "message", sortAt: Date.parse(event.startsAt) }));
  const videoItems = videos.items
    .filter(video => video.url)
    .map(video => ({ ...video, type: "video", sortAt: Date.parse(video.publishedAt || video.addedAt || video.createdAt) || 0 }));
  const items = [...messages, ...videoItems].sort((a,b) => b.sortAt-a.sortAt);
  if (!items.length) return { content: "There are no OPVRC events or videos saved yet. Use **Add to Schedule** for dated messages or **Add to Video List** on a message containing video links or attachments." };
  const lines = items.slice(0, 20).map((item,index) => {
    if (item.type === "video") {
      const date = item.publishedAt || item.addedAt || item.createdAt;
      const when = date && Number.isFinite(Date.parse(date)) ? new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeZone:"UTC"}).format(new Date(date)) : "Date unknown";
      const source = item.sourceMessageUrl ? ` · [Discord source](${item.sourceMessageUrl})` : "";
      return `**[VIDEO] ${index+1}. ${String(item.title || "Untitled video").slice(0,120)}** — ${when} UTC\n${String(item.platform || "Video").slice(0,30)} · [Watch video](${item.url})${source}`;
    }
    const date = new Date(item.startsAt);
    const when = new Intl.DateTimeFormat("en-US", item.allDay ? {dateStyle:"medium",timeZone:"UTC"} : {dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(date);
    const source = item.sourceMessageUrl ? ` · [source](${item.sourceMessageUrl})` : "";
    return `**[MESSAGE] ${index+1}. ${String(item.title || "Scheduled event").slice(0,120)}** — ${when} UTC\nBy ${String(item.author || "Unknown author").slice(0,80)}${source}`;
  });
  return { embeds:[{title:"OPVRC Events",description:lines.join("\n\n").slice(0,3900),color:0x005aff,footer:{text:`${messages.length} message events · ${videoItems.length} videos · newest first`},timestamp:new Date().toISOString()}] };
}


async function scheduleRemindersCommand(env, interaction) {
  need(env, ["GITHUB_TOKEN"]);
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (!userId) return { content: "I couldn't identify your Discord account.", flags: 64 };

  const stored = await readScheduleFile(env, SCHEDULE_REMINDERS_FILE);
  const enabledOption = interaction.data.options?.find(option => option.name === "enabled");
  const timingOption = interaction.data.options?.find(option => option.name === "timing");
  let preference = stored.items.find(item => item.userId === userId);

  if (!preference) {
    preference = { userId, enabled: true, leadMinutes: 0, sent: [] };
    stored.items.push(preference);
  }
  if (enabledOption) preference.enabled = Boolean(enabledOption.value);
  if (timingOption) {
    const timing = String(timingOption.value);
    const allowed = { "0": 0, "5m": 5, "30m": 30, "1h": 60, "1d": 1440 };
    if (!(timing in allowed)) return { content: "That reminder timing isn't supported.", flags: 64 };
    preference.leadMinutes = allowed[timing];
  }
  preference.updatedAt = new Date().toISOString();
  await writeScheduleFile(env, SCHEDULE_REMINDERS_FILE, stored.items, stored.sha, "Update personal schedule reminder preferences");

  const timingLabels = { 0: "at the event start time", 5: "5 minutes before", 30: "30 minutes before", 60: "1 hour before", 1440: "1 day before" };
  return {
    content: preference.enabled
      ? `🔔 Your personal event reminders are **on**. You'll be reminded ${timingLabels[preference.leadMinutes] || "at the event start time"}. Use /reminders enabled:false to turn them off.`
      : "🔕 Your personal event reminders are **off**. The shared schedule is unchanged.",
    flags: 64
  };
}

async function sendDueScheduleReminders(env) {
  need(env, ["GITHUB_TOKEN", "DISCORD_TOKEN"]);
  const [events, preferences] = await Promise.all([
    readScheduleFile(env, SCHEDULE_FILE),
    readScheduleFile(env, SCHEDULE_REMINDERS_FILE)
  ]);
  const now = Date.now();
  let changed = false;

  for (const preference of preferences.items) {
    if (!preference.enabled || !preference.userId) continue;
    if (!Array.isArray(preference.sent)) preference.sent = [];

    for (const event of events.items) {
      const start = Date.parse(event.startsAt);
      const end = Date.parse(event.endsAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= now) continue;

      const reminderKey = String(event.sourceMessageId || event.sourceMessageUrl || event.startsAt) + ":" + preference.userId;
      if (preference.sent.includes(reminderKey)) continue;

      const dueAt = start - Math.max(0, Number(preference.leadMinutes) || 0) * 60000;
      // Cron runs every five minutes. For an event-time reminder, this gives
      // a maximum normal delay of five minutes without sending stale notices.
      if (now < dueAt || now > dueAt + 10 * 60000) continue;

      const dmChannel = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient_id: preference.userId })
      });
      if (!dmChannel.ok) continue;
      const dm = await dmChannel.json();
      const when = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium", timeStyle: "short", timeZone: "UTC"
      }).format(new Date(start));
      const message = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🔔 **Upcoming OPVRC event**\n**${String(event.title || "Scheduled event").slice(0, 150)}**\nWhen: ${when} UTC\n${event.sourceMessageUrl ? `Original message: ${event.sourceMessageUrl}` : ""}`
        })
      });
      if (!message.ok) continue;
      preference.sent.push(reminderKey);
      changed = true;
    }
  }

  if (changed) {
    for (const preference of preferences.items) {
      if (Array.isArray(preference.sent) && preference.sent.length > 300) {
        preference.sent = preference.sent.slice(-300);
      }
    }
    await writeScheduleFile(env, SCHEDULE_REMINDERS_FILE, preferences.items, preferences.sha, "Record sent personal schedule reminders");
  }
}

function discordCommandDefinitions() {
  return [
  ...Object.keys(LINKS).map((name) => ({ name, description: DESCRIPTIONS[name], type: 1 })),
  { name: "map", description: "Interactive island map with toggle buttons", type: 1 },
  { name: "Add to Schedule", type: 3 },
  { name: "Add to Video List", type: 3 },
  { name: "Add Quote", type: 3 },
  { name: "events", description: "Show OPVRC event messages and videos, newest first", type: 1 },
  {
    name: "reminders",
    description: "Set your personal event reminder preferences",
    type: 1,
    options: [
      { type: 5, name: "enabled", description: "Turn your personal reminders on or off", required: false },
      { type: 3, name: "timing", description: "When to remind you (default: at event time)", required: false, choices: [
        { name: "At event time (default)", value: "0" },
        { name: "5 minutes before", value: "5m" },
        { name: "30 minutes before", value: "30m" },
        { name: "1 hour before", value: "1h" },
        { name: "1 day before", value: "1d" }
      ] }
    ]
  },
  {
    name: "addcrew",
    description: "🔒 Restricted: add a crew and its flag to the crews sheet",
    type: 1,
    options: [
      { type: 3, name: "name", description: "Exact crew name, for example The Michigan House", required: true, max_length: 100 },
      { type: 3, name: "flag_url", description: "Direct image URL (optional if uploading a file)", required: false },
      { type: 11, name: "flag_file", description: "Upload a flag image instead", required: false },
    ],
  },
  {
    name: "editcrew",
    description: "🔒 Restricted: change a crew's flag or rename it",
    type: 1,
    options: [
      { type: 3, name: "crew", description: "The exact current crew name", required: true, autocomplete: true },
      { type: 3, name: "new_name", description: "New crew name (optional)", required: false, max_length: 100 },
      { type: 3, name: "new_flag_url", description: "New flag image URL (optional)", required: false },
      { type: 11, name: "new_flag_file", description: "Upload a new flag image (optional)", required: false },
    ],
  },
  {
    name: "googlesheet",
    description: "Simple list of islands and owners (or crews) from the map data",
    type: 1,
    options: [
      {
        type: 3,
        name: "list",
        description: "Which list",
        required: false,
        choices: [
          { name: "Islands and owners", value: "i" },
          { name: "Crews", value: "c" },
        ],
      },
    ],
  },
  {
    name: "group",
    description: "Show only one group's islands (start typing the name)",
    type: 1,
    options: [{ type: 3, name: "name", description: "Group name", required: true, autocomplete: true }],
  },
  {
    name: "crewinfo",
    description: "Show quick info and the flag of a crew/group",
    type: 1,
    options: [{ type: 3, name: "name", description: "Crew name", required: true, autocomplete: true }],
  },
  {
    name: "crewlist",
    description: "Show a paginated list of all crews and their island counts",
    type: 1,
  },

  {
    name: "worldactivity",
    description: "Rank crews by historical net visit change; show online players separately",
    type: 1,
    options: [
      {
        type: 3,
        name: "duration",
        description: "How far back to compare recorded visits",
        required: false,
        choices: worldActivityDurationOptions()
      }
    ]
  },
  {
    name: "islandactivity",
    description: "Rank islands by historical net visit change; show online players separately",
    type: 1,
    options: [{ type: 3, name: "duration", description: "How far back to compare recorded visits", required: false, choices: worldActivityDurationOptions() }]
  },
  {
    name: "crewactivity",
    description: "Rank crews and groups by historical net visit change; show online players separately",
    type: 1,
    options: [{ type: 3, name: "duration", description: "How far back to compare recorded visits", required: false, choices: worldActivityDurationOptions() }]
  },
  {
    name: "owneractivity",
    description: "Rank island owners by historical net visit change; show online players separately",
    type: 1,
    options: [{ type: 3, name: "duration", description: "How far back to compare recorded visits", required: false, choices: worldActivityDurationOptions() }]
  },
  {
    name: "island",
    description: "Show island information, population and tracked visits",
    type: 1,
    options: [
      {
        type: 3,
        name: "name",
        description: "Island name",
        required: true,
        autocomplete: true
      }
    ],
  },
  {
    name: "setowner",
    description: "🔒 Restricted: change an island's owner in Google Sheets",
    type: 1,
    options: [
      { type: 3, name: "island", description: "Island name", required: true, autocomplete: true },
      { type: 3, name: "owner", description: "New owner name", required: true },
    ],
  },
  {
    name: "renameisland",
    description: "🔒 Restricted: rename an island on the map",
    type: 1,
    options: [
      { type: 3, name: "island", description: "Current island name", required: true, autocomplete: true },
      { type: 3, name: "new_name", description: "New island name", required: true, max_length: 100 },
    ],
  },
];;
}

async function syncDiscordCommands(env) {
  need(env, ["DISCORD_APP_ID", "DISCORD_TOKEN"]);
  const registered = discordCommandDefinitions().map((command) => ({ ...command, integration_types: [0, 1], contexts: [0, 1, 2] }));
  const response = await fetch("https://discord.com/api/v10/applications/" + env.DISCORD_APP_ID + "/commands", {
    method: "PUT",
    headers: { Authorization: "Bot " + env.DISCORD_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(registered)
  });
  if (!response.ok) throw new Error("Discord command sync failed (" + response.status + "): " + (await response.text()).slice(0, 300));
  return response;
}
let lastAutoCommandSyncAt = 0;

// ---------- main ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One-time: open https://YOUR-WORKER/register?key=REGISTER_KEY in your browser
    if (request.method === "GET" && url.pathname === "/register") {
      if (url.searchParams.get("key") !== env.REGISTER_KEY) return new Response("no", { status: 403 });
      const commands = discordCommandDefinitions();
      // Command definitions are shared with the automatic sync helper.

      const registered = commands.map((c) => ({ ...c, integration_types: [0, 1], contexts: [0, 1, 2] }));
      const r = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`, {
        method: "PUT",
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(registered),
      });
      return new Response(`${r.status}\n${await r.text()}`);
    }

    if (request.method !== "POST") return new Response("OPVRC map bot is running.");

    const body = await request.text();
    if (!(await verify(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("bad signature", { status: 401 });
    }
    const i = JSON.parse(body);
    const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

    // Keep Discord's slash-command menu in sync automatically after Worker updates.
    // A signed admin interaction triggers a background refresh; no password URL needed.
    if (i.type === 2 && isAdmin(env, i) && Date.now() - lastAutoCommandSyncAt > 15 * 60 * 1000) {
      lastAutoCommandSyncAt = Date.now();
      ctx.waitUntil(syncDiscordCommands(env).catch(error => console.error("Automatic Discord command sync failed:", error)));
    }

    if (i.type === 1) return json({ type: 1 }); // ping

    // Discord message context-menu command
    if (i.type === 2 && i.data.type === 3 && i.data.name === "Add to Schedule") {
      const message = i.data.resolved?.messages?.[i.data.target_id];
      const event = message ? parseScheduleMessage({ ...message, channel_id: i.channel_id, guild_id: i.guild_id }) : null;
      if (!event) {
        return json({ type: 4, data: { flags: 64, content: "I couldn't find a clear date clue (for example, 'tomorrow', 'in 3 days', 'next Friday', or 'November 18') in that message. Nothing was added." } });
      }
      return json({ type: 4, data: {
        flags: 64,
        embeds: [{
          title: "Schedule preview — please confirm",
          description: `**${event.title}**\n**Date/time (UTC):** ${event.startsAt}\n**Time clue:** ${event.timeHint}\n**Date clue:** ${event.dateHint}\n**Author:** ${event.author}\n[Original message](${event.sourceMessageUrl})\n\nThis is a best-effort date reading. Confirm only if it looks right.`,
          color: 0x005aff
        }],
        components: [{ type: 1, components: [
          { type: 2, style: 3, label: "Add", custom_id: `schedule_add_${i.channel_id}_${i.data.target_id}` },
          { type: 2, style: 2, label: "Cancel", custom_id: "schedule_cancel" }
        ] }]
      } });
    }

    if (i.type === 2 && i.data.type === 3 && i.data.name === "Add Quote") {
      return await addQuoteFromMessage(env, i);
    }

    if (i.type === 2 && i.data.type === 3 && i.data.name === "Add to Video List") {
      const message = i.data.resolved?.messages?.[i.data.target_id];
      const attachments = Object.values(message?.attachments || {}).filter(a => /video\//i.test(a.content_type || "") || /\.(mp4|mov|webm|m4v)$/i.test(a.filename || ""));
      const content = String(message?.content || "");
      const urls = [...content.matchAll(/https?:\/\/[^\s<>]+/g)].map(match => match[0].replace(/[),.!?]+$/,"")).filter(url => /youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|vimeo\.com|twitch\.tv|x\.com|twitter\.com|kick\.com/i.test(url));
      const candidates = [...new Set([...urls, ...attachments.map(a => a.url).filter(Boolean)])];
      if (!message || !candidates.length) return json({type:4,data:{flags:64,content:"I couldn't find video links or video attachments in that message."}});
      need(env, ["GITHUB_TOKEN"]);
      const stored = await readScheduleFile(env, VIDEO_FILE);
      const sourceMessageUrl = `https://discord.com/channels/${i.guild_id || "@me"}/${i.channel_id}/${message.id}`;
      const addedAt = message.timestamp || new Date().toISOString();
      let added = 0;
      for (const url of candidates) {
        if (stored.items.some(item => item.url === url)) continue;
        const attachment = attachments.find(a => a.url === url);
        const platform = /youtube\.com|youtu\.be/i.test(url) ? "YouTube" : /tiktok\.com/i.test(url) ? "TikTok" : /discord(app)?\.com\/attachments/i.test(url) ? "Discord" : "External";
        stored.items.push({
          type:"video", category:"OPVRC Events", url, platform,
          title: attachment?.filename || (platform === "YouTube" ? "YouTube video" : platform === "TikTok" ? "TikTok video" : "Video"),
          thumbnail: null, publishedAt: addedAt, addedAt,
          sourceMessageUrl, sourceMessageId: message.id,
          author: message.author?.global_name || message.author?.username || "Unknown"
        });
        added++;
      }
      if (added) await writeScheduleFile(env, VIDEO_FILE, stored.items, stored.sha, "Add videos to OPVRC Events");
      return json({type:4,data:{flags:64,content:added ? `Added **${added}** video link/attachment(s) to **OPVRC Events**. Items are tagged VIDEO and sorted by date in /events.` : "Those video links are already saved."}});
    }

    // slash commands
    if (i.type === 2) {
      const name = i.data.name;
      if (LINKS[name]) return json({ type: 4, data: { content: LINKS[name] } });
      if (name === "map") return json({ type: 4, data: await mapMessage(ALL_ON) });
      if (name === "events") return json({ type: 4, data: await eventsListMessage(env) });
      if (name === "reminders") return json({ type: 4, data: await scheduleRemindersCommand(env, i) });
      if (name === "addcrew" || name === "editcrew") {
        if (!isAdmin(env, i)) return json(notAllowed(i));
        ctx.waitUntil(runCrewCommand(env, i));
        return json({ type: 5, data: { flags: 64 } });
      }
      if (name === "googlesheet") {
        const kind = String(i.data.options?.[0]?.value ?? "i") === "c" ? "c" : "i";
        return json({ type: 4, data: await sheetPage(kind, 0) });
      }
      if (name === "group") {
        const v = String(i.data.options?.[0]?.value ?? "");
        const groups = await getGroups();
        const g =
          groups.find((x) => x.id === v) ||
          groups.find((x) => x.name.toLowerCase() === v.toLowerCase()) ||
          groups.find((x) => x.name.toLowerCase().includes(v.toLowerCase()));
        if (!g) return json({ type: 4, data: { content: `I couldn't find a group called "${v}".` } });
        return json({ type: 4, data: await groupData(g) });
      }
      if (name === "crewinfo") {
        const v = String(i.data.options?.[0]?.value ?? "");
        const [groups, islands, ownerLinks] = await Promise.all([
          getGroups(),
          tsv("island-colors.tsv"),
          getOwnerLinks()
        ]);
        const g =
          groups.find((x) => x.id === v) ||
          groups.find((x) => x.name.toLowerCase() === v.toLowerCase()) ||
          groups.find((x) => x.name.toLowerCase().includes(v.toLowerCase()));
        if (!g) return json({ type: 4, data: { content: `I couldn't find a group called "${v}".` } });

        // Collect distinct owners of islands assigned to this crew, including
        // secondary crew assignments (Group2 / Group3).
        const ownerIslands = new Map();
        for (const island of islands) {
          const belongs = [island.Group1, island.Group2, island.Group3]
            .some(id => String(id || "").trim() === String(g.id));
          if (!belongs) continue;
          const owner = String(island.Owner || "").trim();
          if (!owner || /^(unowned|—|unknown)$/i.test(owner)) continue;
          if (!ownerIslands.has(owner)) ownerIslands.set(owner, []);
          ownerIslands.get(owner).push(islandDisplayName(island));
        }

        const ownerLines = [...ownerIslands.entries()]
          .sort((a,b) => a[0].localeCompare(b[0]))
          .map(([owner, names]) => {
            const data = ownerLinks[owner.toLowerCase()] || {};
            const shownOwner = data.link ? `[${owner}](${data.link})` : owner;
            const islandNames = names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : "");
            return `• **${shownOwner}** — ${islandNames}`;
          });
        const ownerText = ownerLines.length
          ? ownerLines.join("\n").slice(0, 1024)
          : "No named island owners are currently listed for this crew.";

        const crewKey = g.name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
        const vrchatUrl = g.vrchatGroupUrl ||
          (g.vrchatGroupId ? `https://vrchat.com/home/group/${g.vrchatGroupId}` : "") ||
          (crewKey === "marines" ? LINKS.marines : crewKey === "revolutionaryarmy" ? LINKS.revolutionary : "");
        const discordUrl = g.discordInvite || (crewKey === "marines" ? LINKS.marinesdiscord : "");
        const linkLines = [];
        if (vrchatUrl) linkLines.push(`[VRChat group](${vrchatUrl})`);
        if (discordUrl) linkLines.push(`[Discord invite](${discordUrl})`);

        let vrcDetail = null;
        if (g.vrchatGroupId) {
          try { vrcDetail = await getVrcGroupDetails(g.vrchatGroupId); }
          catch (error) { console.error("VRC Search group lookup failed:", error); }
        }

        const fields = [
          { name: "Islands", value: String(g.islands), inline: true },
          { name: "Island owners", value: ownerText, inline: false }
        ];
        if (linkLines.length) fields.push({ name: "Links", value: linkLines.join(" · "), inline: false });
        const vrcMemberCount = Number(vrcDetail?.member_count);
        if (Number.isFinite(vrcMemberCount) && vrcMemberCount >= 0) {
          fields.push({ name: "VRChat group members", value: vrcMemberCount.toLocaleString("en-US"), inline: true });
          const onlineCount = Number(vrcDetail?.online_member_count);
          if (Number.isFinite(onlineCount) && onlineCount >= 0) {
            fields.push({ name: "VRChat online", value: onlineCount.toLocaleString("en-US"), inline: true });
          }
          const dailyGrowth = Number(vrcDetail?.avg_daily_growth_90d);
          if (Number.isFinite(dailyGrowth)) {
            fields.push({ name: "Member growth (90-day avg.)", value: `${dailyGrowth > 0 ? "+" : ""}${dailyGrowth.toFixed(2)} members/day`, inline: true });
          }
          fields.push({
            name: "Membership history",
            value: vrcMemberHistoryLines(vrcDetail).slice(0, 1024),
            inline: false
          });
        } else if (g.vrchatMembers.trim()) {
          fields.push({ name: "VRChat members (sheet snapshot)", value: Number(g.vrchatMembers).toLocaleString("en-US"), inline: true });
        }
        if (g.discordMembers.trim()) fields.push({ name: "Discord members", value: Number(g.discordMembers).toLocaleString("en-US"), inline: true });
        if (vrcDetail?.vrc_search_url) fields.push({ name: "Membership data", value: `[Data from VRC Search](${vrcDetail.vrc_search_url})`, inline: false });

        // Prefer the crew's uploaded flag artwork; numeric index is an internal fallback only.
        const fUrl = g.flagUrl || flagUrl(g.flag);
        return json({
          type: 4,
          data: {
            embeds: [{
              title: `🏴‍☠️ Crew Info: ${g.name}`,
              color: crewInfoColor(g.name, g.mapColor),
              fields,
              ...(fUrl ? { thumbnail: { url: fUrl } } : {})
            }],
            ...(linkLines.length ? { components: [{
              type: 1,
              components: [
                ...(vrchatUrl ? [{ type: 2, style: 5, label: "VRChat Group", url: vrchatUrl }] : []),
                ...(discordUrl ? [{ type: 2, style: 5, label: "Discord Invite", url: discordUrl }] : [])
              ]
            }] } : {})
          }
        });
      }
      if (name === "crewlist") {
        return json({ type: 4, data: await crewListPage(0) });
      }

      if (["worldactivity", "islandactivity", "crewactivity", "owneractivity"].includes(name)) {
        const kind = name === "islandactivity" ? "island" : name === "owneractivity" ? "owner" : "crew";
        const duration = String(i.data.options?.find((o) => o.name === "duration")?.value || "7d");
        ctx.waitUntil((async () => {
          const data = await historicalActivityResponse(kind, duration);
          await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
          });
        })());
        return json({ type: 5 });
      }

      if (name === "island") {
        return json({
          type: 4,
          data: await islandMessage(
            String(i.data.options?.[0]?.value ?? "")
          )
        });
      }

      if (name === "setowner") {
        if (!isAdmin(env, i)) return json(notAllowed(i));
        const isl = String(i.data.options?.find((o) => o.name === "island")?.value ?? "");
        const own = String(i.data.options?.find((o) => o.name === "owner")?.value ?? "");
        ctx.waitUntil(
          (async () => {
            const msg = await handleSetOwnerCommand(isl, own, env);
            await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: msg }),
            });
          })()
        );
        return json({ type: 5, data: { flags: 64 } });
      }

      if (name === "renameisland") {
        if (!isAdmin(env, i)) return json(notAllowed(i));
        const oldName = String(i.data.options?.find((o) => o.name === "island")?.value ?? "");
        const newName = String(i.data.options?.find((o) => o.name === "new_name")?.value ?? "");
        ctx.waitUntil(
          (async () => {
            const msg = await handleRenameIslandCommand(oldName, newName, env);
            await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: msg }),
            });
          })()
        );
        return json({ type: 5, data: { flags: 64 } });
      }
    }

    // autocomplete while typing an island name
    if (i.type === 4) {
      const typed = String(i.data.options?.find((o) => o.focused)?.value ?? "");

      const choices =
        (i.data.name === "group" || i.data.name === "crewinfo")
          ? await groupChoices(typed)
          : i.data.name === "editcrew"
            ? (isAdmin(env, i) ? await crewNameChoices(typed) : [])
            : i.data.name === "renameisland"
              ? (isAdmin(env, i) ? await renameIslandChoices(typed) : [])
              : await islandChoices(typed);

      return json({ type: 8, data: { choices } });
    }

    // schedule preview buttons
    if (i.type === 3 && i.data.custom_id === "schedule_cancel") {
      return json({ type: 7, data: { content: "Schedule addition cancelled.", components: [] } });
    }
    if (i.type === 3 && i.data.custom_id.startsWith("schedule_add_")) {
      try {
        return json(await confirmScheduleMessage(env, i));
      } catch (error) {
        return json({ type: 4, data: { flags: 64, content: `⚠️ Could not save the event: ${String(error?.message || error).slice(0, 250)}` } });
      }
    }

    // Island civilian list button
    if (i.type === 3 && i.data.custom_id.startsWith("civilians_")) {
      const islandId = i.data.custom_id.slice("civilians_".length);
      const [islands, civilians] = await Promise.all([tsv("island-colors.tsv"), tsv("civilians.tsv").catch(() => [])]);
      const island = islands.find(row => String(row.ID) === islandId);
      if (!island) return json({ type: 4, data: { flags: 64, content: "Island not found." } });
      const islandName = islandDisplayName(island);
      const entries = civilians.filter(row => String(row.Island || "").trim().toLowerCase() === islandName.toLowerCase());
      const lines = entries.map(row => {
        const name = String(row.Name || "").trim(), url = String(row.Link || "").trim();
        return name ? (url.startsWith("https://") || url.startsWith("http://") ? "[" + name + "](" + url + ")" : name) : "";
      }).filter(Boolean);
      return json({ type: 4, data: { flags: 64, embeds: [{ title: islandName + " — Civilians", description: lines.length ? lines.join("\\n") : "No civilian entries yet.", color: 0x005aff }] } });
    }

    // buttons + dropdown
    if (i.type === 3) {
      if (i.data.custom_id.startsWith("gs_")) {
        const [, k, pg] = i.data.custom_id.split("_");
        return json({ type: 7, data: await sheetPage(k === "c" ? "c" : "i", parseInt(pg, 10) || 0) });
      }
      if (i.data.custom_id.startsWith("cl_")) {
        const [, sort, pg] = i.data.custom_id.split("_");
        return json({ type: 7, data: await crewListPage(parseInt(pg, 10) || 0, sort || "islands") });
      }
      if (i.data.custom_id.startsWith("cls_")) {
        const [, sort] = i.data.custom_id.split("_");
        return json({ type: 7, data: await crewListPage(0, sort || "islands") });
      }
      const [kind, mask] = i.data.custom_id.split("_");

      if (kind === "r") return json({ type: 7, data: await mapMessage(ALL_ON) });

      if (kind[0] === "t") {
        const n = parseInt(kind.slice(1), 10);
        const m = (mask === ALL_ON ? ALL_OFF : mask).split("");
        m[n] = mask === ALL_ON ? "1" : m[n] === "1" ? "0" : "1";
        return json({ type: 7, data: await mapMessage(m.join("")) });
      }

      if (kind === "v") {
        const id = i.data.values[0];
        const region = REGIONS.find(([v]) => v === id);
        if (!region || id === "all") return json({ type: 7, data: await mapMessage(ALL_ON) });
        return json({
          type: 7,
          data: await mapMessage(ALL_ON, {
            title: region[1],
            description: "Zoomed-in view. Tap a button to filter the whole map, or pick Whole map.",
            image: `${IMG_TEST}/regions/${id}.png?v=${stamp()}`,
          }),
        });
      }

      if (kind === "g") {
        const groups = await getGroups();
        const g = groups.find((x) => x.id === i.data.values[0]);
        if (!g) return json({ type: 7, data: await mapMessage(mask) });
        return json({ type: 7, data: await groupData(g) });
      }
    }

    return new Response("unknown", { status: 400 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      archiveExpiredScheduleEvents(env),
      sendDueScheduleReminders(env)
    ]));
  }
};

async function handleRenameIslandCommand(oldName, newName, env) {
  need(env, ["GITHUB_PAT_TOKEN"]);
  try {
    oldName = String(oldName || "").trim();
    newName = String(newName || "").trim();

    if (!oldName || !newName) throw new Error("Please provide both the current island name and the new island name.");
    if (newName.length > 100) throw new Error("The new island name must be 100 characters or fewer.");
    if (oldName.toLowerCase() === newName.toLowerCase()) throw new Error("The new name is the same as the current name.");

    const token = await googleToken(env);
    const spreadId = "14I31HO_9qbplW8LWP63-itFL1eAjL0O-ecEAxxCOJpM";
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadId}/values/A1:C500`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Google Sheets fetch failed with status ${r.status}`);

    const rows = (await r.json()).values || [];
    const oldKey = oldName.toLowerCase();
    const newKey = newName.toLowerCase();
    const rowIndex = rows.findIndex((row) => String(row[0] || "").trim().toLowerCase() === oldKey);
    if (rowIndex < 0) throw new Error(`Island "${oldName}" could not be found in the island spreadsheet.`);

    const duplicate = rows.findIndex((row, index) =>
      index !== rowIndex && String(row[0] || "").trim().toLowerCase() === newKey
    );
    if (duplicate >= 0) throw new Error(`An island named "${newName}" already exists.`);

    const updateResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadId}/values/A${rowIndex + 1}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values: [[newName]] })
      }
    );
    if (!updateResponse.ok) throw new Error("Could not rename the island in Google Sheets.");

    const rebuild = await fetch(
      "https://api.github.com/repos/eyeonspyweezer/opvrcinteractivemap/actions/workflows/update-island-data.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT_TOKEN}`,
          "User-Agent": "Cloudflare-Discord-Bot",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ref: "main" })
      }
    );
    if (!rebuild.ok) throw new Error(`Island was renamed in Google Sheets, but the map rebuild could not be started (GitHub returned ${rebuild.status}).`);

    return `✅ Renamed **${oldName}** to **${newName}** in the island tracker. The map data rebuild has started.`;
  } catch (error) {
    return `⚠️ Error renaming island: ${error.message}`;
  }
}

async function handleSetOwnerCommand(islandName, newOwner, env) {
  need(env, ["GITHUB_PAT_TOKEN"]);
  try {
    const token = await googleToken(env);
    
    // 1. Fetch values from Owners sheet to find the matching island row
    // Owners sheet spreadsheet ID is derived from the URL you set (SHEET_OWNERS): "14I31HO_9qbplW8LWP63-itFL1eAjL0O-ecEAxxCOJpM"
    const spreadId = "14I31HO_9qbplW8LWP63-itFL1eAjL0O-ecEAxxCOJpM";
    
    // Fetch current list of island names
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadId}/values/A1:C500`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Google Sheets fetch failed with status ${r.status}`);
    
    const data = await r.json();
    const rows = data.values || [];
    
    // Search the rows for the island name
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].trim().toLowerCase() === islandName.trim().toLowerCase()) {
        rowIndex = i;
        break;
      }
    }
    
    if (rowIndex === -1) {
      throw new Error(`Island "${islandName}" could not be found in the spreadsheet rows.`);
    }

    // 2. Write the new owner value to Column B (Owner) for that row
    const updateRange = `B${rowIndex + 1}`;
    const updateResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadId}/values/${updateRange}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { 
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values: [[newOwner]] })
      }
    );
    if (!updateResponse.ok) throw new Error("Could not write the update back to Google Sheets.");

    // 3. Trigger the GitHub action workflow dispatch instantly to run the rebuild
    await fetch(`https://api.github.com/repos/eyeonspyweezer/opvrcinteractivemap/actions/workflows/island-cards-test.yml/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_PAT_TOKEN}`,
        "User-Agent": "Cloudflare-Discord-Bot",
        "Accept": "application/vnd.github+json"
      },
      body: JSON.stringify({ ref: "main" })
    });

    return `✅ Successfully updated **${islandName}** to owner **${newOwner}** in Google Sheets! Triggering GitHub Actions map rebuild...`;

  } catch (error) {
    return `⚠️ Error setting owner: ${error.message}`;
  }
}
