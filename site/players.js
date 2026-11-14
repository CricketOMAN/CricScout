const $ = s => document.querySelector(s);
let LEAGUE = null, CATALOG = [], PLAYERS = [], PLAYER_MAP = new Map(), CURRENT = null;
let loadGen = 0, playerIndex = [], playerActive = -1, pageTab = 'overview', periodChoice = 'all';

const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
const ov = b => Math.floor(b / 6) + '.' + b % 6;
const f1 = x => isFinite(x) ? x.toFixed(1) : '–';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ini = n => String(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const HUES = ['#2fd27a', '#ffc83d', '#4cc3ff', '#ff8a95', '#b78cff', '#7ee0c3', '#ffa05c'];
const hue = n => HUES[[...String(n || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % HUES.length];
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normKey = s => String(s || '').toLowerCase().replace(/[*†\u2020]/g, '').replace(/\s+/g, ' ').trim();
const normPts = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

function remember(k, v) { try { localStorage[k] = v; } catch (e) {} }
function recall(k) { try { return localStorage[k] || ''; } catch (e) { return ''; } }
function msg(t) { const m = $('#msg'); m.hidden = !t; m.textContent = t || ''; }
function leagueByCode(code) { return CATALOG.find(l => l.code.toLowerCase() === String(code || '').toLowerCase()) || null; }
function teamLogo(name) { return (LEAGUE && LEAGUE.logos && LEAGUE.logos[name]) || ''; }
function face(name, url, cls) {
  const c = cls || 'logo-img';
  if (url) return `<img class="${c}" alt="" src="${esc(url)}">`;
  return `<span class="av sm${cls ? ' ' + cls : ''}" style="background:${hue(name)}">${esc(ini(name))}</span>`;
}
function badgeHTML(name, url) {
  const letters = esc(ini(name));
  if (!url) return `<div class="badge" style="background:${hue(name)};color:#08130d">${letters}</div>`;
  return `<div class="badge has-logo">${face(name, url, 'logo-img')}<span class="fallback">${letters}</span></div>`;
}
const card = (icon, t, h, tag) => `<section class="card"><div class="ch"><span class="ic" aria-hidden="true">${icon}</span><h2>${t}</h2>${tag ? `<span class="tag">${tag}</span>` : ''}</div>${h}</section>`;
const tbl = (cols, rows) => `<table><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
function donut(parts, center) {
  const clean = parts.filter(p => p.v > 0);
  const tot = clean.reduce((s, p) => s + p.v, 0) || 1;
  let a = 0; const R = 40, C = 2 * Math.PI * R;
  const arcs = clean.map(p => {
    const len = C * p.v / tot;
    const s = `<circle r="${R}" cx="50" cy="50" fill="none" stroke="${p.c}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-a}" transform="rotate(-90 50 50)"/>`;
    a += len; return s;
  }).join('');
  return `<svg class="donut" viewBox="0 0 100 100" role="img" aria-label="${parts.map(p => p.l + ' ' + p.v).join(', ')}"><circle r="${R}" cx="50" cy="50" fill="none" stroke="#ffffff10" stroke-width="14"/>${arcs}<text x="50" y="49" text-anchor="middle" fill="#eef5f0" font-size="20" font-family="Bebas Neue,Impact,sans-serif">${center[0]}</text><text x="50" y="63" text-anchor="middle" fill="#9fb5a8" font-size="8">${center[1]}</text></svg><div class="leg">${parts.map(p => `<span><i style="background:${p.c}"></i>${p.l} ${p.v}</span>`).join('')}</div>`;
}

function resultMark(match) {
  const outcome = match && match.outcome;
  const forfeit = !!(match && match.forfeit);
  if (forfeit && outcome === 'W') return { code: 'FW', word: 'Forfeited win' };
  if (forfeit && outcome === 'L') return { code: 'FL', word: 'Forfeited loss' };
  if (outcome === 'W') return { code: 'W', word: 'Win' };
  if (outcome === 'L') return { code: 'L', word: 'Loss' };
  if (outcome === 'NR') return { code: 'NR', word: 'No result' };
  return { code: outcome || '', word: outcome || 'Result' };
}
function resultBadge(m, extra) {
  const mark = resultMark(m);
  const when = [m && m.date, m && m.opponent ? 'vs ' + m.opponent : ''].filter(Boolean).join(' ');
  const tip = when ? mark.word + ' · ' + when : mark.word;
  return `<span class="fc ${esc(mark.code)}" title="${esc(tip)}" aria-label="${esc(tip)}"${extra || ''}>${esc(mark.code)}</span>`;
}

const PAGE_TABS = [['overview', 'Overview'], ['pathway', 'Pathway & Teams'], ['matches', 'Match Log']];

function welcomeHTML() {
  return `<section class="welcome" id="welcome"><div class="wball"></div><h1>Scout any<br><span>player.</span></h1><p>Pick a league above to load all players across every scanned team and season, then search any player for their complete profile.</p><div class="eg">Try <button class="chip" type="button" data-lg="GPCL">GPCL</button> <button class="chip" type="button" data-lg="USACricketJunior">USACricketJunior</button> <button class="chip" type="button" data-lg="DublinandDanvilleCricketLeague">DDCL</button></div></section>`;
}

function loadingHTML(leagueName, done, total, playerCount, matchCount) {
  const pctDone = total ? Math.round(100 * done / total) : 0;
  return `<section class="welcome" id="loadingPanel">
    <div class="wball"></div>
    <h1>Loading<br><span>players…</span></h1>
    <p class="lead">${esc(leagueName)}</p>
    <div class="load-stat"><b id="loadCount">${done} / ${total}</b> <span>teams loaded (${pctDone}%)</span></div>
    <div class="pbar" style="max-width:340px;margin:12px 0"><i id="loadBar" style="width:${pctDone}%"></i></div>
    <p class="hint" id="loadSub">${playerCount.toLocaleString()} players indexed across ${matchCount.toLocaleString()} team-matches…</p>
  </section>`;
}

function updateLoadingDOM(done, total, playerCount, matchCount) {
  const pctDone = total ? Math.round(100 * done / total) : 0;
  const c = $('#loadCount'), b = $('#loadBar'), s = $('#loadSub');
  if (c) c.textContent = `${done} / ${total}`;
  if (c && c.nextElementSibling) c.nextElementSibling.textContent = `teams loaded (${pctDone}%)`;
  if (b) b.style.width = pctDone + '%';
  if (s) s.textContent = `${playerCount.toLocaleString()} players indexed across ${matchCount.toLocaleString()} team-matches…`;
}

function roleInfo(st) {
  const bowls = st.balls >= 12 || st.w >= 1;
  const bats = st.b >= 12 || st.r >= 15;
  const bits = [];
  if (st.k > 0 || st.st > 0) bits.push('<span class="role wk">WK</span>');
  if (bowls && bats) bits.push('<span class="role ar">All-rounder</span>');
  else if (bowls) bits.push('<span class="role bowl">Bowler</span>');
  else if (bats || st.inn > 0) bits.push('<span class="role bat">Batter</span>');
  const label = (st.k > 0 || st.st > 0) ? 'WK' : (bowls && bats) ? 'All-rounder' : bowls ? 'Bowler' : 'Batter';
  return { html: bits.join(''), label, isBat: bats || st.inn > 0, isBowl: bowls, isAR: bowls && bats, isWK: st.k > 0 || st.st > 0 };
}

function summarizeApps(apps) {
  const st = {
    mat: apps.length, w: 0, l: 0, inn: 0, no: 0, outs: 0, r: 0, b: 0, f: 0, s: 0,
    hs: -1, hsNo: false, thirties: 0, fifties: 0, hundreds: 0, posSum: 0, posN: 0, how: {},
    spells: 0, opens: 0, balls: 0, br: 0, wkts: 0, dots: 0, wd: 0, nb: 0, bw: -1, bbr: 0, threeW: 0, fiveW: 0,
    c: 0, k: 0, ro: 0, st: 0,
    bfInn: 0, bfR: 0, bfB: 0, bfOuts: 0, chInn: 0, chR: 0, chB: 0, chOuts: 0,
    winR: 0, winB: 0, winW: 0, winBalls: 0, winBr: 0
  };
  for (const a of apps) {
    if (a.outcome === 'W') st.w++;
    else if (a.outcome === 'L') st.l++;
    if (a.bat) {
      const r = a.bat.r || 0, b = a.bat.b || 0, out = !!a.bat.out;
      st.inn++; st.r += r; st.b += b; st.f += a.bat.f || 0; st.s += a.bat.s || 0;
      if (out) { st.outs++; if (a.bat.how) st.how[a.bat.how] = (st.how[a.bat.how] || 0) + 1; }
      else st.no++;
      if (r >= 100) st.hundreds++;
      else if (r >= 50) st.fifties++;
      else if (r >= 30) st.thirties++;
      if (r > st.hs || (r === st.hs && !out)) { st.hs = r; st.hsNo = !out; }
      if (a.bat.pos) { st.posSum += a.bat.pos; st.posN++; }
      if (a.battedFirst === true) { st.bfInn++; st.bfR += r; st.bfB += b; if (out) st.bfOuts++; }
      else if (a.battedFirst === false) { st.chInn++; st.chR += r; st.chB += b; if (out) st.chOuts++; }
      if (a.outcome === 'W') { st.winR += r; st.winB += b; }
    }
    if (a.bowl) {
      const w = a.bowl.w || 0, br = a.bowl.r || 0, balls = a.bowl.balls || 0;
      st.spells++; st.balls += balls; st.br += br; st.wkts += w;
      st.dots += a.bowl.dots || 0; st.wd += a.bowl.wd || 0; st.nb += a.bowl.nb || 0;
      if (a.bowl.opened) st.opens++;
      if (w >= 5) st.fiveW++;
      else if (w >= 3) st.threeW++;
      if (w > st.bw || (w === st.bw && br < st.bbr)) { st.bw = w; st.bbr = br; }
      if (a.outcome === 'W') { st.winW += w; st.winBalls += balls; st.winBr += br; }
    }
    if (a.field) {
      st.c += a.field.c || 0;
      st.k += a.field.k || 0;
      st.ro += a.field.ro || 0;
      st.st += a.field.st || 0;
    }
  }
  st.w_ = st.wkts;
  st.sr = st.b ? 100 * st.r / st.b : NaN;
  st.avg = st.outs ? st.r / st.outs : NaN;
  st.boundPct = st.r ? 100 * (4 * st.f + 6 * st.s) / st.r : 0;
  const nonBound = Math.max(0, st.r - 4 * st.f - 6 * st.s);
  const estDots = st.b - st.f - st.s - nonBound;
  st.batDotPct = st.b > 0 && estDots >= 0 ? 100 * estDots / st.b : NaN;
  st.econ = st.balls ? 6 * st.br / st.balls : NaN;
  st.bavg = st.wkts ? st.br / st.wkts : NaN;
  st.bsr = st.wkts ? st.balls / st.wkts : NaN;
  st.dotPct = st.balls ? 100 * st.dots / st.balls : NaN;
  st.fldTot = st.c + st.k + st.ro + st.st;
  st.avgPos = st.posN ? st.posSum / st.posN : null;
  st.role = roleInfo({ ...st, w: st.wkts });
  return st;
}

function indexPlayers(list) {
  playerIndex = list.map(p => {
    const teamStr = p.teams.join(' ');
    const words = (p.name + ' ' + teamStr).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const nameWords = p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return {
      key: p.key,
      name: p.name,
      low: p.name.toLowerCase(),
      teamLow: teamStr.toLowerCase(),
      initials: nameWords.map(w => w[0]).join(''),
      words,
      teams: p.teams,
      summary: p.summary
    };
  });
}

function playerMatchesQuery(q, p) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return false;
  if (p.low.includes(s) || p.teamLow.includes(s)) return true;
  const compact = s.replace(/[^a-z0-9]/g, '');
  if (compact && p.initials.startsWith(compact)) return true;
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length > 1 && parts.every(pt => p.words.some(w => w.startsWith(pt)));
}

function playerHits(q) {
  const s = String(q || '').toLowerCase().trim();
  const compact = s.replace(/[^a-z0-9]/g, '');
  return playerIndex.filter(p => playerMatchesQuery(s, p)).sort((a, b) => {
    const rank = p => p.low.startsWith(s) ? 0 : p.low.includes(s) ? 1 : (compact && p.initials.startsWith(compact) ? 2 : 3);
    return rank(a) - rank(b) || (b.summary.mat - a.summary.mat) || a.name.localeCompare(b.name);
  }).slice(0, 60);
}

function closePlayerList() {
  const list = $('#playerList');
  if (list) list.hidden = true;
  const input = $('#playerSearch');
  if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  playerActive = -1;
}

function restorePlayerText() {
  const input = $('#playerSearch'); if (!input) return;
  input.value = CURRENT ? CURRENT.name : '';
  const clear = $('#playerClear');
  if (clear) clear.hidden = !input.value;
}

function paintPlayerActive() {
  const list = $('#playerList'); if (!list) return;
  const opts = [...list.querySelectorAll('[role="option"]')];
  opts.forEach((el, i) => {
    const on = i === playerActive;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const input = $('#playerSearch');
  if (input) {
    if (playerActive >= 0 && opts[playerActive]) input.setAttribute('aria-activedescendant', opts[playerActive].id);
    else input.removeAttribute('aria-activedescendant');
  }
  if (opts[playerActive]) opts[playerActive].scrollIntoView({ block: 'nearest' });
}

function openPlayerList() {
  const input = $('#playerSearch'), list = $('#playerList');
  if (!input || !list || input.disabled) return;
  const q = input.value.trim();
  const clear = $('#playerClear');
  if (clear) clear.hidden = !input.value;
  if (!q) { closePlayerList(); return; }
  const hits = playerHits(q);
  playerActive = hits.length ? 0 : -1;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  list.innerHTML = hits.length ? hits.map((p, i) => {
    const st = p.summary;
    const teamTxt = p.teams.slice(0, 2).join(', ') + (p.teams.length > 2 ? ` +${p.teams.length - 2}` : '');
    const statBits = [`${st.mat}m`];
    if (st.inn > 0) statBits.push(`${st.r}r`);
    if (st.wkts > 0) statBits.push(`${st.wkts}w`);
    return `<div class="team-opt${i === 0 ? ' on' : ''}" role="option" id="pl-opt-${i}" data-player="${esc(p.key)}" aria-selected="${i === 0 ? 'true' : 'false'}">
      <span class="av sm" style="background:${hue(p.name)}">${esc(ini(p.name))}</span>
      <span class="tn"><b>${esc(p.name)} ${st.role.html}</b><span class="opt-sub">${esc(teamTxt)}</span></span>
      <span class="grp">${esc(statBits.join(' · '))}</span>
    </div>`;
  }).join('') : '<div class="team-none" role="status">No players match</div>';
  if (playerActive >= 0) input.setAttribute('aria-activedescendant', 'pl-opt-0');
}

function readyOverviewHTML() {
  if (!LEAGUE) return welcomeHTML();
  if (!PLAYERS.length) {
    return card('📋', 'No scanned players yet', `<p>No team match data has been scanned for <b>${esc(LEAGUE.name)}</b> yet. Run a scan or pick another league.</p>`);
  }
  const topBat = [...PLAYERS].sort((a, b) => b.summary.r - a.summary.r || b.summary.sr - a.summary.sr).slice(0, 8);
  const topBowl = [...PLAYERS].sort((a, b) => b.summary.wkts - a.summary.wkts || (a.summary.econ || 99) - (b.summary.econ || 99)).slice(0, 8);
  const plRow = (p, i, sub, val, k, barPct, col) => `<div class="pl pl-pick" data-pick-player="${esc(p.key)}" role="button" tabindex="0"><span class="rank">${i}</span><span class="av" style="background:${hue(p.name)}">${esc(ini(p.name))}</span><div class="pn"><b>${esc(p.name)}</b><div class="roles">${p.summary.role.html}</div><span>${sub}</span><div class="mbar"><i style="width:${Math.max(4, barPct)}%;background:${col}"></i></div></div><div class="big"><div class="v">${val}</div><div class="k">${k}</div></div></div>`;
  const mxR = Math.max(1, ...topBat.map(p => p.summary.r));
  const mxW = Math.max(1, ...topBowl.map(p => p.summary.wkts));
  const batHTML = topBat.filter(p => p.summary.r > 0).map((p, i) => {
    const s = p.summary;
    const t = p.teams[0] || '';
    return plRow(p, i + 1, `${esc(t)}${p.teams.length > 1 ? ` (+${p.teams.length - 1})` : ''} · ${s.inn} inns · avg ${f1(s.avg)} · SR ${f1(s.sr)}`, s.r, 'Runs', 100 * s.r / mxR, 'var(--sky)');
  }).join('');
  const bowlHTML = topBowl.filter(p => p.summary.wkts > 0).map((p, i) => {
    const s = p.summary;
    const t = p.teams[0] || '';
    return plRow(p, i + 1, `${esc(t)}${p.teams.length > 1 ? ` (+${p.teams.length - 1})` : ''} · ${ov(s.balls)} ov · econ ${f1(s.econ)} · best ${s.bw}/${s.bbr}`, s.wkts, 'Wickets', 100 * s.wkts / mxW, 'var(--red)');
  }).join('');
  return card('✅', 'Players loaded', `<p class="hsum" style="margin-top:0"><b>${PLAYERS.length.toLocaleString()}</b> players indexed from <b>${(LEAGUE.scanned || []).length}</b> scanned teams in <b>${esc(LEAGUE.name)}</b>. Search any player above or tap a leader below.</p>
    ${batHTML ? `<h3>Top run scorers</h3>${batHTML}` : ''}
    ${bowlHTML ? `<h3>Top wicket takers</h3>${bowlHTML}` : ''}`, `${(LEAGUE.scanned || []).length}/${(LEAGUE.scanned || []).length} teams`);
}

async function loadLeaguePlayers(code, initialPlayerKey) {
  const league = leagueByCode(code);
  if (!league) return false;
  const gen = ++loadGen;
  LEAGUE = league;
  CURRENT = null;
  PLAYERS = [];
  PLAYER_MAP = new Map();
  $('#leagueSel').value = league.code;
  remember('lg', league.code);
  const navTeams = $('#navTeams');
  if (navTeams) navTeams.href = 'index.html?league=' + encodeURIComponent(league.code);
  $('#league').textContent = `${league.name} · Player Scout`;
  hideDock();
  closePlayerList();
  const input = $('#playerSearch');
  if (input) { input.value = ''; input.disabled = true; input.placeholder = 'Loading players…'; }
  const clear = $('#playerClear');
  if (clear) clear.hidden = true;
  $('#period').disabled = true;

  const scanned = league.scanned || [];
  const total = scanned.length;
  $('#main').innerHTML = loadingHTML(league.name, 0, total, 0, 0);
  if (!total) {
    $('#main').innerHTML = readyOverviewHTML();
    return true;
  }

  const byPlayer = new Map();
  let done = 0, matchCount = 0;

  const ensurePlayer = rawName => {
    const clean = String(rawName || '').replace(/[*†\u2020]/g, '').replace(/\s+/g, ' ').trim();
    const key = normKey(clean);
    if (!key) return null;
    let p = byPlayer.get(key);
    if (!p) {
      p = { key, name: clean, teamsSet: new Set(), seriesMap: new Map(), appsMap: new Map(), pointsMap: new Map() };
      byPlayer.set(key, p);
    }
    return p;
  };

  const queue = scanned.slice();
  const workers = Array.from({ length: Math.min(8, total) }, async () => {
    while (queue.length) {
      if (gen !== loadGen) return;
      const teamName = queue.shift();
      try {
        const r = await fetch(`data/leagues/${league.code.toLowerCase()}/teams/${slug(teamName)}.json`, { cache: 'no-store' });
        if (r.ok && gen === loadGen) {
          const d = await r.json();
          const tName = d.team || teamName;
          for (const [, sObj] of Object.entries(d.seasons || {})) {
            if (!sObj || !sObj.points || !sObj.points.players) continue;
            for (const [, row] of Object.entries(sObj.points.players)) {
              const p = ensurePlayer(row.name);
              if (!p) continue;
              p.teamsSet.add(tName);
              p.pointsMap.set(`${sObj.id}|${tName}`, { seriesId: sObj.id, seriesName: sObj.name, team: tName, ...row });
            }
          }
          for (const m of d.matches || []) {
            if (!m || m.forfeit) continue;
            matchCount++;
            const appKeyPrefix = `${m.id}|${tName}`;
            const touchApp = rawName => {
              const p = ensurePlayer(rawName);
              if (!p) return null;
              p.teamsSet.add(tName);
              if (m.seriesId) p.seriesMap.set(m.seriesId, { id: m.seriesId, name: m.series || m.seriesId });
              let app = p.appsMap.get(appKeyPrefix);
              if (!app) {
                app = {
                  id: m.id, date: m.date, series: m.series, seriesId: m.seriesId,
                  team: tName, opponent: m.opponent, ground: m.ground, result: m.result,
                  outcome: m.outcome, forfeit: !!m.forfeit, battedFirst: m.battedFirst,
                  tossWonByUs: m.tossWonByUs, tossDecision: m.tossDecision,
                  innings: m.innings || [], bat: null, bowl: null, field: null
                };
                p.appsMap.set(appKeyPrefix, app);
              }
              return app;
            };
            for (const b of m.batting || []) {
              const app = touchApp(b.name);
              if (app) app.bat = { r: b.r || 0, b: b.b || 0, f: b.f || 0, s: b.s || 0, out: !!b.out, how: b.how || null, pos: b.pos || null, howText: b.howText || null };
            }
            (m.bowling || []).forEach((w, idx) => {
              const app = touchApp(w.name);
              if (app) app.bowl = { balls: w.balls || 0, r: w.r || 0, w: w.w || 0, dots: w.dots || 0, wd: w.wd || 0, nb: w.nb || 0, opened: idx < 2 };
            });
            for (const [fn, fk, fc] of m.fielding || []) {
              const app = touchApp(fn);
              if (app) {
                app.field = app.field || { c: 0, k: 0, ro: 0, st: 0 };
                if (fk === 'c') app.field.c += fc;
                else if (fk === 'k') app.field.k += fc;
                else if (fk === 'r') app.field.ro += fc;
                else if (fk === 's') app.field.st += fc;
              }
            }
          }
        }
      } catch (e) {}
      done++;
      if (gen === loadGen) updateLoadingDOM(done, total, byPlayer.size, matchCount);
    }
  });

  await Promise.all(workers);
  if (gen !== loadGen) return false;

  PLAYERS = [...byPlayer.values()].map(p => {
    const apps = [...p.appsMap.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
    const teams = [...p.teamsSet].sort((a, b) => a.localeCompare(b));
    const seasons = [...p.seriesMap.values()];
    const summary = summarizeApps(apps);
    return { key: p.key, name: p.name, teams, seasons, apps, pointsMap: p.pointsMap, summary };
  }).filter(p => p.apps.length > 0 || p.pointsMap.size > 0).sort((a, b) => a.name.localeCompare(b.name));

  PLAYER_MAP = new Map(PLAYERS.map(p => [p.key, p]));
  indexPlayers(PLAYERS);

  if (input) {
    input.disabled = false;
    input.placeholder = `Search ${PLAYERS.length.toLocaleString()} players (name or team)…`;
  }
  $('#period').disabled = false;

  const wanted = normKey(initialPlayerKey || recall('player_' + league.code));
  if (wanted && PLAYER_MAP.has(wanted)) {
    choosePlayer(wanted);
  } else {
    $('#main').innerHTML = readyOverviewHTML();
  }
  return true;
}

function fillPlayerPeriod(p) {
  const sel = $('#period');
  if (!sel || !p) return;
  const opts = [
    { value: 'all', label: `All matches (${p.apps.length})` },
    { value: 'last5', label: 'Last 5 matches' },
    ...p.seasons.map(s => ({ value: s.id, label: s.name }))
  ];
  const keep = opts.some(o => o.value === periodChoice) ? periodChoice : 'all';
  sel.innerHTML = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  sel.value = keep;
  periodChoice = keep;
}

function pickPlayerApps(p) {
  const sel = ($('#period') && $('#period').value) || 'all';
  if (sel === 'last5') return [p.apps.slice(0, 5), 'Last 5 matches'];
  if (sel !== 'all') {
    const s = p.seasons.find(x => x.id === sel);
    if (s) return [p.apps.filter(a => a.seriesId === s.id), s.name];
  }
  return [p.apps, `All matches (${p.seasons.length} series)`];
}

function syncStick() {
  const bar = $('#bar');
  if (bar) document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');
}

function hideDock() {
  const home = $('#playerRow');
  const wrap = $('#periodHome');
  if (wrap && home && wrap.parentElement !== home) home.appendChild(wrap);
  const dock = $('#dock');
  if (dock) { dock.hidden = true; dock.innerHTML = ''; }
}

function paintDock(p, label, count) {
  const dock = $('#dock');
  const wrap = $('#periodHome');
  if (!dock || !wrap) return;
  wrap.remove();
  const tabs = PAGE_TABS.map(([id, lab]) => `<button type="button" role="tab" id="tab-${id}" data-page-tab="${id}" aria-selected="${pageTab === id}" aria-controls="panel" class="${pageTab === id ? 'on' : ''}">${lab}</button>`).join('');
  const primaryTeam = p.teams[0] || '';
  const teamSummary = p.teams.join(' · ');
  dock.hidden = false;
  dock.innerHTML = `<div class="dock-in"><div class="dock-team"><div class="dock-face">${badgeHTML(p.name, teamLogo(primaryTeam))}</div><div class="dock-id"><div class="dock-name" title="${esc(p.name)}">${esc(p.name)} ${p.summary.role.html}</div><div class="dock-sub">${esc(label)} · ${count} match${count === 1 ? '' : 'es'}</div><div class="scan-when" title="${esc(teamSummary)}">Teams: ${esc(teamSummary)}</div></div><div class="dock-period"></div></div><div class="page-tabs" role="tablist" aria-label="Player sections">${tabs}</div></div>`;
  dock.querySelector('.dock-period').appendChild(wrap);
  syncStick();
}

function choosePlayer(key) {
  const p = PLAYER_MAP.get(normKey(key));
  if (!p) return;
  CURRENT = p;
  if (LEAGUE) remember('player_' + LEAGUE.code, p.key);
  const input = $('#playerSearch');
  if (input) input.value = p.name;
  const clear = $('#playerClear');
  if (clear) clear.hidden = false;
  closePlayerList();
  fillPlayerPeriod(p);
  renderPlayer();
}

function clearPlayerSearch() {
  CURRENT = null;
  const input = $('#playerSearch');
  if (input) input.value = '';
  const clear = $('#playerClear');
  if (clear) clear.hidden = true;
  closePlayerList();
  if (LEAGUE) { try { localStorage.removeItem('player_' + LEAGUE.code); } catch (e) {} }
  hideDock();
  $('#main').innerHTML = readyOverviewHTML();
  if (input && !input.disabled) input.focus();
}

function scoutingNotesHTML(p, st) {
  const notes = [];
  if (st.inn > 0) {
    const posStr = st.avgPos != null ? `Usually bats at <b>#${Math.round(st.avgPos)}</b>` : 'Bats across the order';
    let style = 'Balanced batter';
    if (st.sr >= 130 || st.boundPct >= 55) style = 'Aggressive boundary hitter / slogger';
    else if (st.sr >= 95 && st.boundPct < 45) style = 'Busy strike rotator';
    else if (st.sr <= 60 && st.b >= 30) style = 'Patient anchor / accumulator';
    notes.push(`<b>Batting profile:</b> ${posStr} (${style}). Scores at <b>SR ${f1(st.sr)}</b> and <b>Avg ${f1(st.avg)}</b> with <b>${Math.round(st.boundPct)}%</b> of runs in boundaries (${st.f}×4, ${st.s}×6)${isFinite(st.batDotPct) ? ` and ~<b>${Math.round(st.batDotPct)}%</b> dot balls` : ''}.`);

    const caught = (st.how.ct || 0) + (st.how.ctw || 0);
    const timber = (st.how.b || 0) + (st.how.lbw || 0);
    const ro = st.how.ro || 0, stmp = st.how.st || 0;
    if (st.outs >= 2) {
      const bits = [];
      if (caught) bits.push(`${caught} caught (${pct(caught, st.outs)})`);
      if (timber) bits.push(`${timber} bowled/lbw (${pct(timber, st.outs)})`);
      if (ro) bits.push(`${ro} run out`);
      if (stmp) bits.push(`${stmp} stumped`);
      const plan = timber > caught
        ? 'Vulnerable on the stumps — bowl straight and attack the pads/stumps early.'
        : caught >= Math.ceil(st.outs * 0.55)
          ? 'Often dismissed caught —诱 them into lofting with pace-off and set catching protection.'
          : 'Mix pace and lengths to test both edges.';
      notes.push(`<b>Dismissal pattern (${st.outs} outs):</b> ${bits.join(', ')}. ${plan}`);
    }
    if (st.bfInn && st.chInn) {
      const bfSr = st.bfB ? 100 * st.bfR / st.bfB : NaN;
      const chSr = st.chB ? 100 * st.chR / st.chB : NaN;
      notes.push(`<b>Innings split:</b> Setting a total: <b>${st.bfR} runs</b> in ${st.bfInn} inns (Avg ${f1(st.bfOuts ? st.bfR / st.bfOuts : NaN)}, SR ${f1(bfSr)}) · Chasing: <b>${st.chR} runs</b> in ${st.chInn} inns (Avg ${f1(st.chOuts ? st.chR / st.chOuts : NaN)}, SR ${f1(chSr)}).`);
    }
  }
  if (st.spells > 0) {
    const openerShare = st.opens / st.spells;
    const roleDesc = openerShare >= 0.5 ? `Opens the bowling (${st.opens}/${st.spells} spells)` : 'Change / middle-overs bowler';
    const exPerOv = st.balls ? (st.wd + st.nb) / (st.balls / 6) : 0;
    notes.push(`<b>Bowling profile:</b> ${roleDesc} — <b>${st.wkts} wickets</b> in ${ov(st.balls)} overs at <b>Econ ${f1(st.econ)}</b>, <b>SR ${f1(st.bsr)}</b>, and <b>${f1(st.dotPct)}%</b> dot balls.`);
    notes.push(`<b>Discipline:</b> ${st.wd} wides and ${st.nb} no-balls (${f1(exPerOv)} extras per over). ${st.econ <= 6 ? 'Tight bowler — rotate strike and target other spells.' : 'Can be attacked when they miss their length.'}`);
  }
  if (st.fldTot > 0) {
    notes.push(`<b>Fielding impact:</b> ${st.fldTot} dismissals (${st.c} catches${st.k ? `, ${st.k} WK catches` : ''}${st.st ? `, ${st.st} stumpings` : ''}${st.ro ? `, ${st.ro} run-outs` : ''}).`);
  }
  return card('🎯', 'Scouting report', notes.length ? `<ul class="notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>` : '<p class="note">No match appearances in this period.</p>');
}

function overviewHTML(p, apps, st, label) {
  const formBits = apps.slice(0, 12).map((a, i) => resultBadge(a, ` style="animation-delay:${i * 40}ms"`)).join('');
  const formCard = card('📈', 'Recent appearances', `${formBits ? `<div class="form">${formBits}</div>` : '<p class="note">No matches in this period.</p>'}<p class="hsum">Played <b>${st.mat}</b> match${st.mat === 1 ? '' : 'es'} (${st.w}W–${st.l}L) across <b>${p.teams.length}</b> team${p.teams.length === 1 ? '' : 's'}.</p>`, label);

  const hsTxt = st.hs < 0 ? '–' : `${st.hs}${st.hsNo ? '*' : ''}`;
  const bestBowl = st.bw < 0 ? '–' : `${st.bw}/${st.bbr}`;
  const tiles = `<div class="tiles">
    <div class="tile"><div class="v"><span class="g">${st.w}</span>–<span class="r">${st.l}</span></div><div class="k">Matches (${st.mat})</div><div class="s">Win rate ${pct(st.w, st.mat)}</div></div>
    <div class="tile"><div class="v y">${st.r}</div><div class="k">Runs (${st.inn} inns)</div><div class="s">${st.no} not out · ${st.f}×4 · ${st.s}×6</div></div>
    <div class="tile"><div class="v">${f1(st.avg)}</div><div class="k">Batting Avg</div><div class="s">SR ${f1(st.sr)}</div></div>
    <div class="tile"><div class="v">${hsTxt}</div><div class="k">High Score</div><div class="s">30s/50s/100s: ${st.thirties}/${st.fifties}/${st.hundreds}</div></div>
    <div class="tile"><div class="v g">${st.wkts}</div><div class="k">Wickets (${ov(st.balls)} ov)</div><div class="s">Best ${bestBowl} · 3w+: ${st.threeW + st.fiveW}</div></div>
    <div class="tile"><div class="v">${f1(st.econ)}</div><div class="k">Bowling Econ</div><div class="s">Dot ${f1(st.dotPct)}% · Fld ${st.fldTot}</div></div>
  </div>`;

  const caught = (st.how.ct || 0) + (st.how.ctw || 0);
  const bowled = st.how.b || 0, lbw = st.how.lbw || 0, ro = st.how.ro || 0, stmp = st.how.st || 0;
  const run4 = 4 * st.f, run6 = 6 * st.s, runOther = Math.max(0, st.r - run4 - run6);
  const chartsCard = (st.inn > 0 || st.spells > 0) ? card('📊', 'Scoring & dismissals', `<div class="charts">
    <div class="chart"><div class="t">Run breakdown</div>${donut([{ l: '4s', v: run4, c: '#4cc3ff' }, { l: '6s', v: run6, c: '#ffc83d' }, { l: '1s/2s/3s', v: runOther, c: '#2fd27a' }], [st.r, 'runs'])}</div>
    <div class="chart"><div class="t">How dismissed</div>${donut([{ l: 'Caught', v: caught, c: '#ff4d5e' }, { l: 'Bowled', v: bowled, c: '#ffc83d' }, { l: 'LBW', v: lbw, c: '#b78cff' }, { l: 'RO/St', v: ro + stmp, c: '#4cc3ff' }], [st.outs, 'outs'])}</div>
  </div>`) : '';

  return formCard + tiles + scoutingNotesHTML(p, st) + chartsCard;
}

function pathwayHTML(p) {
  const bySeries = new Map();
  for (const a of p.apps) {
    const key = `${a.seriesId || a.series}|${a.team}`;
    let g = bySeries.get(key);
    if (!g) {
      g = { seriesId: a.seriesId, series: a.series || 'Series', team: a.team, apps: [], minDate: a.date || '', maxDate: a.date || '' };
      bySeries.set(key, g);
    }
    g.apps.push(a);
    if (a.date && (!g.minDate || a.date < g.minDate)) g.minDate = a.date;
    if (a.date && (!g.maxDate || a.date > g.maxDate)) g.maxDate = a.date;
  }
  const rows = [...bySeries.values()].sort((a, b) => String(b.maxDate).localeCompare(String(a.maxDate)));

  const teamCards = p.teams.map(tName => {
    const tApps = p.apps.filter(a => a.team === tName);
    const st = summarizeApps(tApps);
    const href = `index.html?league=${encodeURIComponent(LEAGUE.code)}&team=${encodeURIComponent(tName)}`;
    return `<div class="gc"><div class="gn"><b><a href="${href}" style="color:var(--tx);text-decoration:none">${face(tName, teamLogo(tName), 'mini')}${esc(tName)}</a></b><span>${st.mat} mat · ${st.r} runs (Avg ${f1(st.avg)}, SR ${f1(st.sr)}) · ${st.wkts} wkts (Econ ${f1(st.econ)})</span></div><a class="nav-pill" href="${href}">Team →</a></div>`;
  }).join('');

  const tableRows = rows.map(g => {
    const st = summarizeApps(g.apps);
    const pts = p.pointsMap.get(`${g.seriesId}|${g.team}`);
    const hsTxt = st.hs < 0 ? '–' : `${st.hs}${st.hsNo ? '*' : ''}`;
    const bestTxt = st.bw < 0 ? '–' : `${st.bw}/${st.bbr}`;
    return `<tr>
      <td><b>${esc(g.series)}</b><br><span style="font-size:11px;color:var(--mut)">${esc(g.team)}</span></td>
      <td>${st.mat}</td>
      <td>${st.inn ? `${st.r} (${hsTxt})` : '–'}</td>
      <td>${st.inn ? f1(st.avg) : '–'}</td>
      <td>${st.inn ? f1(st.sr) : '–'}</td>
      <td>${st.balls ? ov(st.balls) : '–'}</td>
      <td>${st.balls ? `${st.wkts} (${bestTxt})` : '–'}</td>
      <td>${st.balls ? f1(st.econ) : '–'}</td>
      <td>${st.fldTot || '–'}</td>
      <td>${pts && pts.total != null ? `<b class="y">${pts.total}</b>` : '—'}</td>
    </tr>`;
  }).join('');

  return card('🏏', 'Teams played for', `<div class="grounds">${teamCards}</div>`, `${p.teams.length} team${p.teams.length === 1 ? '' : 's'}`) +
    card('🗂️', 'Series & pathway progression', `<div class="ps-scroll"><table><tr><th>Series / Team</th><th>Mat</th><th>Runs (HS)</th><th>Avg</th><th>SR</th><th>Ov</th><th>Wkts</th><th>Econ</th><th>Fld</th><th>Pts</th></tr>${tableRows}</table></div><div class="note">Chronological breakdown across every series and team in ${esc(LEAGUE.name)}.</div>`);
}

function matchLogHTML(p, apps, label) {
  if (!apps.length) return card('📋', 'Match log', '<p class="note">No matches in this period.</p>', label);
  const items = apps.map(a => {
    const when = [a.date, a.series, a.ground].filter(Boolean).join(' · ');
    const mid = String(a.id || '').replace(/^legacy-/, '');
    const href = String(a.id || '').startsWith('legacy-')
      ? `https://cricclubs.com/${encodeURIComponent(LEAGUE.code)}/viewScorecard.do?matchId=${encodeURIComponent(mid)}&clubId=${encodeURIComponent(LEAGUE.clubId || '')}`
      : `https://cricclubs.com/${encodeURIComponent(LEAGUE.code)}/results/${encodeURIComponent(a.id)}`;
    const perfBits = [];
    if (a.bat) {
      const hs = `${a.bat.r}${a.bat.out ? '' : '*'}`;
      const posBit = a.bat.pos ? ` (#${a.bat.pos})` : '';
      perfBits.push(`🏏 <b>${hs}</b> (${a.bat.b}b, ${a.bat.f}×4, ${a.bat.s}×6)${posBit}`);
    }
    if (a.bowl) {
      perfBits.push(`🎯 <b>${a.bowl.w}/${a.bowl.r}</b> (${ov(a.bowl.balls)} ov, ${a.bowl.dots} dots)`);
    }
    if (a.field) {
      const f = [];
      if (a.field.c) f.push(`${a.field.c} ct`);
      if (a.field.k) f.push(`${a.field.k} wk-ct`);
      if (a.field.st) f.push(`${a.field.st} st`);
      if (a.field.ro) f.push(`${a.field.ro} ro`);
      if (f.length) perfBits.push(`🧤 ${f.join(', ')}`);
    }
    return `<div class="res">
      <div class="res-h">${resultBadge(a)}<div class="res-opp"><b>${esc(a.team)} vs ${esc(a.opponent)}</b></div><div class="res-when">${esc(when)}</div></div>
      <div class="res-board" style="grid-template-columns:1fr"><div class="res-name" style="white-space:normal">${perfBits.join(' &nbsp;·&nbsp; ') || 'Played (DNB)'}</div></div>
      <div class="res-f"><span class="res-sum">${esc(a.result || '')}</span><a href="${href}" target="_blank" rel="noopener">Scorecard</a></div>
    </div>`;
  }).join('');
  return card('📋', 'Match log', items, `${apps.length} match${apps.length === 1 ? '' : 'es'}`);
}

function renderPlayer() {
  if (!CURRENT) { hideDock(); return; }
  const [apps, label] = pickPlayerApps(CURRENT);
  const st = summarizeApps(apps);
  paintDock(CURRENT, label, apps.length);
  const panels = {
    overview: overviewHTML(CURRENT, apps, st, label),
    pathway: pathwayHTML(CURRENT),
    matches: matchLogHTML(CURRENT, apps, label)
  };
  $('#main').innerHTML = `<div id="panel" role="tabpanel" aria-labelledby="tab-${pageTab}">${panels[pageTab] || panels.overview}</div>`;
}

async function loadCatalog() {
  const r = await fetch('data/index.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('Could not load cached leagues (' + r.status + ')');
  const j = await r.json();
  CATALOG = j.leagues || [];
  const sel = $('#leagueSel');
  sel.innerHTML = '<option value="" hidden></option>' + CATALOG.map(l => `<option value="${esc(l.code)}">${esc(l.name)} · ${esc(l.code)}</option>`).join('');
}

$('#leagueSel').onchange = () => { if ($('#leagueSel').value) loadLeaguePlayers($('#leagueSel').value); };
$('#playerSearch').oninput = () => openPlayerList();
$('#playerSearch').onfocus = () => { if ($('#playerSearch').value.trim()) openPlayerList(); };
$('#playerSearch').onblur = () => setTimeout(() => {
  if (document.activeElement && $('#playerList') && $('#playerList').contains(document.activeElement)) return;
  closePlayerList();
  restorePlayerText();
}, 150);
$('#playerSearch').onkeydown = e => {
  const list = $('#playerList');
  const opts = list && !list.hidden ? [...list.querySelectorAll('[role="option"]')] : [];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!opts.length) { openPlayerList(); return; }
    playerActive = Math.min(opts.length - 1, playerActive + 1);
    paintPlayerActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!opts.length) return;
    playerActive = Math.max(0, playerActive - 1);
    paintPlayerActive();
  } else if (e.key === 'Enter') {
    const key = opts[playerActive] && opts[playerActive].getAttribute('data-player');
    if (key) { e.preventDefault(); choosePlayer(key); }
  } else if (e.key === 'Escape') {
    closePlayerList();
    restorePlayerText();
  }
};
$('#playerList').onmousedown = e => { if (e.target.closest('[data-player]')) e.preventDefault(); };
$('#playerClear').onclick = () => clearPlayerSearch();
$('#period').onchange = () => { periodChoice = $('#period').value; renderPlayer(); };

document.addEventListener('click', e => {
  const pageBtn = e.target.closest('[data-page-tab]');
  if (pageBtn) {
    const id = pageBtn.getAttribute('data-page-tab');
    if (!PAGE_TABS.some(t => t[0] === id) || id === pageTab) return;
    pageTab = id;
    renderPlayer();
    window.scrollTo(0, 0);
    return;
  }
  const b = e.target.closest('[data-lg]');
  if (b) { loadLeaguePlayers(b.dataset.lg); return; }
  const opt = e.target.closest('[data-player]');
  if (opt && $('#playerList') && $('#playerList').contains(opt)) {
    choosePlayer(opt.getAttribute('data-player'));
    return;
  }
  const pickCard = e.target.closest('[data-pick-player]');
  if (pickCard) {
    choosePlayer(pickCard.getAttribute('data-pick-player'));
    window.scrollTo(0, 0);
    return;
  }
  if (!e.target.closest('#playerPick')) closePlayerList();
});

window.addEventListener('resize', syncStick);

async function init() {
  const q = new URLSearchParams(location.search);
  try { await loadCatalog(); }
  catch (e) { msg(e.message); $('#main').innerHTML = welcomeHTML(); return; }
  const code = q.get('league') || recall('lg');
  const player = q.get('player') || '';
  if (code && leagueByCode(code)) {
    loadLeaguePlayers(code, player);
  } else {
    $('#main').innerHTML = welcomeHTML();
  }
}
init();
