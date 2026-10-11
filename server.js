// 尖塔之影 - WebSocket 联机中转服务器
// 零依赖版：仅使用 Node.js 内置模块 (http + crypto)
// 房主权威模式：服务端只做房间管理 + WebSocket 消息中转
import http from 'node:http';
import crypto from 'node:crypto';

import {
  createRoom, getRoom, addPlayer, removePlayer, reconnectPlayer,
  broadcast, sendTo, forwardToHost, getRoomInfo,
  rooms,
} from './roomManager.js';

// ---------- WebSocket 工具函数 ----------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsFrame(data, opcode = 1) {
  // opcode: 1 = text, 2 = binary, 8 = close, 9 = ping, 10 = pong
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

// 解析 WebSocket 帧（仅支持客户端到服务端的 masked 帧）
function parseWsFrame(buffer) {
  if (buffer.length < 2) return null;

  const byte0 = buffer[0];
  const byte1 = buffer[1];
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;

  let payload = buffer.slice(offset, offset + payloadLen);

  if (masked && maskKey) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    frameSize: offset + payloadLen,
  };
}

// WebSocket 连接包装类（兼容 ws 库的基本 API：send/close/onmessage/onclose/onerror/readyState）
class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.readyState = 'connecting';
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onopen = null;

    socket.on('data', (data) => this._onData(data));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this._onError(err));
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 2) {
      const frame = parseWsFrame(this.buffer);
      if (!frame) break;

      this.buffer = this.buffer.slice(frame.frameSize);

      if (frame.opcode === 8) {
        // close frame
        this._close();
        return;
      } else if (frame.opcode === 9) {
        // ping -> pong
        this.send(frame.payload, 10);
      } else if (frame.opcode === 1) {
        // text frame
        if (this.onmessage) {
          this.onmessage({ data: frame.payload.toString('utf8') });
        }
      }
    }
  }

  _onClose() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }

  _onError(err) {
    if (this.onerror) this.onerror(err);
  }

  send(data, opcode = 1) {
    if (this.readyState !== 'open') return;
    try {
      this.socket.write(wsFrame(data, opcode));
    } catch (e) {
      // ignore
    }
  }

  close() {
    if (this.readyState === 'closed') return;
    try {
      this.socket.write(wsFrame('', 8));
    } catch (e) {}
    this.socket.end();
    this._close();
  }

  _close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
}

// ---------- HTTP 服务器（健康检查 + 房间查询） ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS（允许跨域，方便不同来源的前端连接）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查
  if (pathname === '/api/health' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }

  // 查询房间
  if (req.method === 'GET' && pathname.startsWith('/api/room/')) {
    const code = pathname.slice('/api/room/'.length);
    const room = getRoom(code);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!room) {
      res.end(JSON.stringify({ exists: false }));
    } else {
      res.end(JSON.stringify({ exists: true, room: getRoomInfo(room) }));
    }
    return;
  }

  // 根路径：返回简单的状态页
  if (pathname === '/' || pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>尖塔之影 · 联机中转服务</h2>
      <p>状态：运行中</p>
      <p>在线房间数：${rooms.size}</p>
      <p>WebSocket 端点：<code>/ws</code></p>
      <p><a href="/api/health">健康检查</a></p>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// ---------- WebSocket 升级 ----------
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = wsAcceptKey(key);

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  // 创建 WebSocket 连接
  const ws = new WSConnection(socket);
  ws.readyState = 'open';
  if (ws.onopen) ws.onopen();

  handleWebSocketConnection(ws);
});

// ---------- WebSocket 消息处理 ----------
function handleWebSocketConnection(ws) {
  let playerId = null;
  let roomCode = null;
  let isHost = false;

  ws.send(JSON.stringify({ type: 'welcome', msg: '欢迎加入尖塔之影' }));

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    switch (msg.type) {
      // ---------- 创建房间（房主） ----------
      case 'createRoom': {
        const { playerName, maxPlayers } = msg;
        if (!playerName || playerName.length < 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '请输入名字' }));
          return;
        }
        const room = createRoom(playerName, maxPlayers || 4);
        const pid = 'p_' + Math.random().toString(36).slice(2, 10);
        const r = addPlayer(room, pid, playerName, ws);
        if (!r.ok) {
          ws.send(JSON.stringify({ type: 'error', msg: r.msg }));
          return;
        }
        playerId = pid;
        roomCode = room.code;
        isHost = true;
        ws.send(JSON.stringify({
          type: 'roomCreated',
          playerId: pid,
          roomCode: room.code,
          room: getRoomInfo(room),
        }));
        console.log(`[Room] ${room.code} created by ${playerName}`);
        break;
      }

      // ---------- 加入房间 ----------
      case 'joinRoom': {
        const { code, playerName, reconnectId } = msg;
        const room = getRoom(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' }));
          return;
        }

        // 重连
        if (reconnectId && room.players[reconnectId]) {
          const r = reconnectPlayer(room, reconnectId, ws);
          if (r.ok) {
            playerId = reconnectId;
            roomCode = code;
            isHost = r.isHost;
            ws.send(JSON.stringify({
              type: 'reconnected',
              playerId,
              room: getRoomInfo(room),
              isHost: r.isHost,
            }));
            broadcast(room, { type: 'playerReconnected', playerId, room: getRoomInfo(room) }, playerId);
            console.log(`[Room] ${code}: ${playerName} reconnected`);
          }
          return;
        }

        // 新加入
        const pid = 'p_' + Math.random().toString(36).slice(2, 10);
        const r = addPlayer(room, pid, playerName || '匿名玩家', ws);
        if (!r.ok) {
          ws.send(JSON.stringify({ type: 'error', msg: r.msg }));
          return;
        }
        playerId = pid;
        roomCode = code;
        isHost = r.isHost;
        ws.send(JSON.stringify({
          type: 'joined',
          playerId: pid,
          room: getRoomInfo(room),
          isHost: r.isHost,
        }));
        broadcast(room, {
          type: 'playerJoined',
          players: Object.values(room.players).map(p => ({
            id: p.id, name: p.name, character: p.character, connected: p.connected, ready: p.ready,
          })),
        }, playerId);
        console.log(`[Room] ${code}: ${playerName} joined (${Object.keys(room.players).length}/${room.maxPlayers})`);
        break;
      }

      // ---------- 房主广播消息 ----------
      // 房主发送的消息，原样广播给房间内所有其他玩家
      case 'hostBroadcast': {
        if (!roomCode || !playerId || !isHost) return;
        const room = getRoom(roomCode);
        if (!room) return;
        const payload = Object.assign({}, msg.payload || {}, { _from: 'host' });
        // 广播给所有玩家（包括房主自己，保持一致）
        broadcast(room, payload, null);
        break;
      }

      // ---------- 客户端发给房主的消息 ----------
      // 客户端操作（出牌、结束回合等）转发给房主处理
      case 'clientAction': {
        if (!roomCode || !playerId) return;
        const room = getRoom(roomCode);
        if (!room) return;
        if (isHost) {
          // 房主自己发的，直接本地处理（走 forwardToHost 也行，但直接发回更简单）
          ws.send(JSON.stringify(Object.assign({}, msg.action || {}, { _from: playerId })));
        } else {
          const ok = forwardToHost(room, playerId, msg.action || {});
          if (!ok) ws.send(JSON.stringify({ type: 'error', msg: '房主已断开连接' }));
        }
        break;
      }

      // ---------- 聊天 ----------
      case 'chat': {
        if (!roomCode || !playerId) return;
        const room = getRoom(roomCode);
        if (!room) return;
        const p = room.players[playerId];
        broadcast(room, { type: 'chat', playerId, name: p?.name || '???', text: msg.text });
        break;
      }

      // ---------- 心跳 ----------
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        break;
      }
    }
  };

  ws.onclose = () => {
    if (roomCode && playerId) {
      const room = getRoom(roomCode);
      if (room) {
        const wasHost = isHost;
        removePlayer(room, playerId);
        broadcast(room, {
          type: 'playerLeft',
          playerId,
          room: getRoomInfo(room),
          hostChanged: wasHost && room.hostId !== playerId ? room.hostId : null,
        });
        console.log(`[Room] ${roomCode}: player left, remaining: ${Object.values(room.players).filter(p => p.connected).length}`);
        // 如果房间没人了，延迟清理
        const anyConnected = Object.values(room.players).some(p => p.connected);
        if (!anyConnected) {
          setTimeout(() => {
            const stillEmpty = !Object.values(room.players).some(p => p.connected);
            if (stillEmpty) rooms.delete(room.code);
          }, 5 * 60 * 1000);
        }
      }
    }
  };

  ws.onerror = () => {
    // 静默处理
  };
}

// ---------- 启动 ----------
const PORT = process.env.PORT || 3000;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[尖塔之影] 端口 ${PORT} 已被占用`);
    process.exit(1);
  } else {
    console.error('[尖塔之影] 服务器错误:', err.message);
  }
});
server.listen(PORT, () => {
  console.log(`[尖塔之影] Server running on port ${PORT}`);
  console.log(`[尖塔之影] WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`[尖塔之影] 健康检查: http://localhost:${PORT}/api/health`);
});
