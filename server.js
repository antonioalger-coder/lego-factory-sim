import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const STALE_ROOM_MS = 2 * 60 * 60 * 1000; // 2 hours
const HEARTBEAT_INTERVAL = 30000;

// ─── Room Management ────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode → { director, clients: Map<ws, {id, name, role}>, createdAt, lastState }

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { director: null, clients: new Map(), createdAt: Date.now(), lastState: null });
  }
  return rooms.get(code);
}

function removeClient(ws) {
  for (const [code, room] of rooms) {
    if (!room.clients.has(ws)) continue;
    const client = room.clients.get(ws);
    room.clients.delete(ws);
    if (room.director === ws) room.director = null;

    // Notify director that an operator left
    if (client.role === 'operator' && room.director) {
      safeSend(room.director, { type: 'client_left', id: client.id, name: client.name });
    }

    // Clean up empty rooms
    if (room.clients.size === 0) {
      rooms.delete(code);
    }
    break;
  }
}

function safeSend(ws, data) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomCode, data, excludeWs) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const [ws] of room.clients) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function getActiveRooms() {
  const result = [];
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > STALE_ROOM_MS) continue;
    const opCount = [...room.clients.values()].filter(c => c.role === 'operator').length;
    const hasDirector = room.director !== null;
    const phase = room.lastState?.phase || 'staging';
    result.push({ room: code, opCount, hasDirector, phase, round: room.lastState?.round || 0, elapsed: room.lastState?.elapsedTime || 0 });
  }
  return result;
}

// ─── Express + HTTP ─────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static files
app.use(express.static(join(__dirname, 'dist'), {
  maxAge: '1y',
  immutable: true,
  index: false, // handle SPA fallback manually
}));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const server = createServer(app);

// ─── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const { room: roomCode, role, id, name } = msg;
        if (!roomCode) return;

        // Remove from any previous room
        removeClient(ws);

        const room = getOrCreateRoom(roomCode);
        room.clients.set(ws, { id, name, role });

        if (role === 'director') {
          room.director = ws;
        }

        // Send joined confirmation
        safeSend(ws, { type: 'joined', room: roomCode });

        // If joining as operator/observer and director has state, send it
        if (role !== 'director' && room.lastState) {
          safeSend(ws, { type: 'state_update', state: room.lastState });
        }

        // Notify director about the new client
        if (role === 'operator' && room.director && room.director !== ws) {
          safeSend(room.director, { type: 'client_joined', id, name, role });
        }
        break;
      }

      case 'state_update': {
        // From Director → broadcast to all others in room
        for (const [code, room] of rooms) {
          if (!room.clients.has(ws)) continue;
          room.lastState = msg.state;
          broadcastToRoom(code, { type: 'state_update', state: msg.state }, ws);
          break;
        }
        break;
      }

      case 'action': {
        // From Operator → relay to Director only
        for (const [, room] of rooms) {
          if (!room.clients.has(ws)) continue;
          if (room.director) {
            safeSend(room.director, { type: 'action', action: msg.action });
          }
          break;
        }
        break;
      }

      case 'get_rooms': {
        safeSend(ws, { type: 'room_list', rooms: getActiveRooms() });
        break;
      }
    }
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

// Heartbeat — detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// Cleanup stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > STALE_ROOM_MS && room.clients.size === 0) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`LEGO Factory server running on port ${PORT}`);
});
