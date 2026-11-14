// Local/live server for CricScout: serves site/ and provides on-demand league & player scraping APIs.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseLeagueInput } = require('./lib/league-input');
const { addLeagueFast, fetchPlayerOnDemand } = require('./lib/player-ondemand');

const PORT = Number(process.env.PORT || 3000);
const SITE = path.join(__dirname, 'site');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/league/add') {
    const raw = url.searchParams.get('league') || '';
    let code;
    try { code = parseLeagueInput(raw); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    const sendEvent = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const league = await addLeagueFast(code, prog => sendEvent('progress', prog));
      sendEvent('done', { league });
    } catch (e) {
      sendEvent('error', { error: e.message || String(e) });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (url.pathname === '/api/player') {
    const code = url.searchParams.get('league') || '';
    const playerId = url.searchParams.get('playerId') || '';
    if (!code || !playerId) return sendJson(res, 400, { error: 'Missing league or playerId' });
    try {
      const profile = await fetchPlayerOnDemand(code, playerId);
      return sendJson(res, 200, profile);
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  // Static file serving from site/
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CricScout live server running at http://localhost:${PORT}/players.html`);
  });
}

module.exports = server;
