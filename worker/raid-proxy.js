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
   before shipping. No Blizzard token needed.

   Sixth, unrelated usage: GET <worker-url>/?type=rio-world-top&season=season-mn-2
   Same real, documented Raider.IO endpoint that backs their own public world M+ leaderboard
   page (raider.io/api/v1/mythic-plus/runs) - no CORS header of its own either, same proxying
   need as rio-run. Queried once per current-season dungeon (real slugs confirmed by paging
   the "all dungeons" world leaderboard directly) to get each dungeon's own #1 world run - the
   single best run overall would just be whichever dungeon happens to be easiest to push that
   week, not one result per dungeon. Returns { topRuns: [{dungeon, shortName, icon, level,
   clearTimeMs, url, roster: [{name, class, spec, role}, ...]}, ...] } - shortName is
   Raider.IO's own real dungeon abbreviation (e.g. "KR" for Kings' Rest), taken straight from
   their dungeon object, not derived; roster is pre-sorted tank/healer/dps; url is the real
   per-run Raider.IO page (confirmed by constructing one from keystone_run_id/mythic_level/
   dungeon.slug and fetching it directly - resolves to a real 200). No Blizzard token needed.

   Seventh, unrelated usage: GET <worker-url>/?type=rio-class-meta&season=season-mn-2
   Same real Raider.IO runs endpoint as rio-world-top, but sampled per-region instead of
   world: 10 pages x 20/page for each of the 4 real regions (us/eu/kr/tw), aggregating every
   roster slot by class/spec - powers the "Meta Check" feature. Confirmed directly that
   region=world&dungeon=all hard-caps at page 100 (page 101 returns a real 400) and never
   drops below roughly +16-17 within that cap, since merging every region into one ranking
   means the very top of that merged ranking alone fills all 100 pages - that gave
   representativity data from only the tip of the elite. Splitting the same query per real
   region reaches much lower key levels far faster (confirmed: eu/us bottom out around +16,
   kr/tw around +12-13, at the same page depth), so combining a shallower sample across all
   four covers roughly 6-8 real key-level tiers each season instead of one narrow band -
   still every real run, no fabrication, and every region's page 0 is included so the actual
   world-record run is always still captured. Returns { totalRuns, totalPlayers, specs: [{class, spec, role,
   count, highestLevel, topRun: {level, dungeon, shortName, url}, deathSampleRuns: [{runId,
   level, dungeon, shortName, url}, ...], byDungeon: [{dungeon, shortName, level, icon, url},
   ...]}, ...] } - deathSampleRuns is up to 12 of that spec's real runs in the sample, chosen
   by sorting all its runs by level and taking evenly-spaced picks across the full range
   (not just the highest ones) so the frontend can fetch real death data for each (via the
   existing rio-run branch) and see whether deaths cluster from some key level upward, rather
   than only looking at a handful of runs all bunched at the same top level. byDungeon is that
   spec's own best real run in each individual dungeon it appeared in (also from the same
   sample, deduped by run id first) - a spec can be well-tested in one dungeon and absent from
   another within the sample, so this is a genuinely different signal from the single overall
   topRun. No Blizzard token needed. */

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

    if(url.searchParams.get('type') === 'rio-world-top'){
      const season = url.searchParams.get('season');
      if(!season) return new Response(JSON.stringify({ error: 'missing season' }), { status: 400, headers: corsHeaders });
      // Real, documented Raider.IO endpoint (raider.io/api/v1/mythic-plus/runs) - same one
      // that backs their own public leaderboards page - but it has no CORS header of its
      // own, so it needs the same proxying as every other Raider.IO call here. Queried once
      // per current-season dungeon (real slugs, confirmed by paging the "all dungeons"
      // world leaderboard directly and recording every distinct slug/name that came back)
      // to get each dungeon's own #1 world run, not just the single best run overall.
      const DUNGEON_SLUGS = ['voidscar-arena','kings-rest','den-of-nalorakk','temple-of-sethraliss','murder-row','the-blinding-vale','ruby-life-pools','altar-of-fangs'];
      try{
        const results = await Promise.all(DUNGEON_SLUGS.map(async slug => {
          const rioUrl = `https://raider.io/api/v1/mythic-plus/runs?season=${encodeURIComponent(season)}&region=world&dungeon=${slug}&affixes=all&page=0`;
          const res = await fetch(rioUrl);
          if(!res.ok) return null;
          const data = await res.json();
          const top = data.rankings && data.rankings[0];
          if(!top || !top.run) return null;
          const run = top.run;
          // Real Raider.IO run-page URL pattern (confirmed by constructing one and fetching
          // it directly - resolves to a real 200): /mythic-plus-runs/{season}/{run_id}-{level}-{dungeon-slug}
          const ROLE_ORDER = { tank: 0, healer: 1, dps: 2 };
          const roster = (run.roster || [])
            .map(m => ({
              name: m.character.name,
              class: m.character.class && m.character.class.name,
              spec: m.character.spec && m.character.spec.name,
              role: m.role
            }))
            .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
          return {
            dungeon: run.dungeon.name,
            shortName: run.dungeon.short_name || null,
            icon: run.dungeon.icon_url ? `https://cdn.raiderio.net${run.dungeon.icon_url}` : null,
            level: run.mythic_level,
            clearTimeMs: run.clear_time_ms || null,
            url: `https://raider.io/mythic-plus-runs/${encodeURIComponent(season)}/${run.keystone_run_id}-${run.mythic_level}-${run.dungeon.slug}`,
            roster
          };
        }));
        return new Response(JSON.stringify({ topRuns: results.filter(Boolean) }), { headers: corsHeaders });
      } catch(err){
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: corsHeaders });
      }
    }

    if(url.searchParams.get('type') === 'rio-class-meta'){
      const season = url.searchParams.get('season');
      if(!season) return new Response(JSON.stringify({ error: 'missing season' }), { status: 400, headers: corsHeaders });
      // Real Raider.IO runs endpoint, same one that backs rio-world-top, but sampled
      // differently: region=world&dungeon=all caps out hard at page 100 (confirmed directly -
      // page 101 returns a 400) and, within that cap, never drops below roughly +16-17,
      // because "world" merges all regions into one ranking and the very top of that merged
      // ranking alone is enough to fill 100 pages. That gave representativity data from only
      // the tip of the elite, not the "median-ish" pushing population the feature needs.
      // Querying each real region (us/eu/kr/tw) separately instead reaches much lower key
      // levels far faster, since each region's own population is far smaller - confirmed
      // directly: at the same page depth, eu/us reach ~+16, while kr/tw reach ~+12-13. Merging
      // a shallower sample from all four real regions covers roughly 6-8 real key-level tiers
      // (per-season, moves with whatever the actual top level is that season) instead of one.
      // Every region's page 0 is included, so the single world-record run (whichever region it
      // happens to be in) is still always captured - nothing is lost versus the old approach.
      const REGIONS = ['us', 'eu', 'kr', 'tw'];
      const PAGES_PER_REGION = 10;
      try{
        const pages = await Promise.all(REGIONS.flatMap(region =>
          Array.from({ length: PAGES_PER_REGION }, (_, i) =>
            fetch(`https://raider.io/api/v1/mythic-plus/runs?season=${encodeURIComponent(season)}&region=${region}&dungeon=all&affixes=all&page=${i}`)
              .then(res => res.ok ? res.json() : null)
              .catch(() => null)
          )
        ));
        const specMap = new Map();
        const seenRunIds = new Set();
        let totalRuns = 0;
        let totalPlayers = 0;
        for(const page of pages){
          if(!page || !Array.isArray(page.rankings)) continue;
          for(const r of page.rankings){
            const run = r.run;
            if(!run || seenRunIds.has(run.keystone_run_id)) continue;
            seenRunIds.add(run.keystone_run_id);
            totalRuns++;
            for(const m of (run.roster || [])){
              const cls = m.character.class && m.character.class.name;
              const spec = m.character.spec && m.character.spec.name;
              if(!cls || !spec) continue;
              totalPlayers++;
              const key = `${cls}|${spec}`;
              if(!specMap.has(key)){
                specMap.set(key, { class: cls, spec, role: m.role, count: 0, highestLevel: 0, topRun: null, runs: [] });
              }
              const entry = specMap.get(key);
              entry.count++;
              // Keep every run this spec appeared in (deduped/trimmed to the top 5 by level
              // below) - the frontend uses these run ids to lazily pull real death data for
              // just that spec's own highest runs, instead of fetching details for all 200
              // runs up front (which would be far too many subrequests for one invocation).
              entry.runs.push({
                runId: run.keystone_run_id, level: run.mythic_level, dungeon: run.dungeon.name,
                shortName: run.dungeon.short_name || null, dungeonSlug: run.dungeon.slug,
                icon: run.dungeon.icon_url ? `https://cdn.raiderio.net${run.dungeon.icon_url}` : null
              });
              if(run.mythic_level > entry.highestLevel){
                entry.highestLevel = run.mythic_level;
                entry.topRun = {
                  level: run.mythic_level,
                  dungeon: run.dungeon.name,
                  shortName: run.dungeon.short_name || null,
                  url: `https://raider.io/mythic-plus-runs/${encodeURIComponent(season)}/${run.keystone_run_id}-${run.mythic_level}-${run.dungeon.slug}`
                };
              }
            }
          }
        }
        const specs = [...specMap.values()].map(entry => {
          const uniqueRuns = new Map();
          entry.runs.forEach(r => {
            if(!uniqueRuns.has(r.runId) || r.level > uniqueRuns.get(r.runId).level) uniqueRuns.set(r.runId, r);
          });
          const allRuns = [...uniqueRuns.values()];
          // Level-spread sample for the death-insight feature: sort this spec's own runs by
          // level and take up to 12 evenly-spaced picks across the FULL range, instead of just
          // the highest ones - a sample confined to one narrow top-of-the-range band can't tell
          // the frontend whether deaths cluster from some key level upward, only whether deaths
          // happened at the single level everyone in the sample already plays at.
          const byLevel = [...allRuns].sort((a, b) => a.level - b.level);
          const SAMPLE_SIZE = Math.min(12, byLevel.length);
          let spread;
          if(byLevel.length <= SAMPLE_SIZE){
            spread = byLevel;
          } else {
            const step = (byLevel.length - 1) / (SAMPLE_SIZE - 1);
            const idxSet = new Set();
            for(let i = 0; i < SAMPLE_SIZE; i++) idxSet.add(Math.round(i * step));
            spread = [...idxSet].sort((a, b) => a - b).map(i => byLevel[i]);
          }
          const deathSampleRuns = spread.map(r => ({
            runId: r.runId, level: r.level, dungeon: r.dungeon, shortName: r.shortName,
            url: `https://raider.io/mythic-plus-runs/${encodeURIComponent(season)}/${r.runId}-${r.level}-${r.dungeonSlug}`
          }));
          // Best run per individual dungeon (not just the single overall best) - lets the
          // frontend show "highest run by dungeon" for the selected spec, since a spec can be
          // strong in one dungeon and untested in another within this same sample.
          // Grouped by dungeon display name rather than slug - the name is what every other
          // field here (topRun.dungeon, etc.) already keys off unconditionally, so grouping by
          // it keeps this in lockstep with topRun by construction instead of relying on a
          // second field (slug) staying consistent with the first.
          const dungeonMap = new Map();
          allRuns.forEach(r => {
            const prev = dungeonMap.get(r.dungeon);
            if(!prev || r.level > prev.level){
              dungeonMap.set(r.dungeon, {
                dungeon: r.dungeon, shortName: r.shortName, level: r.level, icon: r.icon,
                url: `https://raider.io/mythic-plus-runs/${encodeURIComponent(season)}/${r.runId}-${r.level}-${r.dungeonSlug}`
              });
            }
          });
          // Belt-and-suspenders guarantee: the single overall highest run for this spec must
          // always show up in the per-dungeon breakdown, no exceptions - explicitly reconcile
          // it in rather than only trusting it to fall out of the loop above.
          if(entry.topRun){
            const existing = dungeonMap.get(entry.topRun.dungeon);
            if(!existing || entry.topRun.level > existing.level){
              dungeonMap.set(entry.topRun.dungeon, {
                dungeon: entry.topRun.dungeon, shortName: entry.topRun.shortName, level: entry.topRun.level,
                icon: existing ? existing.icon : null, url: entry.topRun.url
              });
            }
          }
          const byDungeon = [...dungeonMap.values()].sort((a, b) => b.level - a.level);
          return { class: entry.class, spec: entry.spec, role: entry.role, count: entry.count, highestLevel: entry.highestLevel, topRun: entry.topRun, deathSampleRuns, byDungeon };
        });
        return new Response(JSON.stringify({ totalRuns, totalPlayers, specs }), { headers: corsHeaders });
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
        // Murlok's own CDN edge can serve a given page stale for a while (confirmed by
        // inspecting real response headers: cf-cache-status HIT with Age in the thousands of
        // seconds, even though the origin itself sends "Cache-Control: no-store" - their zone
        // ignores it). Confirmed this can't be forced from our side either: a fresh, never-
        // requested-before query string and explicit no-cache/Pragma request headers both still
        // came back HIT, so their cache key ignores the query string and their zone doesn't
        // honor client cache-bypass headers - there's no lever on our end to force a bypass.
        // Different edge nodes end up with different ages for the same URL, so this is a
        // transient, self-resolving inconsistency (that node's cache eventually expires and
        // repopulates), not something a code change here can fix. cacheTtl:0 at least stops us
        // from separately caching a stale copy of whatever we do get on our own zone.
        const res = await fetch(murlokUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
          cf: { cacheTtl: 0, cacheEverything: false }
        });
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
