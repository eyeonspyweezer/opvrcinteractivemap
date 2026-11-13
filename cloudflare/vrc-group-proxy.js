const GROUP_ID = "grp_677be38a-564d-432f-be95-f2e319bb4b13";
const UPSTREAM = `https://search.vrcwwt.com/api/groups/${GROUP_ID}`;
const ALLOWED_ORIGIN = "https://eyeonspyweezer.github.io";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": status === 200 ? "public, max-age=60, s-maxage=300" : "no-store"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }});
    }
    if (request.headers.get("Origin") && request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (url.pathname !== "/" && url.pathname !== "/group") return json({ error: "Not found" }, 404);

    try {
      const upstream = await fetch(UPSTREAM, { headers: {
        "Accept": "application/json",
        "User-Agent": "OPVRCInteractiveMap/1.0 (+https://eyeonspyweezer.github.io/opvrcinteractivemap/)"
      }, cf: { cacheTtl: 300, cacheEverything: true }});
      if (!upstream.ok) {
        console.error(JSON.stringify({ event: "vrc_group_upstream_error", status: upstream.status }));
        return json({ error: "VRC Search request failed", upstream_status: upstream.status }, 502);
      }
      const data = await upstream.json();
      const group = data.group || data;
      const result = {
        name: group.name || null,
        icon_url: group.icon_url || group.iconUrl || null,
        banner_url: group.banner_url || group.bannerUrl || null,
        member_count: group.member_count ?? group.memberCount ?? null
      };
      if (!result.name && !result.icon_url && !result.banner_url) {
        console.error(JSON.stringify({ event: "vrc_group_unexpected_payload" }));
        return json({ error: "VRC Search returned an unexpected group response" }, 502);
      }
      return json(result);
    } catch (error) {
      console.error(JSON.stringify({ event: "vrc_group_proxy_error", message: String(error) }));
      return json({ error: "Unable to retrieve VRChat group metadata" }, 502);
    }
  }
};