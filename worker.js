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
  const txt = await (await fetch(BASE + "/island-groups.tsv", { cf: { cacheTtl: 300 } })).text();
  const [head, ...rows] = txt.trim().split(/\r?\n/);
  const cols = head.split("\t");
  return rows.map((line) => {
    const v = line.split("\t");
    const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    const f = parseInt(o.Flag, 10);
    return { id: o.ID, name: o.Group, islands: parseInt(o.Islands, 10) || 0, flag: Number.isNaN(f) ? -1 : f };
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
  const res = await fetch(`${BASE}/${file}`, { cf: { cacheTtl: 300 } });
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

async function islandChoices(query) {
  const q = query.toLowerCase();
  const islands = await tsv("island-colors.tsv");
  const hits = islands.filter((r) => r["Island Name"].toLowerCase().includes(q));
  // real names first, ??? islands last
  hits.sort((a, b) => (a.Unknown === "1") - (b.Unknown === "1"));
  return hits.slice(0, 25).map((r) => ({ name: r["Island Name"].slice(0, 100), value: r.ID }));
}
// ---------- VRChat world population (no authentication) ----------
async function getWorldPopulation(worldId) {
  try {
    const r = await fetch(
      `https://api.vrchat.cloud/api/1/worlds/${worldId}`,
      {
        headers: {
          "User-Agent": "OPVRC-Island-Map/1.0"
        },
        cf: { cacheTtl: 300 }
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


async function islandMessage(query, test = false) {
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
    islands.find((r) => r["Island Name"].toLowerCase() === q) ||
    islands.find((r) => r["Island Name"].toLowerCase().includes(q));

  if (!isl) return { content: `I couldn't find an island called "${query}".` };

  const formatVisits = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") {
      return "Unavailable";
    }

    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString("en-US")
      : "Unavailable";
  };

  const groupNames = [isl.Group1, isl.Group2, isl.Group3]
    .filter((id) => id && id !== "0")
    .map((id) => groups.find((g) => g.ID === id)?.Group)
    .filter(Boolean);

  // One link per VRChat world.
  const ids = [
    ...new Set(
      (isl.Link.match(
        /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
      ) || []).map((id) => id.toLowerCase())
    ),
  ];

  const urls = ids.length
    ? ids.map((id) => `https://vrchat.com/home/world/${id}`)
    : isl.Link.split(/\s+/).filter(Boolean);

  const links = urls
    .slice(0, 6)
    .map((u, n) => `[World ${n + 1}](${u})`);

  // Live population data from VRChat.
  const populations = await Promise.all(
    ids.map((id) => getWorldPopulation(id))
  );

  const populationLines = populations.map((p, n) => {
    if (!p) return `**World ${n + 1}:** Unavailable`;

    const valid = [p.total, p.public, p.private].every(
      (v) => Number.isFinite(v)
    );

    const worldVisit = worldVisitRows.find(
      (r) => (r["World ID"] || "").toLowerCase() === ids[n]
    );

    const visits = worldVisit
      ? formatVisits(worldVisit["Lifetime Visits"])
      : "Unavailable";

    if (!valid) {
      return `**World ${n + 1}:** Population unavailable\n📈 Lifetime visits: ${visits}`;
    }

    return (
      `**World ${n + 1}**\n` +
      `👥 Total: ${p.total} · 🌐 Public: ${p.public} · 🔒 Private: ${p.private}\n` +
      `📈 Lifetime visits: ${visits}`
    );
  });

  const availablePopulations = populations.filter(
    (p) =>
      p &&
      Number.isFinite(p.total) &&
      Number.isFinite(p.public) &&
      Number.isFinite(p.private)
  );

  const islandTotal = availablePopulations.reduce((sum, p) => sum + p.total, 0);
  const islandPublic = availablePopulations.reduce((sum, p) => sum + p.public, 0);
  const islandPrivate = availablePopulations.reduce((sum, p) => sum + p.private, 0);

  const populationSummary = availablePopulations.length
    ? `**Island total: ${islandTotal}**\n🌐 Public: ${islandPublic} · 🔒 Private: ${islandPrivate}` +
      (availablePopulations.length < ids.length
        ? `\n⚠️ Only ${availablePopulations.length} of ${ids.length} worlds returned usable data.`
        : "")
    : "Population data unavailable";

  // Historical visit totals from the GitHub tracker.
  const islandVisits = islandVisitRows.find(
    (r) => String(r["Island ID"]) === String(isl.ID)
  );

  const lifetimeVisits = islandVisits
    ? formatVisits(islandVisits["Lifetime Visits"])
    : "Unavailable";

  const visits24h = islandVisits
    ? formatVisits(islandVisits["Visits 24h"])
    : "Unavailable";

  const visits7d = islandVisits
    ? formatVisits(islandVisits["Visits 7d"])
    : "Unavailable";

  const visits30d = islandVisits
    ? formatVisits(islandVisits["Visits 30d"])
    : "Unavailable";

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
    parseInt((isl.Color.split(/\s+/)[0] || "#005aff").replace("#", ""), 16) ||
    0x005aff;

  // Fetch owner links.
  const ownerLinks = await getOwnerLinks();
  const rawOwner = (isl.Owner || "").trim();
  const ownerData = ownerLinks[rawOwner.toLowerCase()] || {};

  let ownerDisplay = rawOwner || "—";

  if (rawOwner && rawOwner !== "—" && rawOwner !== "Unowned") {
    if (ownerData.link && ownerData.discord) {
      ownerDisplay = `[${rawOwner}](${ownerData.link}) (${ownerData.discord})`;
    } else if (ownerData.link) {
      ownerDisplay = `[${rawOwner}](${ownerData.link})`;
    } else if (ownerData.discord) {
      ownerDisplay = `${rawOwner} (${ownerData.discord})`;
    }
  }

  return {
    embeds: [
      {
        title: isl["Island Name"],
        url: BASE + "/",
        color,
        fields: [
          { name: "Status", value: status, inline: true },
          { name: "Owner", value: ownerDisplay, inline: true },
          { name: "Group", value: groupNames.join(", ") || "—", inline: true },
          ...(sinceLine ? [{ name: "Control", value: sinceLine }] : []),
          {
            name: "VRChat worlds",
            value: links.join("\n") || "No world link yet",
          },
          {
            name: "👥 Island Population",
            value: populationSummary,
          },
          {
            name: "🌐 Individual World Populations",
            value: populationLines.length
              ? populationLines.join("\n\n").slice(0, 1024)
              : "No VRChat worlds listed",
          },
          {
            name: "📈 Island Visits",
            value:
              `Lifetime: **${lifetimeVisits}**\n` +
              `Last 24 hours: ${visits24h}\n` +
              `Last 7 days: ${visits7d}\n` +
              `Last 30 days: ${visits30d}`,
          },
        ],
        ...(flagNum !== undefined
          ? { thumbnail: { url: flagUrl(flagNum) } }
          : {}),
        image: {
          url: `${BASE}/islands/${isl.ID}.jpg?v=${stamp()}`,
        },
      },
    ],
  };
}

async function islandMessageOld(query) {
  const [islands, groups, sinceRows] = await Promise.all([
    tsv("island-colors.tsv"),
    tsv("island-groups.tsv"),
    tsv("island-since.tsv").catch(() => []),
  ]);

  const q = query.toLowerCase();
  const isl =
    islands.find((r) => r.ID === query) ||
    islands.find((r) => r["Island Name"].toLowerCase() === q) ||
    islands.find((r) => r["Island Name"].toLowerCase().includes(q));

  if (!isl) return { content: `I couldn't find an island called "${query}".` };

  const groupNames = [isl.Group1, isl.Group2, isl.Group3]
    .filter((id) => id && id !== "0")
    .map((id) => groups.find((g) => g.ID === id)?.Group)
    .filter(Boolean);

  const ids = [
    ...new Set(
      isl.Link.match(
        /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
      ) || []
    ),
  ];

  const urls = ids.length
    ? ids.map((id) => `https://vrchat.com/home/world/${id}`)
    : isl.Link.split(/\s+/).filter(Boolean);

  const links = urls.slice(0, 6).map((u, n) => `[World ${n + 1}](${u})`);

  const populations = await Promise.all(
    ids.map((id) => getWorldPopulation(id))
  );

  const populationLines = populations.map((p, n) => {
    if (!p) return `**World ${n + 1}:** Unavailable`;

    const valid = [p.total, p.public, p.private].every(
      (v) => Number.isFinite(v)
    );

    if (!valid) return `**World ${n + 1}:** Population unavailable`;

    return (
      `**World ${n + 1}**\n` +
      `👥 Total: ${p.total} · 🌐 Public: ${p.public} · 🔒 Private: ${p.private}`
    );
  });

  const availablePopulations = populations.filter(
    (p) =>
      p &&
      Number.isFinite(p.total) &&
      Number.isFinite(p.public) &&
      Number.isFinite(p.private)
  );

  const islandTotal = availablePopulations.reduce((sum, p) => sum + p.total, 0);
  const islandPublic = availablePopulations.reduce((sum, p) => sum + p.public, 0);
  const islandPrivate = availablePopulations.reduce((sum, p) => sum + p.private, 0);

  const populationSummary = availablePopulations.length
    ? `**Island total: ${islandTotal}**\n🌐 Public: ${islandPublic} · 🔒 Private: ${islandPrivate}` +
      (availablePopulations.length < ids.length
        ? `\n⚠️ Only ${availablePopulations.length} of ${ids.length} worlds returned usable data.`
        : "")
    : "Population data unavailable";

  const lifetimeVisits = populations.every(
    (p) => p && Number.isFinite(p.visits)
  )
    ? populations.reduce((sum, p) => sum + p.visits, 0)
    : null;

  const flagNum = [
    isl.Flag,
    ...[isl.Group1, isl.Group2, isl.Group3].map(
      (id) => groups.find((g) => g.ID === id)?.Flag
    ),
  ]
    .map((x) => parseInt(x, 10))
    .find((n) => n >= 0);

  const since = sinceRows.find((r) => r["Island Name"] === isl["Island Name"]);
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
    parseInt((isl.Color.split(/\s+/)[0] || "#005aff").replace("#", ""), 16) ||
    0x005aff;

  const ownerLinks = await getOwnerLinks();
  const rawOwner = (isl.Owner || "").trim();
  const ownerData = ownerLinks[rawOwner.toLowerCase()] || {};

  let ownerDisplay = rawOwner || "—";

  if (rawOwner && rawOwner !== "—" && rawOwner !== "Unowned") {
    if (ownerData.link && ownerData.discord) {
      ownerDisplay = `[${rawOwner}](${ownerData.link}) (${ownerData.discord})`;
    } else if (ownerData.link) {
      ownerDisplay = `[${rawOwner}](${ownerData.link})`;
    } else if (ownerData.discord) {
      ownerDisplay = `${rawOwner} (${ownerData.discord})`;
    }
  }

  return {
    embeds: [
      {
        title: isl["Island Name"],
        url: BASE + "/",
        color,
        fields: [
          { name: "Status", value: status, inline: true },
          { name: "Owner", value: ownerDisplay, inline: true },
          { name: "Group", value: groupNames.join(", ") || "—", inline: true },
          ...(sinceLine ? [{ name: "Control", value: sinceLine }] : []),
          {
            name: "VRChat worlds",
            value: links.join("\n") || "No world link yet",
          },
          {
            name: "👥 Island Population",
            value: populationSummary,
          },
          {
            name: "🌐 Individual World Populations",
            value: populationLines.length
              ? populationLines.join("\n\n").slice(0, 1024)
              : "No VRChat worlds listed",
          },
          {
            name: "📈 Lifetime Visits",
            value:
              lifetimeVisits !== null
                ? lifetimeVisits.toLocaleString("en-US")
                : "Visit count unavailable",
          },
        ],
        ...(flagNum !== undefined
          ? { thumbnail: { url: flagUrl(flagNum) } }
          : {}),
        image: {
          url: `${BASE}/islands/${isl.ID}.jpg?v=${stamp()}`,
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
      .map((r) => `• **${esc(r["Island Name"])}** — ${r.Unowned === "1" ? "Unowned" : esc(r.Owner || "—")}`);
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
const CREW_PAGE_SIZE = 15;

async function crewListPage(page) {
  const groups = await getGroups();
  groups.sort((a, b) => b.islands - a.islands);

  const pages = Math.max(1, Math.ceil(groups.length / CREW_PAGE_SIZE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = groups.slice(p * CREW_PAGE_SIZE, (p + 1) * CREW_PAGE_SIZE);

  const rows = slice.map((g) => `• **${esc(g.name)}** — ${g.islands} island${g.islands === 1 ? "" : "s"}`);
  const updated = await lastUpdated();

  return {
    embeds: [
      {
        title: "🏴‍☠️ Registered Crews & Factions",
        description: rows.join("\n") || "No crews found.",
        color: 0x005aff,
        footer: { text: `Page ${p + 1} of ${pages}` },
        ...(updated ? { timestamp: updated } : {}),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "◀ Back", custom_id: `cl_${p - 1}`, disabled: p === 0 },
          { type: 2, style: 1, label: "Next ▶", custom_id: `cl_${p + 1}`, disabled: p >= pages - 1 },
        ],
      },
    ],
  };
}
// ---------- restricted commands: /addcrew and /editcrew ----------
// Secrets needed: ADMIN_IDS (Discord user IDs, separated by commas), GITHUB_TOKEN,
// GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (from the Google service account), DISCORD_APP_ID.
const REPO_API = "https://api.github.com/repos/eyeonspyweezer/opvrcinteractivemap";
const FLAG_RAW = "https://raw.githubusercontent.com/eyeonspyweezer/opvrcinteractivemap/main/crew-flags";
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

  const path = `crew-flags/${slugOf(crewName)}.${ext}`;

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
          name: "islandold",
          description: "Show the previous island information display",
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

      if (name === "island") {
        return json({
          type: 4,
          data: await islandMessage(
            String(i.data.options?.[0]?.value ?? "")
          )
        });
      }

      if (name === "islandold") {
        return json({
          type: 4,
          data: await islandMessageOld(
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
    }

    // autocomplete while typing an island name
    if (i.type === 4) {
      const typed = String(i.data.options?.find((o) => o.focused)?.value ?? "");

      const choices =
        (i.data.name === "group" || i.data.name === "crewinfo")
          ? await groupChoices(typed)
          : i.data.name === "editcrew"
            ? (isAdmin(env, i) ? await crewNameChoices(typed) : [])
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
        const [, pg] = i.data.custom_id.split("_");
        return json({ type: 7, data: await crewListPage(parseInt(pg, 10) || 0) });
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
