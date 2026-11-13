// League-level ingest for a legacy (.do) club: per season, the Results index and official player points.
// Usage: CHROME_PATH=... node scripts/legacy-ingest.js <ClubCode> [--force]
//   Past seasons load once; the current season reloads only after the weekend rule (lib/ingest.refreshDue).
// Pages per season:
//   listMatches.do?league=<seasonId>&clubId=   every completed match: id, type, date, teams, result (all groups)
//   fixtures.do?league=<seasonId>&clubId=      same matches with team ids + ground
//   playerRankings.do?divisions=all&league=<seasonId>&clubId=  official points, capped at 200 rows by CricClubs;
//     when capped, one playerRankings.do?league=<seasonId>&teamId=<id>&clubId= per team instead.
const store = require('../lib/store');
const ingest = require('../lib/ingest');
const { Pager, pool, stats, concurrency } = require('../lib/pager');
const argv = process.argv.slice(2);
const FORCE = process.env.FORCE === '1' || argv.includes('--force');
const [code] = argv.filter(a => !/^--/.test(a));
const base = `https://cricclubs.com/${code}`;
const pager = new Pager();
const slot = { pg: null };
async function get(url, kind = 'page', ready = '#tablePlayerRankings, table, .footer, footer, body') {
  for (let i = 0; i < 2 && slot.pg && slot.pg.url().startsWith('https://cricclubs.com/'); i++) {
    try {
      const res = await slot.pg.evaluate(async u => {
        const r = await fetch(u);
        return { status: r.status, text: await r.text() };
      }, url);
      if (res && res.status === 200 && res.text && !/just a moment|security verification/i.test(res.text.slice(0, 1000))) {
        stats.pages++; stats.ok++; stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
        return res.text;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return pager.html(url, slot.pg ? { kind, ready } : { slot, kind, ready });
}
const CAP = 200;
const lite = h => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<link[^>]*>/gi, '');
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
// Server-rendered tables, parsed with plain string scans (no browser tab: these pages are 1-2 MB).
function ROWS(h) {
  const out = [];
  for (const m of lite(h).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const mid = (m[1].match(/viewScorecard\.do\?matchId=(\d+)/) || [])[1]; if (!mid) continue;
    const c = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(x => txt(x[1]));
    const d = c.findIndex(x => /^\d\d\/\d\d\/\d{4}$/.test(x)); if (d < 0) continue;
    out.push({ mid, d, c, teamIds: [...m[1].matchAll(/teamId=(\d+)/g)].map(x => x[1]) });
  }
  return out;
}
function RANK(h) {
  const i = h.indexOf('id="tablePlayerRankings"'); if (i < 0) return null;
  const t = lite(h.slice(i)); const thead = (t.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || '';
  const head = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
  const body = t.slice(t.indexOf('</thead>'));
  const rows = body.split(/<tr[^>]*>\s*(?=<th align="left">\d+<\/th>)/).slice(1).map(chunk => {
    const team = txt((chunk.match(/<table>([\s\S]*?)<\/table>/) || [])[1]);
    const flat = chunk.replace(/<table>[\s\S]*?<\/table>/, team);
    const cells = [...flat.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
    return { cells, playerId: (chunk.match(/playerId=(\d+)/) || [])[1] };
  });
  return { head, rows };
}
const iso = mdY => { const m = String(mdY).match(/(\d\d)\/(\d\d)\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const num = v => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
function rankRows(r) {
  if (!r) return [];
  const at = name => r.head.findIndex(h => h.toLowerCase().startsWith(name.toLowerCase()));
  const col = { name: at('Player'), group: at('Group'), team: at('Team'), matches: at('Matches'), batting: at('Batting'), bowling: at('Bowling'), fielding: at('Fielding'), other: at('Other'), mom: at('MOM'), total: at('Total') };
  return r.rows.filter(x => x.cells.length >= r.head.length && x.playerId).map(x => ({ playerId: x.playerId, name: x.cells[col.name], group: col.group >= 0 ? x.cells[col.group] : null, team: x.cells[col.team],
    matches: num(x.cells[col.matches]), batting: num(x.cells[col.batting]), bowling: num(x.cells[col.bowling]), fielding: num(x.cells[col.fielding]), other: col.other >= 0 ? num(x.cells[col.other]) : null, mom: col.mom >= 0 ? num(x.cells[col.mom]) : null, total: num(x.cells[col.total]) }));
}
async function results(s, sid, clubId, idName) {
  const lm = await get(`${base}/listMatches.do?league=${sid}&clubId=${clubId}`, 'results');
  const fx = await get(`${base}/fixtures.do?league=${sid}&clubId=${clubId}`, 'fixtures');
  const lr = ROWS(lm), fr = ROWS(fx);
  if (!lr.length && !fr.length && (s.groups || []).length > 1) {
    for (const g of s.groups) {
      if (String(g.id) === String(sid)) continue;
      const glm = await get(`${base}/listMatches.do?league=${g.id}&clubId=${clubId}`, 'results');
      const gfx = await get(`${base}/fixtures.do?league=${g.id}&clubId=${clubId}`, 'fixtures');
      lr.push(...ROWS(glm)); fr.push(...ROWS(gfx));
    }
  }
  const fxBy = new Map(); for (const r of fr) if (!fxBy.has(r.mid)) fxBy.set(r.mid, r);
  const matches = []; const seen = new Set(); const unmapped = new Set();
  for (const r of lr) { if (seen.has(r.mid)) continue; seen.add(r.mid);
    // listMatches row: #, Match Type, Date, Team One, Team two, Result, Scores Summary, Points
    const f = fxBy.get(r.mid); const fc = f && f.c;
    const teamIds = f && f.teamIds.length === 2 ? f.teamIds : r.teamIds;
    const shown = fc ? [fc[f.d + 2], fc[f.d + 3]] : [r.c[r.d + 1], r.c[r.d + 2]];
    const teams = teamIds.length === 2 ? teamIds.map((id, i) => { const n = idName[id]; if (!n) unmapped.add(`${shown[i]} (team id ${id} not in season teams)`); else if (n !== shown[i]) unmapped.add(`${shown[i]} -> ${n}`); return n || shown[i]; }) : shown;
    matches.push({ matchId: r.mid, scorecard: `${base}/viewScorecard.do?matchId=${r.mid}&clubId=${clubId}`, date: iso(r.c[r.d]), type: r.c[r.d - 1] || null, teams, teamIds, ground: fc ? fc[f.d + 4] || null : null, result: r.c[r.d + 3] || null, summary: r.c[r.d + 4] || null });
  }
  for (const r of fr) if (!seen.has(r.mid)) { seen.add(r.mid); matches.push({ matchId: r.mid, scorecard: `${base}/viewScorecard.do?matchId=${r.mid}&clubId=${clubId}`, date: iso(r.c[r.d]), type: r.c[r.d - 1] || null, teams: r.teamIds.map((id, i) => idName[id] || r.c[r.d + 2 + i]), teamIds: r.teamIds, ground: r.c[r.d + 4] || null, result: null, summary: null }); }
  return { matches, unmapped: [...unmapped] };
}
async function rankings(s, sid, clubId) {
  const div = (s.groups || []).length > 1 ? 'divisions=all&' : '';
  let h = await get(`${base}/playerRankings.do?${div}league=${sid}&clubId=${clubId}`, 'rankings');
  let rows = rankRows(RANK(h));
  if (!rows.length && div) {
    h = await get(`${base}/playerRankings.do?league=${sid}&clubId=${clubId}`, 'rankings');
    rows = rankRows(RANK(h));
  }
  let perTeam = false;
  if (rows.length >= CAP && (s.groups || []).length > 1) {
    const byGroup = new Map(); let cappedGroup = false;
    for (const g of s.groups) {
      const gh = await get(`${base}/playerRankings.do?league=${g.id}&clubId=${clubId}`, 'rankings');
      const gr = rankRows(RANK(gh));
      if (gr.length >= CAP) { cappedGroup = true; break; }
      for (const r of gr) byGroup.set(r.playerId + '|' + r.team, r);
    }
    if (!cappedGroup && byGroup.size) rows = [...byGroup.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
  }
  if (rows.length >= CAP) {
    perTeam = true; const all = new Map();
    await pool(Object.entries(s.teams || {}), concurrency(), async ([team, tid]) => {
      try { const th = await get(`${base}/playerRankings.do?league=${sid}&teamId=${tid}&clubId=${clubId}`, 'rankingsTeam');
        for (const r of rankRows(RANK(th))) all.set(r.playerId + '|' + r.team, r);
      } catch (e) { console.error('  rankings failed', team, e.message); }
    });
    rows = [...all.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
  }
  return { players: rows, perTeam };
}
(async () => {
  const t0 = Date.now();
  const deadline = Number(process.env.DEADLINE_MS || 0);
  const league = store.readLeague(code);
  if (!league) throw new Error('league not indexed: ' + code + ' (run legacy-league.js first)');
  const clubId = league.clubId; const report = {}; const doneKeys = [];
  const todo = ingest.plan(league, Object.keys(league.seasons || {}), { force: FORCE });
  for (const { key, s } of todo) {
    if (deadline && Date.now() > deadline) { console.error('ingest deadline reached; saving progress'); break; }
    const ts = Date.now(), p0 = stats.pages; const sid = s.id.replace(/^legacy-/, '');
    const idName = Object.fromEntries(Object.entries(s.teams || {}).map(([n, id]) => [String(id), n]));
    const r = await results(s, sid, clubId, idName);
    const rk = await rankings(s, sid, clubId);
    const teamNames = new Set(Object.keys(s.teams || {}));
    const rankTeamsUnknown = [...new Set(rk.players.map(p => p.team))].filter(t => !teamNames.has(t));
    const fetchedAt = new Date().toISOString();
    ingest.writeSeason(code, 'results', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: [`${base}/listMatches.do?league=${sid}&clubId=${clubId}`, `${base}/fixtures.do?league=${sid}&clubId=${clubId}`], matches: r.matches });
    ingest.writeSeason(code, 'rankings', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: `${base}/playerRankings.do?divisions=all&league=${sid}&clubId=${clubId}`, perTeam: rk.perTeam, players: rk.players });
    doneKeys.push(key);
    report[key] = { season: s.name, pages: stats.pages - p0, secs: +((Date.now() - ts) / 1000).toFixed(1), matches: r.matches.length, noGround: r.matches.filter(m => !m.ground).length, players: rk.players.length, perTeam: rk.perTeam, renamed: r.unmapped, rankTeamsUnknown };
    console.error(' ', key, JSON.stringify(report[key]));
  }
  if (doneKeys.length) { ingest.markRefreshed(league, doneKeys, stats.pages, +((Date.now() - t0) / 1000).toFixed(1)); store.writeLeague(league); }
  store.publish();
  console.log(JSON.stringify({ code, secs: +((Date.now() - t0) / 1000).toFixed(1), stats: { pages: stats.pages, byKind: stats.byKind, retries: stats.retries, failures: stats.failures }, seasons: report }));
  await pager.close();
})().catch(async e => { console.error(e); await pager.close(); process.exit(1); });
