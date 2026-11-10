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
  const groups = await tsv("island-groups.tsv");
  const metadata = await tsv("crew-links.tsv").catch(() => []);
  const metadataByName = new Map(
    metadata.map(row => [String(row.Group || "").trim().toLowerCase(), row])
  );

  return groups.map((o) => {
    const f = parseInt(o.Flag, 10);
    const extra = metadataByName.get(String(o.Group || "").trim().toLowerCase()) || {};
    return {
      id: o.ID || "",
      name: o.Group || "",
      islands: parseInt(o.Islands, 10) || 0,
      flag: Number.isNaN(f) ? -1 : f,
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
  const m = v.match(/^(\\d+(?:\\.\\d+)?)(m|h|d|w)$/);
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

  return {
    checkedAt: new Date().toISOString(),
    duration: duration.label,
    comparisonDays: visitGrowth.length ? Math.max(...visitGrowth.map(x => x.comparisonMs || 0)) / 86400000 : 0,
    crewGrowth,
    ownerGrowth,
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

  const islandLink = island => {
    const firstWorld = island.worldIds?.[0];
    if (firstWorld) {
      return `[${island.name}](https://vrchat.com/home/world/${firstWorld})`;
    }
    return island.name;
  };

  const crewLines = data.crewGrowth.map((crew, index) => {
    const islandLinks = crew.islands
      .slice(0, 8)
      .map((island, islandIndex) => {
        const active = island.activePlayers > 0
          ? ` · ${count(island.activePlayers)} active`
          : "";
        return `[#${islandIndex + 1}](https://vrchat.com/home/world/${island.worldIds?.[0] || ""})`;
      });

    const islandNames = crew.islands
      .slice(0, 8)
      .map((island, islandIndex) =>
        `[#${islandIndex + 1}](https://vrchat.com/home/world/${island.worldIds?.[0] || ""})`
      );

    const totalActive = crew.activePlayers > 0
      ? ` / ${count(crew.activePlayers)} active players`
      : "";

    const sign = crew.gained > 0 ? "+" : crew.gained < 0 ? "" : "";
    return `**${index + 1}. ${crew.name}** — **${sign}${count(crew.gained)} visits net change**${totalActive} (${islandNames.join(", ")})`;
  });

  const description = crewLines.length
    ? crewLines.join("\\n")
    : "No non-zero visit changes were found for the selected duration.";

  return {
    embeds: [{
      title: "VRChat World Activity — Crew Ranking",
      description: `Ranked by net visit change over the requested ${data.duration}. Each # is an island link.\\n${data.comparisonDays > 0 && data.comparisonDays < parseWorldActivityDuration(data.duration).ms / 86400000 ? `Only ${data.comparisonDays.toFixed(1)} days of recorded history are currently available.\\n` : ""}\\n${description}`.slice(0, 5900),
      color: 0x005aff,
      footer: {
        text: `Visit tracker: ${data.trackedWorldCount} linked worlds. Rankings use recorded lifetime-visit snapshots.`
      },
      timestamp: data.checkedAt
    }]
  };
}

async function worldActivityResponse(durationValue = "7d") {
  try {
    return worldActivityMessage(await getWorldActivity(durationValue));
  } catch (error) {
    return {
      content: "⚠️ I couldn't load world activity right now. The cached visit tracker or VRChat API may be temporarily unavailable."
    };
  }
}

function ownerActivityMessage(data) {
  const count = value => Number(value || 0).toLocaleString("en-US");
  const ownerLines = (data.ownerGrowth || []).map((owner, index) => {
    const islandLinks = owner.islands.slice(0, 8).map(island => {
      const worldId = island.worldIds?.[0];
      return worldId ? `[${island.name}](https://vrchat.com/home/world/${worldId})` : island.name;
    });
    const active = owner.activePlayers > 0 ? ` · ${count(owner.activePlayers)} active players` : "";
    return `**${index + 1}. ${owner.name}** — **+${count(owner.gained)} visits**${active}\n${islandLinks.join(", ")}`;
  });
  const description = ownerLines.length ? ownerLines.join("\n\n") : "No non-zero visit changes were found for the selected duration.";
  return { embeds: [{
    title: "VRChat World Activity — Island Owner Ranking",
    description: `Ranked by visit growth for islands assigned to each Owner in the map data over the last ${data.duration}. This is growth during the selected period, not lifetime visits.\n\n${description}`.slice(0, 5900),
    color: 0x005aff,
    footer: { text: `Visit tracker: ${data.trackedWorldCount} linked worlds. Rankings use recorded lifetime-visit snapshots.` },
    timestamp: data.checkedAt
  }] };
}

async function ownerActivityResponse(durationValue = "7d") {
  try { return ownerActivityMessage(await getWorldActivity(durationValue)); }
  catch (error) { return { content: "Owner activity could not be loaded. The cached visit tracker or VRChat API may be temporarily unavailable." }; }
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
  const fmt=v=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?"Unavailable":Number(v).toLocaleString("en-US");
  const embeds=slice.map(g=>{
    const growth=growthByName.has(g.name.toLowerCase())?growthByName.get(g.name.toLowerCase()):null;
    const links=[];
    if(g.vrchatGroupUrl) links.push("[VRChat group]("+g.vrchatGroupUrl+")");
    if(g.discordInvite) links.push("[Discord invite]("+g.discordInvite+")");
    const image=g.flagUrl||flagUrl(g.flag);
    return {title:g.name,description:links.join(" · ")||"No group links listed.",color:0x005aff,
      fields:[
        {name:"Islands",value:String(g.islands),inline:true},
        {name:"VRChat members",value:fmt(g.vrchatMembers),inline:true},
        {name:"VRChat online",value:fmt(g.vrchatOnline),inline:true},
        {name:"Discord members",value:fmt(g.discordMembers),inline:true},
        {name:"Visit growth (7 days)",value:fmt(growth),inline:true}
      ],...(image?{thumbnail:{url:image}}:{})};
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

// ---------- main ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One-time: open https://YOUR-WORKER/register?key=REGISTER_KEY in your browser
    if (request.method === "GET" && url.pathname === "/register") {
      if (url.searchParams.get("key") !== env.REGISTER_KEY) return new Response("no", { status: 403 });
      const commands = [
        ...Object.keys(LINKS).map((name) => ({ name, description: DESCRIPTIONS[name], type: 1 })),
        { name: "map", description: "Interactive island map with toggle buttons", type: 1 },
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
          description: "Rank crews by VRChat world visit growth",
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
          description: "Rank islands by current online players across their linked worlds",
          type: 1
        },
        {
          name: "crewactivity",
          description: "Rank crews and groups by current online players across their islands",
          type: 1
        },
        {
          name: "owneractivity",
          description: "Rank island owners by current online players across their islands",
          type: 1
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
      ];
      // TEST command. To remove it: open the /register link again with  &test=off  at the end

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

    if (i.type === 1) return json({ type: 1 }); // ping

    // slash commands
    if (i.type === 2) {
      const name = i.data.name;
      if (LINKS[name]) return json({ type: 4, data: { content: LINKS[name] } });
      if (name === "map") return json({ type: 4, data: await mapMessage(ALL_ON) });
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
        const groups = await getGroups();
        const g =
          groups.find((x) => x.id === v) ||
          groups.find((x) => x.name.toLowerCase() === v.toLowerCase()) ||
          groups.find((x) => x.name.toLowerCase().includes(v.toLowerCase()));
        if (!g) return json({ type: 4, data: { content: `I couldn't find a group called "${v}".` } });
        const fUrl = flagUrl(g.flag);
        return json({
          type: 4,
          data: {
            embeds: [
              {
                title: `🏴‍☠️ Crew Info: ${g.name}`,
                color: 0x005aff,
                fields: [
                  { name: "Group ID", value: g.id || "—", inline: true },
                  { name: "Islands Owned", value: String(g.islands), inline: true },
                  { name: "Flag ID/Index", value: g.flag >= 0 ? String(g.flag) : "Using custom file", inline: true },
                ],
                ...(fUrl ? { thumbnail: { url: fUrl } } : {}),
              }
            ]
          }
        });
      }
      if (name === "crewlist") {
        return json({ type: 4, data: await crewListPage(0) });
      }

      if (name === "worldactivity") {
        const duration = String(i.data.options?.find((o) => o.name === "duration")?.value || "7d");
        ctx.waitUntil((async () => {
          const data = await worldActivityResponse(duration);
          await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
          });
        })());
        return json({ type: 5 });
      }

      if (name === "islandactivity" || name === "crewactivity" || name === "owneractivity") {
        const kind = name === "islandactivity" ? "island" : name === "crewactivity" ? "crew" : "owner";
        ctx.waitUntil((async () => {
          const data = await liveActivityResponse(kind);
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
