/* Cloudflare Worker: proxies Blizzard's per-character raid/world-boss encounter
   data (which requires a client_credentials secret) so the static app can read
   it without ever exposing the Blizzard Client ID/Secret in browser code.

   Deploy via the Cloudflare dashboard (Workers & Pages > Create Worker > paste
   this file's contents > Deploy), then set two encrypted variables under
   Settings > Variables: BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.

   Usage: GET <worker-url>/?region=us&realm=illidan&name=Rawthedk
   Returns: { raid: [{boss, difficulty, lastKill}], worldBoss: [{tier, lastKill}] }
   lastKill is a Unix ms timestamp; the app compares it against its own
   weekly-reset boundary calculation to decide "killed this week or not".

   Second, unrelated usage: GET <worker-url>/?type=rio-run&season=season-mn-2&runId=71345
   Plain passthrough of Raider.IO's public mythic-plus/run-details endpoint (full party
   composition, deaths, per-encounter timing) — that endpoint has no CORS headers of its
   own, so the browser can't call it directly; this branch needs no Blizzard token, it just
   adds CORS headers to the same response.

   Third, unrelated usage: GET <worker-url>/?type=rio-mplus-summary&region=us&realm=illidan&name=Rawthedk&season=season-mn-2
   Passthrough of Raider.IO's undocumented internal character-page endpoint
   (raider.io/api/characters/...), trimmed down to just characterMythicPlusProgress.
   keystoneAggregateStats — the only season-wide (not per-dungeon; Raider.IO doesn't expose
   a per-dungeon breakdown anywhere) count of completed keystone runs this season, bucketed by
   level (0 = Mythic 0, 2 = keystone 2-4, 5 = keystone 5-9, 10 = keystone 10+). No "timed vs
   depleted" distinction is exposed by this endpoint, so don't infer one. Also needs no
   Blizzard token — just CORS headers on the same response.

   Fourth, unrelated usage: GET <worker-url>/?type=wowhead-news
   Wowhead's news page has no API/RSS feed and blocks direct fetches with a 403; this pulls
   it through r.jina.ai's reader proxy (which renders the page and returns readable text/
   markdown) and regex-extracts up to 5 {title, url} pairs from the "### [Title](url)"
   headings. Uses ?type=1 on the Wowhead URL, which is their own Live/Retail filter (confirmed
   by fetching it directly - every article it returns is tagged Live, none Classic/Hardcore/
   Cataclysm), so Classic-only news never shows up here. Also adds &contentTag=312, Wowhead's
   own "Hotfix" tag - confirmed by fetching it directly that this single tag is exactly class
   buffs/nerfs + dungeon/raid tuning + bug-fix/maintenance notes bundled together; Wowhead has
   no finer-grained tags to split those three apart, so this is the closest real filter to
   "only the balance/maintenance news that matters for a tracker" without inventing a filter
   that doesn't exist. No dates are available from this extraction. Also needs no Blizzard
   token.

   Fifth, unrelated usage: GET <worker-url>/?type=murlok-gear&mode=build&class=death-knight&spec=unholy&hero=san'layn
   or GET <worker-url>/?type=murlok-gear&mode=player&region=eu&realm=garona&name=ashproof
   Murlok.io serves real per-slot gear data directly in its HTML (no anti-bot block, no
   reader-proxy needed) - "build" mode hits their aggregate top-50-players build guide
   (murlok.io/{class}/{spec}/{hero?}/m+, hero omitted = "Overall"), "player" mode hits a
   specific character's own equipped gear (murlok.io/character/{region}/{realm}/{name}/pve).
   Both pages share the same <section id="gear"> markup, parsed here into
   { slots: { "Head": [{whId,name,icon,count}, ...], ... }, heroTalents: [{label,slug}, ...] } -
   build mode's items are ranked by real usage count among the sampled top players (count is
   null for player mode, which only ever has 1-2 items per slot - the player's actual gear).
   heroTalents is the real list of hero-talent build variants Murlok itself links to for that
   class/spec (including "" for the no-hero "Overall" page), scraped fresh rather than
   hardcoded, since hero talent names/slugs differ per spec and this way never goes stale.
   Verified against real saved pages for Unholy DK (Overall/San'layn/Rider of the Apocalypse)
   before shipping. No Blizzard token needed. */

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getBlizzardToken(env){
  const now = Date.now();
  if(cachedToken && cachedTokenExpiry > now) return cachedToken;
  const basic = btoa(`${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`);
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if(!res.ok) throw new Error('token request failed: ' + res.status);
  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiry = now + (json.expires_in - 60) * 1000;
  return cachedToken;
}

const RAID_INSTANCE_NAME = 'The Venomous Abyss';
const WORLD_BOSS_INSTANCE_NAME = 'Sporefall';

export default {
  async fetch(request, env){
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8'
    };
    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if(url.searchParams.get('type') === 'rio-run'){
      const season = url.searchParams.get('season');
      const runId = url.searchParams.get('runId');
      if(!season || !runId){
        return new Response(JSON.stringify({ error: 'missing season/runId' }), { status: 400, headers: corsHeaders });
      }
      try{
        const rioUrl = `https://raider.io/api/v1/mythic-plus/run-details?season=${encodeURIComponent(season)}&id=${encodeURIComponent(runId)}`;
        const res = await fetch(rioUrl);
        if(!res.ok){
          return new Response(JSON.stringify({ error: 'raider.io api error', status: res.status }), { status: res.status, headers: corsHeaders });
        }
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: corsHeaders });
      } catch(err){
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
      }
    }

    if(url.searchParams.get('type') === 'murlok-gear'){
      const mode = url.searchParams.get('mode');
      let murlokUrl;
      if(mode === 'build'){
        const cls = url.searchParams.get('class');
        const spec = url.searchParams.get('spec');
        const hero = url.searchParams.get('hero') || '';
        if(!cls || !spec){
          return new Response(JSON.stringify({ error: 'missing class/spec' }), { status: 400, headers: corsHeaders });
        }
        murlokUrl = `https://murlok.io/${cls}/${spec}/${hero ? hero + '/' : ''}m+`;
      } else if(mode === 'player'){
        const region = url.searchParams.get('region');
        const realm = url.searchParams.get('realm');
        const name = url.searchParams.get('name');
        if(!region || !realm || !name){
          return new Response(JSON.stringify({ error: 'missing region/realm/name' }), { status: 400, headers: corsHeaders });
        }
        murlokUrl = `https://murlok.io/character/${encodeURIComponent(region)}/${encodeURIComponent(realm)}/${encodeURIComponent(name.toLowerCase())}/pve`;
      } else {
        return new Response(JSON.stringify({ error: 'missing/invalid mode' }), { status: 400, headers: corsHeaders });
      }
      try{
        const res = await fetch(murlokUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } });
        if(!res.ok){
          return new Response(JSON.stringify({ error: 'murlok.io error', status: res.status }), { status: res.status, headers: corsHeaders });
        }
        const html = await res.text();
        const decodeEntities = s => s.replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>');

        const gearStart = html.indexOf('<section id="gear"');
        if(gearStart === -1){
          return new Response(JSON.stringify({ error: 'gear section not found - character or build may not exist' }), { status: 404, headers: corsHeaders });
        }
        const gearRest = html.slice(gearStart);
        const nextSectionRel = gearRest.indexOf('<section id=', 10);
        const gearHtml = nextSectionRel === -1 ? gearRest : gearRest.slice(0, nextSectionRel);

        const MURLOK_SLOTS = ['Head','Neck','Shoulders','Back','Chest','Wrist','Hands','Waist','Legs','Feet','Rings','Trinkets','Main Hand','Off Hand'];
        const slots = {};
        for(const slotName of MURLOK_SLOTS){
          const h3re = new RegExp(`<h3>${slotName}</h3>([\\s\\S]*?)</ol>`);
          const m = h3re.exec(gearHtml);
          if(!m) continue;
          const chunks = m[1].split('<li class="vi-poppable">').slice(1);
          const items = [];
          for(const chunk of chunks){
            const idM = /wowhead\.com\/item=(\d+)/.exec(chunk);
            const nameM = /<h4 class="h3">([^<]+)<\/h4>/.exec(chunk);
            const iconM = /<img[^>]*src="([^"]+)"/.exec(chunk);
            if(!idM || !nameM) continue;
            const countMs = [...chunk.matchAll(/vi-media-object-with-media-small">[\s\S]*?<\/svg>\s*(\d+)\s*<\/li>/g)];
            const count = countMs.length ? Number(countMs[countMs.length - 1][1]) : null;
            items.push({ whId: idM[1], name: decodeEntities(nameM[1]), icon: iconM ? iconM[1] : null, count });
          }
          if(items.length) slots[slotName] = items;
        }

        const heroTalents = [];
        const heroM = /<h2 class="h3">Hero Talents<\/h2>\s*<ul>([\s\S]*?)<\/ul>/.exec(html);
        if(heroM){
          const linkRe = /<a[^>]*href="([^"]+)">[\s\S]*?<img[^>]*>\s*([^<]+?)\s*<\/a>/g;
          let lm;
          while((lm = linkRe.exec(heroM[1]))){
            const parts = lm[1].split('/').filter(Boolean);
            const slug = parts.length === 4 ? parts[2] : '';
            heroTalents.push({ label: decodeEntities(lm[2].trim()), slug });
          }
        }

        return new Response(JSON.stringify({ slots, heroTalents }), { headers: corsHeaders });
      } catch(err){
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
      }
    }

    if(url.searchParams.get('type') === 'wowhead-news'){
      try{
        const res = await fetch('https://r.jina.ai/https://www.wowhead.com/news?type=1&contentTag=312');
        if(!res.ok){
          return new Response(JSON.stringify({ error: 'jina reader error', status: res.status }), { status: res.status, headers: corsHeaders });
        }
        const text = await res.text();
        const seen = new Set();
        const news = [];
        const re = /###\s*\[([^\]]+)\]\((https:\/\/www\.wowhead\.com\/news\/[^)]+)\)/g;
        let m;
        while((m = re.exec(text)) && news.length < 5){
          const link = m[2];
          if(seen.has(link)) continue;
          seen.add(link);
          news.push({ title: m[1].trim(), url: link });
        }
        return new Response(JSON.stringify({ news }), { headers: corsHeaders });
      } catch(err){
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
      }
    }

    const region = (url.searchParams.get('region') || '').toLowerCase();
    const realm = url.searchParams.get('realm');
    const name = url.searchParams.get('name');
    if(!region || !realm || !name){
      return new Response(JSON.stringify({ error: 'missing region/realm/name' }), { status: 400, headers: corsHeaders });
    }

    if(url.searchParams.get('type') === 'rio-mplus-summary'){
      const season = url.searchParams.get('season');
      if(!season){
        return new Response(JSON.stringify({ error: 'missing season' }), { status: 400, headers: corsHeaders });
      }
      try{
        const rioUrl = `https://raider.io/api/characters/${encodeURIComponent(region)}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}?season=${encodeURIComponent(season)}`;
        const res = await fetch(rioUrl);
        if(!res.ok){
          return new Response(JSON.stringify({ error: 'raider.io api error', status: res.status }), { status: res.status, headers: corsHeaders });
        }
        const data = await res.json();
        const stats = (data.characterMythicPlusProgress && data.characterMythicPlusProgress.keystoneAggregateStats) || [];
        return new Response(JSON.stringify({ keystoneAggregateStats: stats }), { headers: corsHeaders });
      } catch(err){
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
      }
    }

    try{
      const token = await getBlizzardToken(env);
      const apiUrl = `https://${region}.api.blizzard.com/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(name.toLowerCase())}/encounters/raids?namespace=profile-${region}&locale=en_US`;
      const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
      if(!res.ok){
        return new Response(JSON.stringify({ error: 'blizzard api error', status: res.status }), { status: res.status, headers: corsHeaders });
      }
      const data = await res.json();
      const raidMap = new Map();
      const worldBossMap = new Map();
      for(const exp of (data.expansions || [])){
        for(const inst of (exp.instances || [])){
          const instName = inst.instance && inst.instance.name;
          if(instName !== RAID_INSTANCE_NAME && instName !== WORLD_BOSS_INSTANCE_NAME) continue;
          for(const mode of (inst.modes || [])){
            const difficulty = mode.difficulty && mode.difficulty.type;
            for(const enc of ((mode.progress && mode.progress.encounters) || [])){
              const lastKill = enc.last_kill_timestamp || null;
              if(instName === RAID_INSTANCE_NAME){
                const key = enc.encounter.name + '|' + difficulty;
                const prev = raidMap.get(key);
                if(!prev || (lastKill || 0) > (prev.lastKill || 0)) raidMap.set(key, { boss: enc.encounter.name, difficulty, lastKill });
              } else {
                const prev = worldBossMap.get(difficulty);
                if(!prev || (lastKill || 0) > (prev.lastKill || 0)) worldBossMap.set(difficulty, { tier: difficulty, lastKill });
              }
            }
          }
        }
      }
      return new Response(JSON.stringify({ raid: [...raidMap.values()], worldBoss: [...worldBossMap.values()] }), { headers: corsHeaders });
    } catch(err){
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
    }
  }
};
