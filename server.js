/* Hand Cricket: Veer's League. Online 1v1 server.
   Serves index.html and runs the match referee over WebSocket.
   Run:  npm install && npm start     (PORT env var is respected) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// Finds the game page even if the file was renamed (index.htm, "index (1).html", inside public/, ...)
function findGame() {
  const dirs = [__dirname, path.join(__dirname, 'public')];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    const exact = files.find(f => f.toLowerCase() === 'index.html' || f.toLowerCase() === 'index.htm');
    if (exact) return path.join(dir, exact);
    const any = files.find(f => /\.html?$/i.test(f));
    if (any) return path.join(dir, any);
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const file = findGame();
  if (!file) {
    let list = [];
    try { list = fs.readdirSync(__dirname); } catch (e) {}
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Game page not found. Add index.html next to server.js.\nFiles the server can see: ' + list.join(', '));
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('Could not read the game page.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 1024 });

/* ---------- referee: same rules as the game ---------- */
const autoWkts = o => (o <= 2 ? 3 : o <= 5 ? 5 : 10);
function newMatch(room) {
  const mk = bat => ({ bat, runs: 0, wkts: 0, balls: 0 });
  room.m = { maxBalls: room.overs * 6, maxWkts: room.wkts, inn: [mk(room.first), mk(1 - room.first)], cur: 0, target: null, done: false };
}
function resolve(m, p0, p1) {
  const inn = m.inn[m.cur];
  const bat = inn.bat === 0 ? p0 : p1, bowl = inn.bat === 0 ? p1 : p0;
  inn.balls++;
  if (bat === bowl) inn.wkts++; else inn.runs += bat;
  let end = false;
  if (bat === bowl && inn.wkts >= m.maxWkts) end = true;
  if (inn.balls >= m.maxBalls) end = true;
  if (m.cur === 1 && inn.runs >= m.target) end = true;
  if (end) {
    if (m.cur === 1) m.done = true; else { m.cur = 1; m.target = inn.runs + 1; }
  }
  return { bat, bowl };
}

/* ---------- rooms ---------- */
const rooms = new Map();
let waiting = null; // quick-match queue
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const send = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
const names = r => [r.players[0].name, r.players[1] ? r.players[1].name : '...'];
function announce(r) { r.players.forEach((p, i) => send(p.ws, { t: 'room', code: r.code, you: i, names: names(r), overs: r.overs, wkts: r.wkts })); }
function startToss(r) {
  r.state = 'toss'; r.m = null;
  r.players.forEach(p => { p.pick = null; p.rematch = false; });
  r.tossWinner = Math.random() < 0.5 ? 0 : 1;
  r.players.forEach((p, i) => send(p.ws, { t: 'toss', winner: r.tossWinner, you: i, names: names(r) }));
}
function startMatch(r, choice) {
  r.first = choice === 'bat' ? r.tossWinner : 1 - r.tossWinner;
  newMatch(r); r.state = 'play';
  r.players.forEach((p, i) => send(p.ws, { t: 'start', you: i, names: names(r), overs: r.overs, wkts: r.wkts, first: r.first }));
}
function leave(ws) {
  if (waiting && waiting.ws === ws) waiting = null;
  const r = ws.room; if (!r) return;
  ws.room = null;
  const other = r.players.find(p => p.ws !== ws);
  if (other) { send(other.ws, { t: 'opp-left' }); other.ws.room = null; }
  rooms.delete(r.code);
}
function pair(a, b, overs, wkts) {
  const r = { code: makeCode(), overs, wkts, players: [a, b], state: 'wait', m: null };
  rooms.set(r.code, r); a.ws.room = r; b.ws.room = r; announce(r); startToss(r);
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.room = null; ws.name = 'Player';
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room;
    switch (m.t) {
      case 'hello': ws.name = String(m.name || 'Player').replace(/[<>]/g, '').trim().slice(0, 14) || 'Player'; break;
      case 'create': {
        if (r) return;
        const overs = [2, 5, 20].includes(m.overs) ? m.overs : 2;
        const room = { code: makeCode(), overs, wkts: autoWkts(overs), players: [{ ws, name: ws.name, pick: null }], state: 'wait', m: null };
        rooms.set(room.code, room); ws.room = room; announce(room); break;
      }
      case 'join': {
        if (r) return;
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room || room.players.length !== 1 || room.state !== 'wait') { send(ws, { t: 'err', msg: 'That room does not exist or is already full.' }); return; }
        let name = ws.name; if (name.toLowerCase() === room.players[0].name.toLowerCase()) name += ' 2';
        room.players.push({ ws, name, pick: null }); ws.room = room; announce(room); startToss(room); break;
      }
      case 'quick': {
        if (r) return;
        if (waiting && waiting.ws !== ws && waiting.ws.readyState === 1) {
          const a = waiting; waiting = null;
          let name = ws.name; if (name.toLowerCase() === a.name.toLowerCase()) name += ' 2';
          pair(a, { ws, name, pick: null }, 2, 3);
        } else waiting = { ws, name: ws.name, pick: null };
        break;
      }
      case 'choose': {
        if (!r || r.state !== 'toss') return;
        const idx = r.players.findIndex(p => p.ws === ws);
        if (idx !== r.tossWinner || (m.v !== 'bat' && m.v !== 'bowl')) return;
        startMatch(r, m.v); break;
      }
      case 'pick': {
        if (!r || r.state !== 'play' || !r.m || r.m.done) return;
        const n = m.n; if (!Number.isInteger(n) || n < 1 || n > 6) return;
        const p = r.players.find(x => x.ws === ws);
        if (!p || p.pick !== null) return; // one pick per ball
        p.pick = n;
        const other = r.players.find(x => x !== p);
        if (other.pick === null) { send(other.ws, { t: 'locked' }); return; }
        const res = resolve(r.m, r.players[0].pick, r.players[1].pick);
        r.players.forEach(x => { x.pick = null; });
        r.players.forEach(x => send(x.ws, { t: 'ball', bat: res.bat, bowl: res.bowl }));
        if (r.m.done) r.state = 'over';
        break;
      }
      case 'rematch': {
        if (!r || r.state !== 'over' || r.players.length !== 2) return;
        const p = r.players.find(x => x.ws === ws); p.rematch = true;
        if (r.players.every(x => x.rematch)) startToss(r);
        else send(ws, { t: 'rematch-wait' });
        break;
      }
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// drop dead connections; the ping also keeps free hosts from idling the socket
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; try { ws.ping(); } catch (e) {} });
}, 25000);

server.listen(PORT, () => console.log('Veer\'s League online server on port ' + PORT));
