// Decide what the scan workflow should do. Writes only sanitized single-line outputs.
const fs = require('fs');
const { parseIssueBody, sanitizeLeague, sanitizeTeam, sanitizePlayer } = require('../../lib/issue');

function emit(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]/g, ' ').trim()}`);
  if (!file) {
    console.log(lines.join('\n'));
    return;
  }
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

function stop(message) {
  console.error(message);
  emit({ proceed: 'false', mode: 'invalid', league: '', team: '', player: '', error: message });
  process.exit(1);
}

const event = process.env.EVENT || '';
if (process.env.SEEN === 'true') {
  emit({ proceed: 'false', mode: 'skip', league: '', team: '', player: '', error: '' });
  process.exit(0);
}

if (event === 'schedule') {
  emit({ proceed: 'true', mode: 'weekly', league: '', team: '', player: '', error: '' });
  process.exit(0);
}

if (event === 'workflow_dispatch') {
  const rawLeague = (process.env.INPUT_LEAGUE || '').trim();
  if (!rawLeague) {
    emit({ proceed: 'true', mode: 'weekly', league: '', team: '', player: '', error: '' });
    process.exit(0);
  }
  const code = sanitizeLeague(rawLeague);
  if (!code) stop('Invalid league. Use a CricClubs league code or a cricclubs.com URL.');
  const player = sanitizePlayer(process.env.INPUT_PLAYER || '');
  if (!player.ok) stop(player.error);
  if (player.value) {
    emit({ proceed: 'true', mode: 'player', league: code, team: '', player: player.value, error: '' });
    process.exit(0);
  }
  const team = sanitizeTeam(process.env.INPUT_TEAM || '');
  if (!team.ok) stop(team.error);
  emit({
    proceed: 'true',
    mode: team.value ? 'scan' : 'league',
    league: code,
    team: team.value,
    player: '',
    error: ''
  });
  process.exit(0);
}

if (event === 'issues') {
  const action = process.env.ACTION || '';
  const added = process.env.LABEL || '';
  const labels = (process.env.ISSUE_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const has = labels.includes('scan-request') || added === 'scan-request';
  if (action === 'labeled' && added !== 'scan-request') {
    emit({ proceed: 'false', mode: 'skip', league: '', team: '', player: '', error: '' });
    process.exit(0);
  }
  if (!has) {
    emit({ proceed: 'false', mode: 'skip', league: '', team: '', player: '', error: '' });
    process.exit(0);
  }
  const fields = parseIssueBody(process.env.ISSUE_BODY || '');
  const code = sanitizeLeague(fields.league);
  if (!code) {
    emit({
      proceed: 'true',
      mode: 'invalid',
      league: '',
      team: '',
      player: '',
      error: 'Invalid league. Use a CricClubs league code (letters, numbers, _ or -) or a cricclubs.com URL.'
    });
    process.exit(0);
  }
  const player = sanitizePlayer(fields.player);
  if (!player.ok) {
    emit({ proceed: 'true', mode: 'invalid', league: code, team: '', player: '', error: player.error });
    process.exit(0);
  }
  if (player.value) {
    emit({ proceed: 'true', mode: 'player', league: code, team: '', player: player.value, error: '' });
    process.exit(0);
  }
  const team = sanitizeTeam(fields.team);
  if (!team.ok) {
    emit({ proceed: 'true', mode: 'invalid', league: code, team: '', player: '', error: team.error });
    process.exit(0);
  }
  emit({
    proceed: 'true',
    mode: team.value ? 'scan' : 'league',
    league: code,
    team: team.value,
    player: '',
    error: ''
  });
  process.exit(0);
}

emit({ proceed: 'false', mode: 'skip', league: '', team: '', player: '', error: '' });
