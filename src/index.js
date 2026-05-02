// Durable Object - 管理单个游戏房间
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();      // WebSocket 会话
    this.players = [];              // 玩家信息 [{id, name, color}]
    this.gameState = Array(15).fill().map(() => Array(15).fill(null));
    this.currentPlayer = 'black';
    this.gameStarted = false;
    this.winner = null;
    
    // 定时存储状态
    this.saveInterval = setInterval(async () => {
      await this.saveState();
    }, 30000);
  }
  
  async saveState() {
    const state = {
      players: this.players,
      gameState: this.gameState,
      currentPlayer: this.currentPlayer,
      gameStarted: this.gameStarted,
      winner: this.winner
    };
    await this.state.storage.put('gameState', state);
  }
  
  async loadState() {
    const saved = await this.state.storage.get('gameState');
    if (saved) {
      this.players = saved.players || [];
      this.gameState = saved.gameState || Array(15).fill().map(() => Array(15).fill(null));
      this.currentPlayer = saved.currentPlayer || 'black';
      this.gameStarted = saved.gameStarted || false;
      this.winner = saved.winner || null;
    }
  }
  
  async fetch(request) {
    const url = new URL(request.url);
    
    // WebSocket 连接
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    
    // HTTP API
    if (url.pathname === '/api/state' && request.method === 'GET') {
      return new Response(JSON.stringify({
        players: this.players,
        gameState: this.gameState,
        currentPlayer: this.currentPlayer,
        gameStarted: this.gameStarted,
        winner: this.winner
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  handleWebSocket(ws) {
    let playerId = null;
    let playerName = null;
    let playerColor = null;
    
    ws.accept();
    
    ws.addEventListener('message', async (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'join':
          await this.loadState();
          playerName = data.name;
          playerId = crypto.randomUUID();
          
          // 分配颜色
          if (this.players.length === 0) {
            playerColor = 'black';
          } else if (this.players.length === 1 && !this.gameStarted) {
            playerColor = 'white';
          } else {
            ws.send(JSON.stringify({ type: 'error', message: '房间已满或游戏已开始' }));
            ws.close();
            return;
          }
          
          const player = { id: playerId, name: playerName, color: playerColor };
          this.players.push(player);
          this.sessions.set(playerId, ws);
          
          // 通知当前玩家
          ws.send(JSON.stringify({
            type: 'joined',
            color: playerColor,
            playerId: playerId
          }));
          
          // 通知其他玩家
          this.broadcast(playerId, {
            type: 'playerJoined',
            name: playerName
          });
          
          // 更新游戏状态给所有人
          if (this.players.length === 2 && !this.gameStarted) {
            this.gameStarted = true;
            this.currentPlayer = 'black';
            await this.saveState();
            
            this.broadcast(null, {
              type: 'gameStart',
              message: '游戏开始！黑棋先走',
              currentPlayer: 'black',
              players: this.players,
              gameState: this.gameState
            });
          } else {
            this.broadcast(null, {
              type: 'stateUpdate',
              players: this.players,
              gameStarted: this.gameStarted,
              currentPlayer: this.currentPlayer
            });
          }
          break;
          
        case 'move':
          if (!this.gameStarted || this.winner) {
            ws.send(JSON.stringify({ type: 'error', message: '游戏未开始或已结束' }));
            return;
          }
          
          const playerData = this.players.find(p => p.id === playerId);
          if (!playerData || playerData.color !== this.currentPlayer) {
            ws.send(JSON.stringify({ type: 'error', message: '还没轮到你' }));
            return;
          }
          
          const { row, col } = data;
          if (this.gameState[row][col] !== null) {
            ws.send(JSON.stringify({ type: 'error', message: '这个位置已经有棋子了' }));
            return;
          }
          
          // 下棋
          this.gameState[row][col] = this.currentPlayer;
          
          // 检查胜利
          if (this.checkWin(row, col, this.currentPlayer)) {
            this.winner = this.currentPlayer;
            this.gameStarted = false;
            await this.saveState();
            
            this.broadcast(null, {
              type: 'gameEnd',
              winner: this.currentPlayer,
              players: this.players
            });
          } else {
            // 切换玩家
            this.currentPlayer = this.currentPlayer === 'black' ? 'white' : 'black';
            await this.saveState();
            
            this.broadcast(null, {
              type: 'moveMade',
              row, col,
              player: playerData.color,
              currentPlayer: this.currentPlayer,
              gameState: this.gameState
            });
          }
          break;
          
        case 'reset':
          if (this.gameStarted || this.winner) {
            this.gameState = Array(15).fill().map(() => Array(15).fill(null));
            this.currentPlayer = 'black';
            this.winner = null;
            this.gameStarted = true;
            await this.saveState();
            
            this.broadcast(null, {
              type: 'gameReset',
              gameState: this.gameState,
              currentPlayer: 'black'
            });
          }
          break;
          
        case 'leave':
          this.players = this.players.filter(p => p.id !== playerId);
          this.sessions.delete(playerId);
          
          if (this.players.length === 0) {
            this.gameStarted = false;
            this.gameState = Array(15).fill().map(() => Array(15).fill(null));
            this.currentPlayer = 'black';
            this.winner = null;
            await this.saveState();
          } else {
            this.gameStarted = false;
            this.broadcast(playerId, { type: 'playerLeft', name: playerName });
          }
          break;
      }
    });
    
    ws.addEventListener('close', () => {
      if (playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        this.sessions.delete(playerId);
        
        if (this.players.length === 0) {
          this.gameStarted = false;
          this.gameState = Array(15).fill().map(() => Array(15).fill(null));
          this.currentPlayer = 'black';
          this.winner = null;
          this.saveState();
        } else if (this.gameStarted) {
          this.gameStarted = false;
          this.broadcast(playerId, { type: 'playerLeft', name: playerName });
        }
      }
    });
  }
  
  broadcast(excludeId, message) {
    for (const [id, ws] of this.sessions) {
      if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }
  }
  
  checkWin(row, col, player) {
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    
    for (const [dx, dy] of directions) {
      let count = 1;
      
      for (let i = 1; i <= 5; i++) {
        const newRow = row + dx * i;
        const newCol = col + dy * i;
        if (newRow < 0 || newRow >= 15 || newCol < 0 || newCol >= 15) break;
        if (this.gameState[newRow][newCol] === player) count++;
        else break;
      }
      
      for (let i = 1; i <= 5; i++) {
        const newRow = row - dx * i;
        const newCol = col - dy * i;
        if (newRow < 0 || newRow >= 15 || newCol < 0 || newCol >= 15) break;
        if (this.gameState[newRow][newCol] === player) count++;
        else break;
      }
      
      if (count >= 5) return true;
    }
    return false;
  }
}

// Worker 主入口
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 静态资源请求
    if (url.pathname === '/' || url.pathname.startsWith('/index.html')) {
      return env.ASSETS.fetch(request);
    }
    
    // WebSocket 连接 - 需要房间ID
    if (url.pathname === '/ws') {
      const roomId = url.searchParams.get('roomId');
      if (!roomId) {
        return new Response('Missing roomId', { status: 400 });
      }
      
      // 获取或创建 Durable Object
      const id = env.GAME_ROOM.idFromName(roomId);
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    }
    
    // API 请求也转发到 Durable Object
    const roomId = url.searchParams.get('roomId');
    if (roomId) {
      const id = env.GAME_ROOM.idFromName(roomId);
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    }
    
    return env.ASSETS.fetch(request);
  }
};