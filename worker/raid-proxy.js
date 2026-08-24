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
   adds CORS headers to the same response. */

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

    const region = (url.searchParams.get('region') || '').toLowerCase();
    const realm = url.searchParams.get('realm');
    const name = url.searchParams.get('name');
    if(!region || !realm || !name){
      return new Response(JSON.stringify({ error: 'missing region/realm/name' }), { status: 400, headers: corsHeaders });
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
