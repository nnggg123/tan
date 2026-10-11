# 尖塔之影 · 联机中转服务器

用于《尖塔之影》跨设备联机的 WebSocket 中转服务器（房主权威模式）。**零依赖**，仅用 Node.js 内置模块，部署到免费云平台即可。

## 文件说明
| 文件 | 作用 |
|---|---|
| `server.js` | 主服务器：HTTP + WebSocket（`/ws` 端点），房间中转 |
| `roomManager.js` | 房间生命周期管理（创建/加入/离开/重连/中转/心跳） |
| `package.json` | 依赖清单与启动脚本（无第三方依赖） |
| `Procfile` | Railway / Render / Heroku 启动配置 |

## 本地测试（可选）
```bash
node server.js
# 打开 http://localhost:3000/api/health 看是否返回 {ok:true}
```

## 部署到 Render（最推荐，有免费层）
1. 把本文件夹的 4 个文件放进一个 GitHub 仓库。
2. Render 控制台 → **New → Web Service** → 连接你的仓库。
3. Build Command 留空（零依赖）；**Start Command** 填 `node server.js`。
4. 选择免费 **Free** 实例，点 Deploy。
5. 部署完成复制分配的地址（形如 `https://spire-server.onrender.com`）。

## 部署到 Railway
1. 新建项目 → **Deploy from GitHub** → 选择仓库。
2. 自动识别 `Procfile`，无需额外配置。
3. 部署后从 **Settings → Domain** 获取地址。

## 部署到 Glitch
1. **New Project → Import from GitHub**。
2. 导入后自动 Remix 启动，拿到的项目 URL 即地址。

## 在游戏里连接
- 打开《尖塔之影》→「合作爬塔」→ 联机模式选「🌐 在线服务器」。
- 在「服务器地址」输入框填入：`wss://你的域名/ws`（Render/Railway 通常为 `wss://xxx.com/ws`）。
- 两台设备填**同一个地址**，即可跨设备创建/加入房间联机。
- 留空则默认连当前页面同源 `/ws`。

## 健康检查
部署后访问 `https://你的域名/api/health`，返回 `{"ok":true,...}` 即服务器运行正常。
