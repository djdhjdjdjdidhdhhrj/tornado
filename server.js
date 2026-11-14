const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const MAX_SERVER_PLAYERS = 25;

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
let players = {}, rooms = {}, idCounter = 0;

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  Object.keys(players).forEach(id => {
    if (id !== excludeId && players[id].ws.readyState === 1) players[id].ws.send(msg);
  });
}

function getRoomList() {
  return Object.keys(rooms).map(code => ({
    code,
    host: rooms[code].hostName,
    players: rooms[code].players.length,
    maxPlayers: rooms[code].maxPlayers,
    status: rooms[code].status,
    createdAt: rooms[code].createdAt || 0
  })).sort((a, b) => a.createdAt - b.createdAt);
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function roomInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    hostName: room.hostName,
    players: room.players.map(pid => ({
      id: pid,
      name: players[pid]?.name || '玩家',
      role: players[pid]?.role || null
    })),
    maxPlayers: room.maxPlayers,
    status: room.status
  };
}

wss.on('connection', (ws) => {
  const id = 'p_' + (++idCounter);
  if (Object.keys(players).length >= MAX_SERVER_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: '服务器已满（最多25人）' }));
    ws.close();
    return;
  }

  players[id] = { id, ws, name: '玩家', roomCode: null, role: null };
  console.log(`[+] ${id} 上线，在线：${Object.keys(players).length}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    onlineCount: Object.keys(players).length,
    maxPlayers: MAX_SERVER_PLAYERS,
    rooms: getRoomList()
  }));

  broadcast({ type: 'onlineCount', count: Object.keys(players).length, maxPlayers: MAX_SERVER_PLAYERS, rooms: getRoomList() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const p = players[id];
    if (!p) return;

    switch (msg.type) {
      case 'setName':
        p.name = msg.name || '玩家';
        if (p.roomCode) {
          const r = rooms[p.roomCode];
          if (r) r.players.forEach(pid => {
            if (players[pid]?.ws.readyState === 1) players[pid].ws.send(JSON.stringify({ type: 'roomUpdate', room: roomInfo(r) }));
          });
        }
        break;

      case 'createRoom': {
        const max = Math.min(10, Math.max(2, msg.maxPlayers || 4));
        const code = genCode();
        rooms[code] = {
          code, hostId: id, hostName: p.name,
          players: [id], maxPlayers: max, status: 'waiting',
          createdAt: Date.now()
        };
        p.roomCode = code;
        ws.send(JSON.stringify({ type: 'roomCreated', room: roomInfo(rooms[code]) }));
        broadcast({ type: 'roomList', rooms: getRoomList() }, id);
        break;
      }

      case 'joinRoom': {
        const room = rooms[msg.code];
        if (!room) return ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
        if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
        if (room.status !== 'waiting') return ws.send(JSON.stringify({ type: 'error', message: '游戏已开始' }));

        if (p.roomCode && p.roomCode !== msg.code) {
          const old = rooms[p.roomCode];
          if (old) {
            old.players = old.players.filter(x => x !== id);
            if (old.players.length === 0) delete rooms[old.code];
            else {
              const oi = roomInfo(old);
              old.players.forEach(x => {
                if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: oi }));
              });
            }
          }
        }

        room.players.push(id);
        p.roomCode = msg.code;
        const info = roomInfo(room);
        room.players.forEach(x => {
          if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: info }));
        });
        broadcast({ type: 'roomList', rooms: getRoomList() }, id);
        break;
      }

      case 'quickJoin': {
        const waiting = Object.values(rooms).filter(r => r.status === 'waiting' && r.players.length < r.maxPlayers);
        if (waiting.length === 0) return ws.send(JSON.stringify({ type: 'noRooms' }));
        const room = waiting[0];

        if (p.roomCode) {
          const old = rooms[p.roomCode];
          if (old) {
            old.players = old.players.filter(x => x !== id);
            if (old.players.length === 0) delete rooms[old.code];
          }
        }

        room.players.push(id);
        p.roomCode = room.code;
        const info = roomInfo(room);
        room.players.forEach(x => {
          if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: info }));
        });
        break;
      }

      case 'leaveRoom': {
        if (!p.roomCode) return;
        const room = rooms[p.roomCode];
        if (!room) return;
        room.players = room.players.filter(x => x !== id);
        p.roomCode = null;
        p.role = null;
        if (room.players.length === 0) delete rooms[room.code];
        else {
          const info = roomInfo(room);
          room.players.forEach(x => {
            if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: info }));
          });
        }
        broadcast({ type: 'roomList', rooms: getRoomList() });
        break;
      }

      case 'selectRole': {
        const room = rooms[p.roomCode];
        if (!room) return;
        p.role = msg.role;
        room.players.forEach(x => {
          if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: roomInfo(room) }));
        });
        ws.send(JSON.stringify({ type: 'roleSelected', role: msg.role }));
        break;
      }

      case 'startGame': {
        const room = rooms[p.roomCode];
        if (!room) return;
        room.status = 'playing';
        const roles = {};
        room.players.forEach(x => { roles[x] = players[x]?.role || 'tornado'; });
        room.players.forEach(x => {
          if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'gameStart', roomCode: room.code, roles }));
        });
        break;
      }

      case 'update': {
        if (!p.roomCode) return;
        const room = rooms[p.roomCode];
        if (!room) return;
        room.players.forEach(x => {
          if (x !== id && players[x]?.ws.readyState === 1) {
            players[x].ws.send(JSON.stringify({
              type: 'playerUpdate', id, x: msg.x, z: msg.z, score: msg.score, role: p.role
            }));
          }
        });
        break;
      }

      case 'getRooms':
        ws.send(JSON.stringify({ type: 'roomList', rooms: getRoomList() }));
        break;
    }
  });

  ws.on('close', () => {
    const p = players[id];
    if (p && p.roomCode) {
      const room = rooms[p.roomCode];
      if (room) {
        room.players = room.players.filter(x => x !== id);
        if (room.players.length === 0) delete rooms[room.code];
        else {
          const info = roomInfo(room);
          room.players.forEach(x => {
            if (players[x]?.ws.readyState === 1) players[x].ws.send(JSON.stringify({ type: 'roomUpdate', room: info }));
          });
        }
      }
    }
    delete players[id];
    console.log(`[-] ${id} 下线，在线：${Object.keys(players).length}`);
    broadcast({ type: 'onlineCount', count: Object.keys(players).length, maxPlayers: MAX_SERVER_PLAYERS, rooms: getRoomList() });
  });
});

server.listen(PORT, () => console.log(`🚀 服务器运行在 http://0.0.0.0:${PORT}`));