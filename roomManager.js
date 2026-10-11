// 房间管理器：房间创建、加入、WebSocket 中转（房主权威模式）
// 游戏结算逻辑由房主端运行，服务端仅负责：
//   1. 房间生命周期（创建/加入/离开/重连）
//   2. 消息中转（客户端 → 房主，房主广播 → 所有客户端）
//   3. 心跳保活

const rooms = new Map(); // roomCode -> roomState

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

function createRoom(hostName, maxPlayers = 4) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: null,
    maxPlayers,
    players: {}, // { playerId: { id, name, character, ws, connected, ready } }
    status: 'waiting', // waiting | charSelect | playing | ended
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) { return rooms.get(code); }

function addPlayer(room, playerId, name, ws) {
  if (Object.keys(room.players).length >= room.maxPlayers) {
    return { ok: false, msg: '房间已满' };
  }
  const isFirst = Object.keys(room.players).length === 0;
  room.players[playerId] = {
    id: playerId,
    name,
    character: null,
    ws,
    connected: true,
    ready: false,
  };
  if (isFirst) room.hostId = playerId;
  room.lastActiveAt = Date.now();
  return { ok: true, isHost: isFirst };
}

function removePlayer(room, playerId) {
  if (!room.players[playerId]) return;
  room.players[playerId].connected = false;
  room.players[playerId].ws = null;
  room.lastActiveAt = Date.now();
  // 如果是房主，转让给下一个在线的
  if (room.hostId === playerId) {
    const alive = Object.values(room.players).find(p => p.connected && p.id !== playerId);
    if (alive) room.hostId = alive.id;
  }
}

function reconnectPlayer(room, playerId, ws) {
  const p = room.players[playerId];
  if (!p) return { ok: false, msg: '玩家不在房间内' };
  p.ws = ws;
  p.connected = true;
  room.lastActiveAt = Date.now();
  return { ok: true, isHost: room.hostId === playerId };
}

// 广播给房间内所有连接的玩家
function broadcast(room, msg, excludeId = null) {
  for (const pid in room.players) {
    if (excludeId && pid === excludeId) continue;
    const p = room.players[pid];
    if (p.ws && p.connected) {
      try { p.ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
}

// 发送给指定玩家
function sendTo(room, playerId, msg) {
  const p = room.players[playerId];
  if (p && p.ws && p.connected) {
    try { p.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
}

// 转发消息给房主（客户端操作 → 房主）
function forwardToHost(room, fromPlayerId, msg) {
  if (!room.hostId) return false;
  const host = room.players[room.hostId];
  if (!host || !host.ws || !host.connected) return false;
  // 在消息里标记来源玩家
  const forwardMsg = Object.assign({}, msg, { _from: fromPlayerId });
  try { host.ws.send(JSON.stringify(forwardMsg)); } catch (e) { return false; }
  return true;
}

function getRoomInfo(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, character: p.character,
      connected: p.connected, ready: p.ready,
    })),
  };
}

// 清理过期房间（超过2小时无活动）
function cleanupStaleRooms() {
  const now = Date.now();
  const STALE_MS = 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (now - room.lastActiveAt > STALE_MS) {
      // 断开所有连接
      for (const pid in room.players) {
        try { room.players[pid].ws?.close(); } catch (e) {}
      }
      rooms.delete(code);
      console.log('[Room] Stale room cleaned:', code);
    }
  }
}

setInterval(cleanupStaleRooms, 10 * 60 * 1000);

export {
  rooms,
  createRoom, getRoom, addPlayer, removePlayer, reconnectPlayer,
  broadcast, sendTo, forwardToHost, getRoomInfo,
};
