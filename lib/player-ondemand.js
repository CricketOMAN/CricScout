// Fast on-demand league player discovery and single-player profile scraping.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Pager, pool } = require('./pager');

let sharedPager = null;
function getPager() {
  if (!sharedPager) sharedPager = new Pager();
  return sharedPager;
}

const lite = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<link[^>]*>/gi, '');
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const iso = mdY => { const m = String(mdY || '').match(/(\d\d)\/(\d\d)\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : (mdY || null); };

const dropdowns = h => [...h.matchAll(/<ul class="dropdown-menu[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)]
  .map(m => [...m[1].matchAll(/href="[^"]*viewPointsTable\.do\?league=(\d+)[^"]*">([^<]*)</g)].map(x => ({ id: x[1], name: txt(x[2]) })))
  .filter(a => a.length);

function parseRankTable(h) {
  const i = h.indexOf('id="tablePlayerRankings"');
  if (i < 0) return [];
  const t = lite(h.slice(i));
  const thead = (t.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || '';
  const head = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
  if (!head.length) return [];
  const at = name => head.findIndex(col => col.toLowerCase().startsWith(name.toLowerCase()));
  const col = {
    name: at('Player'), group: at('Group'), team: at('Team'), matches: at('Matches'),
    batting: at('Batting'), bowling: at('Bowling'), fielding: at('Fielding'),
    other: at('Other'), mom: at('MOM'), total: at('Total')
  };
  const body = t.slice(t.indexOf('</thead>'));
  return body.split(/<tr[^>]*>\s*(?=<th align="left">\d+<\/th>)/).slice(1).map(chunk => {
    const team = txt((chunk.match(/<table>([\s\S]*?)<\/table>/) || [])[1]);
    const flat = chunk.replace(/<table>[\s\S]*?<\/table>/, team);
    const cells = [...flat.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
    const playerId = (chunk.match(/playerId=(\d+)/) || [])[1];
    if (!playerId || cells.length < head.length) return null;
    return {
      playerId,
      name: cells[col.name],
      group: col.group >= 0 ? cells[col.group] : null,
      team: cells[col.team],
      matches: num(cells[col.matches]),
      batting: num(cells[col.batting]),
      bowling: num(cells[col.bowling]),
      fielding: num(cells[col.fielding]),
      other: col.other >= 0 ? num(cells[col.other]) : 0,
      mom: col.mom >= 0 ? num(cells[col.mom]) : 0,
      total: num(cells[col.total])
    };
  }).filter(Boolean);
}

function parseStandingsRows(chunk, group) {
  const rows = [];
  for (const m of chunk.matchAll(/<tr>\s*<th>(\d+)<\/th>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(c => c[1]);
    const logo = (cells[0] && (cells[0].match(/<img src="([^"]+)"/) || [])[1]) || null;
    const tid = (cells[0] && (cells[0].match(/teamId=(\d+)/) || [])[1]) || null;
    const n = idx => Number(txt(cells[idx] || '')) || 0;
    rows.push({ position: +m[1], name: txt(cells[0]), teamId: tid, logo, played: n(1), won: n(2), lost: n(3), nr: n(4), tie: n(5), points: n(6), nrr: Number(txt(cells[8] || '')) || 0 });
  }
  return rows.map(r => ({ ...r, of: rows.length, group }));
}

function parseStandingsTable(h, group) {
  const blocks = [...h.matchAll(/(?:<h5[^>]*class="[^"]*btn-earth[^"]*"[^>]*>([\s\S]*?)<\/h5>\s*)?<div[^>]*>\s*<table[^>]*id="point-table"[^>]*>([\s\S]*?)<\/table>/gi)];
  if (blocks.length > 1) {
    const out = [];
    for (const b of blocks) {
      const sub = b[1] ? txt(b[1]) : '';
      const gLabel = [group, sub].filter(Boolean).join(' · ') || null;
      out.push(...parseStandingsRows(b[2], gLabel));
    }
    return out;
  }
  return parseStandingsRows(h, group);
}

// Fast on-demand league add: fetches league series + standings + playerRankings on the fly and streams progress.
async function addLeagueFast(code, onProgress = () => {}) {
  const pager = getPager();
  const base = `https://cricclubs.com/${code}`;
  onProgress({ done: 0, total: 4, phase: 'Discovering league on CricClubs…', players: 0 });
  const h = await pager.fetchHtml(`${base}/viewPointsTable.do`, { kind: 'pointsTable' });
  const clubId = (h.match(/clubId=(\d+)/) || [])[1] || null;
  const dds = dropdowns(h);
  const series = (dds[0] || []).filter((s, i, a) => a.findIndex(t => t.id === s.id) === i);
  if (!series.length) {
    return addNextJsLeagueFast(code, onProgress);
  }
  const rawTitle = txt((h.match(/<title>([^<]*)/) || [])[1] || '');
  const leagueName = rawTitle.replace(/\s*-\s*Points Table.*$/i, '').replace(/^Points Table\s*-\s*/i, '').trim() || code;
  const skip = /corporate|playoff|charity|practice|tournament|knock/i;
  const main = series.filter(s => !skip.test(s.name));
  const chosen = (main.length ? main : series).slice(0, 3);
  const keys = ['current', 'last', 'prev2'].slice(0, chosen.length);
  const totalSteps = chosen.length * 2;
  let doneSteps = 0;
  let uniquePlayers = new Set();

  const league = {
    code,
    clubId,
    name: leagueName,
    checkedAt: new Date().toISOString(),
    legacy: true,
    seasons: {},
    teams: [],
    logos: {},
    ingest: { refreshedAt: new Date().toISOString(), seasons: {} }
  };
  const teamNames = new Set();

  for (let i = 0; i < chosen.length; i++) {
    const k = keys[i];
    const s = chosen[i];
    onProgress({ done: doneSteps, total: totalSteps, phase: `Loading teams & standings for ${s.name}…`, players: uniquePlayers.size });
    const sh = await pager.fetchHtml(`${base}/viewPointsTable.do?league=${s.id}&clubId=${clubId || ''}`, { kind: 'pointsTable' });
    const sdd = dropdowns(sh);
    const groups = sdd.length > 1 ? sdd[sdd.length - 1] : [{ id: s.id, name: '' }];
    const allRows = [];
    const teams = {};
    const teamGroups = {};
    for (const g of groups) {
      const gh = g.id === s.id ? sh : await pager.fetchHtml(`${base}/viewPointsTable.do?league=${g.id}&clubId=${clubId || ''}`, { kind: 'groupPointsTable' });
      const gName = g.name ? (/^(group|division|div)/i.test(g.name) ? g.name : 'Group ' + g.name) : null;
      for (const r of parseStandingsTable(gh, gName)) {
        allRows.push(r);
        teams[r.name] = r.teamId;
        teamGroups[r.name] = g.id;
        if (r.logo && !league.logos[r.name]) league.logos[r.name] = r.logo;
        teamNames.add(r.name);
      }
    }
    const year = Number((s.name.match(/20\d\d/) || [])[0]) || null;
    const seasonObj = { id: 'legacy-' + s.id, name: s.name, startDate: null, year, teams, teamGroups, groups: groups.map(g => ({ id: g.id, name: g.name })) };
    league.seasons[k] = seasonObj;
    const stDoc = { series: { id: seasonObj.id, name: s.name }, playoffs: { found: false, pending: false }, teams: {} };
    for (const x of allRows) {
      stDoc.teams[x.name] = { position: x.position, of: x.of, group: x.group, played: x.played, won: x.won, lost: x.lost, nr: x.nr, points: x.points, nrr: x.nrr, logo: x.logo, playoff: null };
    }
    store.writeStandings(code, s.name, stDoc);
    doneSteps++;

    onProgress({ done: doneSteps, total: totalSteps, phase: `Downloading players for ${s.name}…`, players: uniquePlayers.size });
    const div = groups.length > 1 ? 'divisions=all&' : '';
    let rh = await pager.fetchHtml(`${base}/playerRankings.do?${div}league=${s.id}&clubId=${clubId || ''}`, { kind: 'rankings' });
    let rows = parseRankTable(rh);
    if (!rows.length && div) {
      rh = await pager.fetchHtml(`${base}/playerRankings.do?league=${s.id}&clubId=${clubId || ''}`, { kind: 'rankings' });
      rows = parseRankTable(rh);
    }
    if (rows.length >= 200 && groups.length > 1) {
      const byGroup = new Map();
      let capped = false;
      for (const g of groups) {
        const grh = await pager.fetchHtml(`${base}/playerRankings.do?league=${g.id}&clubId=${clubId || ''}`, { kind: 'rankings' });
        const gr = parseRankTable(grh);
        if (gr.length >= 200) { capped = true; break; }
        for (const r of gr) byGroup.set(r.playerId + '|' + r.team, r);
      }
      if (!capped && byGroup.size) rows = [...byGroup.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
    }
    if (rows.length >= 200 && Object.keys(teams).length) {
      const all = new Map();
      const entries = Object.entries(teams);
      let tDone = 0;
      await pool(entries, 4, async ([tName, tid]) => {
        if (!tid) return;
        const lid = teamGroups[tName] || s.id;
        const trh = await pager.fetchHtml(`${base}/playerRankings.do?league=${lid}&teamId=${tid}&clubId=${clubId || ''}`, { kind: 'rankings-team' });
        for (const r of parseRankTable(trh)) {
          all.set(r.playerId + '|' + tName, { ...r, team: r.team || tName });
          uniquePlayers.add(r.playerId);
        }
        tDone++;
        onProgress({ done: doneSteps, total: totalSteps, phase: `${s.name}: ${tDone}/${entries.length} teams' players downloaded…`, players: uniquePlayers.size });
      });
      if (all.size) rows = [...all.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
    }
    for (const r of rows) uniquePlayers.add(r.playerId);
    const rankDoc = {
      season: { key: k, id: seasonObj.id, name: s.name },
      fetchedAt: new Date().toISOString(),
      source: `${base}/playerRankings.do?${div}league=${s.id}&clubId=${clubId || ''}`,
      players: rows
    };
    const rfStore = path.join(store.STORE, 'leagues', store.codeKey(code), 'rankings', store.slug(s.name) + '.json');
    const rfSite = path.join(store.SITE, 'leagues', store.codeKey(code), 'rankings', store.slug(s.name) + '.json');
    store.writePretty(rfStore, rankDoc);
    store.writePretty(rfSite, rankDoc);
    store.writePretty(path.join(store.SITE, 'leagues', store.codeKey(code), 'standings', store.slug(s.name) + '.json'), stDoc);
    doneSteps++;
    onProgress({ done: doneSteps, total: totalSteps, phase: `Loaded ${s.name} (${rows.length} player entries)`, players: uniquePlayers.size });
  }

  league.teams = [...teamNames].sort((a, b) => a.localeCompare(b));
  store.writeLeague(league);
  const scanned = store.listScannedTeams(code).map(t => t.team).filter(n => league.teams.includes(n)).sort((a, b) => a.localeCompare(b));
  const pub = store.publicLeague(league, scanned);
  store.writePretty(path.join(store.SITE, 'leagues', store.codeKey(code), 'league.json'), pub);
  const idxPath = path.join(store.SITE, 'index.json');
  const idx = store.read(idxPath) || { generatedAt: new Date().toISOString(), leagues: [] };
  idx.leagues = (idx.leagues || []).filter(l => store.codeKey(l.code) !== store.codeKey(code));
  idx.leagues.push(pub);
  idx.leagues.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.code).localeCompare(String(b.code)));
  idx.generatedAt = new Date().toISOString();
  store.writePretty(idxPath, idx);
  return pub;
}

async function addNextJsLeagueFast(code, onProgress = () => {}) {
  const cc = require('./cc');
  onProgress({ done: 0, total: 4, phase: 'Discovering Next.js league on CricClubs…', players: 0 });
  const info = await cc.leagueInfo(code);
  if (!info) throw new Error(`Could not find CricClubs league "${code}"`);
  const allSeries = await cc.allSeriesList(info.code);
  const skip = /corporate|playoff|charity|practice|tournament|knock/i;
  const main = allSeries.filter(s => !skip.test(s.name));
  const chosen = (main.length ? main : allSeries).slice(0, 3);
  const keys = ['current', 'last', 'prev2'].slice(0, chosen.length);
  const totalSteps = chosen.length * 2;
  let doneSteps = 0;
  const uniquePlayers = new Set();
  const league = {
    code: info.code,
    id: info.id,
    name: info.name || info.code,
    checkedAt: new Date().toISOString(),
    seasons: {},
    teams: [],
    logos: {},
    ingest: { refreshedAt: new Date().toISOString(), seasons: {} }
  };
  const teamNames = new Set();

  for (let i = 0; i < chosen.length; i++) {
    const k = keys[i];
    const s = chosen[i];
    onProgress({ done: doneSteps, total: totalSteps, phase: `Loading teams & standings for ${s.name}…`, players: uniquePlayers.size });
    const pt = await cc.fetchPointsTable(info.code, info.id, s);
    const teams = {};
    const stDoc = { series: { id: s.id, name: s.name }, playoffs: { found: false, pending: false }, teams: {} };
    for (const g of pt.groups || []) {
      for (const r of g.rows || []) {
        teams[r.team] = r.teamId;
        teamNames.add(r.team);
        if (r.logo && !league.logos[r.team]) league.logos[r.team] = r.logo;
        stDoc.teams[r.team] = { position: r.position, of: g.rows.length, group: g.group, played: r.played, won: r.won, lost: r.lost, nr: r.nr, points: r.points, nrr: r.nrr, logo: r.logo, playoff: null };
      }
    }
    const year = Number(String(s.startDate || '').split('/')[2] || (s.name.match(/20\d\d/) || [])[0] || new Date().getFullYear());
    league.seasons[k] = { id: s.id, name: s.name, startDate: s.startDate || null, year, teams };
    store.writeStandings(info.code, s.name, stDoc);
    store.writePretty(path.join(store.SITE, 'leagues', store.codeKey(info.code), 'standings', store.slug(s.name) + '.json'), stDoc);
    doneSteps++;

    onProgress({ done: doneSteps, total: totalSteps, phase: `Downloading players for ${s.name}…`, players: uniquePlayers.size });
    let rows = await cc.playerRankings(info.code, info.id, s);
    if (rows.length >= 200 && Object.keys(teams).length) {
      const all = new Map();
      for (const [tName, tid] of Object.entries(teams)) {
        const tr = await cc.playerRankings(info.code, info.id, s, tid).catch(() => []);
        for (const r of tr) all.set(r.playerId + '|' + tName, { ...r, team: r.team || tName });
      }
      if (all.size) rows = [...all.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
    }
    for (const r of rows) uniquePlayers.add(r.playerId);
    const rankDoc = {
      season: { key: k, id: s.id, name: s.name },
      fetchedAt: new Date().toISOString(),
      source: `https://cricclubs.com/${info.code}/statistics/rankings-records?leagueId=${info.id}&year=${year}&series=${s.id}`,
      players: rows
    };
    store.writePretty(path.join(store.STORE, 'leagues', store.codeKey(info.code), 'rankings', store.slug(s.name) + '.json'), rankDoc);
    store.writePretty(path.join(store.SITE, 'leagues', store.codeKey(info.code), 'rankings', store.slug(s.name) + '.json'), rankDoc);
    doneSteps++;
    onProgress({ done: doneSteps, total: totalSteps, phase: `Loaded ${s.name} (${rows.length} player entries)`, players: uniquePlayers.size });
  }

  league.teams = [...teamNames].sort((a, b) => a.localeCompare(b));
  store.writeLeague(league);
  const scanned = store.listScannedTeams(info.code).map(t => t.team).filter(n => league.teams.includes(n)).sort((a, b) => a.localeCompare(b));
  const pub = store.publicLeague(league, scanned);
  store.writePretty(path.join(store.SITE, 'leagues', store.codeKey(info.code), 'league.json'), pub);
  const idxPath = path.join(store.SITE, 'index.json');
  const idx = store.read(idxPath) || { generatedAt: new Date().toISOString(), leagues: [] };
  idx.leagues = (idx.leagues || []).filter(l => store.codeKey(l.code) !== store.codeKey(info.code));
  idx.leagues.push(pub);
  idx.leagues.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.code).localeCompare(String(b.code)));
  idx.generatedAt = new Date().toISOString();
  store.writePretty(idxPath, idx);
  return pub;
}

// Parse viewPlayer.do + playerAllBattingRecords.do + playerAllBowlingRecords.do into a rich player profile JSON.
function parsePlayerProfile(code, clubId, playerId, vpHtml, batHtml, bowlHtml) {
  const base = `https://cricclubs.com/${code}`;
  const nameMatch = vpHtml.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) || vpHtml.match(/<title>([^<]*)/i);
  const name = nameMatch ? txt(nameMatch[1]).replace(/\s*-\s*.*$/, '').trim() : '';
  const extractField = label => {
    const m = vpHtml.match(new RegExp(label + '\\s*:\\s*<strong>([\\s\\S]*?)<\\/strong>', 'i'));
    return m ? txt(m[1]) : null;
  };
  const teamsLine = (vpHtml.match(/Teams\s*:\s*([\s\S]*?)<\/p>/i) || [])[1];
  const bio = {
    playingRole: extractField('Playing Role'),
    battingStyle: extractField('Batting Style'),
    bowlingStyle: extractField('Bowling Style'),
    teams: teamsLine ? txt(teamsLine).split(',').map(s => s.trim()).filter(Boolean) : [],
    profileUrl: `${base}/viewPlayer.do?playerId=${playerId}${clubId ? '&clubId=' + clubId : ''}`
  };

  // Cross-league career summary tabs on viewPlayer.do
  const tabNames = [...vpHtml.matchAll(/<li[^>]*class="[^"]*resp-tab-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)].map(m => txt(m[1])).filter(Boolean);
  const tables = [...vpHtml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]);
  const crossLeagues = [];
  for (let i = 0; i < tabNames.length; i++) {
    const batT = tables[2 + i * 2];
    const bowlT = tables[3 + i * 2];
    if (!batT) continue;
    const parseCareerRows = t => {
      if (!t) return [];
      const trs = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1])))
        .filter(cells => cells.length >= 10 && cells[0] !== 'Series Type' && !/loading|view statistics/i.test(cells[0]));
      return trs;
    };
    const batRows = parseCareerRows(batT).filter(r => num(r[1]) > 0);
    const bowlRows = parseCareerRows(bowlT).filter(r => num(r[1]) > 0);
    if (batRows.length || bowlRows.length) {
      crossLeagues.push({
        league: tabNames[i],
        batting: batRows.map(r => ({ format: r[0], mat: num(r[1]), inns: num(r[2]), no: num(r[3]), runs: num(r[4]), balls: num(r[5]), avg: r[6], sr: r[7], hs: r[8], hundreds: num(r[9]), fifties: num(r[10]), fours: num(r[13]), sixes: num(r[14]) })),
        bowling: bowlRows.map(r => ({ format: r[0], mat: num(r[1]), inns: num(r[2]), overs: r[3], runs: num(r[4]), wkts: num(r[5]), bbf: r[6], mdns: num(r[7]), avg: r[8], econ: r[9], sr: r[10], fourW: num(r[11]), fiveW: num(r[12]), catches: num(r[14]) }))
      });
    }
  }

  // Parse match-by-match batting records
  const byMatch = new Map();
  const ensureMatch = (mid, dateStr, team, against, winner) => {
    const key = mid || `${iso(dateStr)}|${team}|${against}`;
    if (!byMatch.has(key)) {
      byMatch.set(key, {
        id: mid || key,
        date: iso(dateStr),
        team,
        opponent: against,
        winner: winner || null,
        outcome: winner ? (winner.toLowerCase() === team.toLowerCase() ? 'W' : 'L') : 'NR',
        scorecard: mid ? `${base}/viewScorecard.do?matchId=${mid}${clubId ? '&clubId=' + clubId : ''}` : null,
        bat: null,
        bowl: null
      });
    }
    return byMatch.get(key);
  };

  for (const tr of lite(batHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const mid = (tr[1].match(/viewScorecard\.do\?matchId=(\d+)/i) || [])[1];
    if (!mid) continue;
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1]));
    if (cells.length < 12) continue;
    const [, dateStr, team, against, winner, posStr, runsStr, ballsStr, , foursStr, sixesStr, ptsStr] = cells;
    const m = ensureMatch(mid, dateStr, team, against, winner);
    const dnb = /dnb/i.test(runsStr);
    if (!dnb) {
      const notOut = /\*/.test(runsStr);
      const r = num(runsStr.replace(/\*/g, ''));
      const b = num(ballsStr);
      m.bat = {
        r,
        b,
        fours: num(foursStr),
        sixes: num(sixesStr),
        pos: num(posStr) || null,
        out: !notOut,
        howOut: notOut ? 'not out' : 'out',
        points: num(ptsStr)
      };
    }
  }

  for (const tr of lite(bowlHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const mid = (tr[1].match(/viewScorecard\.do\?matchId=(\d+)/i) || [])[1];
    if (!mid) continue;
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1]));
    if (cells.length < 12) continue;
    const [, dateStr, team, against, winner, oversStr, runsStr, wktsStr, , , widesStr, ptsStr] = cells;
    const m = ensureMatch(mid, dateStr, team, against, winner);
    const [ovWhole, ovPart] = String(oversStr || '0').split('.').map(x => Number(x) || 0);
    const balls = ovWhole * 6 + Math.min(5, ovPart || 0);
    if (balls > 0 || num(wktsStr) > 0 || num(runsStr) > 0) {
      m.bowl = {
        balls,
        m: 0,
        r: num(runsStr),
        w: num(wktsStr),
        wd: num(widesStr),
        nb: 0,
        points: num(ptsStr)
      };
    }
  }

  const matches = [...byMatch.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return {
    playerId: String(playerId),
    name,
    league: code,
    fetchedAt: new Date().toISOString(),
    bio,
    crossLeagues,
    matches
  };
}

async function fetchPlayerOnDemand(code, playerId) {
  if (!code || !playerId || !/^\d+$/.test(String(playerId))) {
    throw new Error('On-demand profile requires a numeric CricClubs playerId');
  }
  const siteFile = path.join(store.SITE, 'leagues', store.codeKey(code), 'players', `${playerId}.json`);
  const storeFile = path.join(store.STORE, 'leagues', store.codeKey(code), 'players', `${playerId}.json`);
  const cached = store.read(siteFile) || store.read(storeFile);
  if (cached && Array.isArray(cached.matches)) return cached;

  const lg = store.readLeague(code) || {};
  let clubId = lg.clubId || '';
  const pager = getPager();
  const base = `https://cricclubs.com/${code}`;
  if (!clubId) {
    // Discover clubId from viewPlayer.do orrankings source
    const siteLg = store.read(path.join(store.SITE, 'leagues', store.codeKey(code), 'league.json'));
    const rankDir = path.join(store.SITE, 'leagues', store.codeKey(code), 'rankings');
    if (fs.existsSync(rankDir)) {
      const firstRank = fs.readdirSync(rankDir).find(f => f.endsWith('.json'));
      if (firstRank) {
        const rDoc = store.read(path.join(rankDir, firstRank));
        const cid = rDoc && rDoc.source && (rDoc.source.match(/clubId=(\d+)/) || [])[1];
        if (cid) clubId = cid;
      }
    }
  }

  const q = `playerId=${encodeURIComponent(playerId)}${clubId ? '&clubId=' + encodeURIComponent(clubId) : ''}`;
  const [vpHtml, batHtml, bowlHtml] = await Promise.all([
    pager.fetchHtml(`${base}/viewPlayer.do?${q}`, { kind: 'playerBio' }),
    pager.fetchHtml(`${base}/playerAllBattingRecords.do?${q}`, { kind: 'playerBat' }),
    pager.fetchHtml(`${base}/playerAllBowlingRecords.do?${q}`, { kind: 'playerBowl' })
  ]);

  if (!clubId) {
    clubId = (vpHtml.match(/clubId=(\d+)/) || [])[1] || '';
  }

  const profile = parsePlayerProfile(code, clubId, playerId, vpHtml, batHtml, bowlHtml);
  store.writePretty(storeFile, profile);
  store.writePretty(siteFile, profile);
  return profile;
}

module.exports = { addLeagueFast, fetchPlayerOnDemand };
