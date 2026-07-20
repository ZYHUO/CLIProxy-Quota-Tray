# CLIProxy Quota Tray

系统托盘面板，搭配 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）使用：
实时查看各 OAuth 账号配额窗口、usage queue 成本估算，以及 OpenAI / Claude 官方状态。

支持 **Windows** 与 **Linux**（Electron 托盘）。深色终端风 UI，全局 JetBrains Mono（本地内嵌，无需联网加载字体）。

![Overview](docs/screenshots/overview.png)

| Provider 聚焦页 | 成本历史 |
| --- | --- |
| ![Provider focus](docs/screenshots/provider-focus.png) | ![Cost history](docs/screenshots/cost-history.png) |

## 功能

- 常驻系统托盘，点击图标弹出紧凑 dashboard（860×660），失焦自动隐藏，可钉住
  （Linux 上请用托盘菜单 **Open Dashboard**）。
- 从 CPA Management API 读取 OAuth 账号、usage queue、API key usage。
- 支持 ChatGPT/Codex、Claude、Gemini/Antigravity、Grok/xAI、**Kimi**、**Cursor**
  的 OAuth 账号与配额展示。
- OpenAI/ChatGPT、Claude、Gemini/Antigravity 显示真实 OAuth 配额窗口（5h / 周 / 月，
  含 Claude 按模型分组的限额）；Grok/xAI 只有 week / month 两个窗口（上游如此）；
  Kimi 显示周额度与 5 小时限额；Cursor Overview 卡片显示 included 美元剩余，以及
  **Auto/Composer** 与 **API/named** 两个用量池进度条。
- 每个 provider 独立品牌色；配额条、状态点、图表均有入场动效（全部 transform/opacity
  合成层动画，滚动不掉帧；尊重系统"减少动态效果"设置）。
- 配额抓取失败时，账号行会直接显示失败原因（不再只有干巴巴的 "not loaded"）。
- OAuth 与 API key 分开展示；套餐等级只显示在单个账号行，provider 卡片只显示账号数。
- 本地持久化已消费的 usage queue 记录，用于成本统计与 30 天历史柱状图。
- 支持开机自启（首次运行自动注册：Windows 登录项 / Linux XDG autostart）。
- Cursor 额度优先读 CPA 里的 `cursor` OAuth；若 CPA 没有，则回退本机 Cursor 登录态。

## 安装

### Windows

#### 方式一：安装器（推荐）

从 [Releases](../../releases) 下载 `CLIProxy-Quota-Tray-Setup-*.exe` 并运行：

- 安装到 `%LOCALAPPDATA%\CLIProxy Quota Tray`（无需管理员权限）；
- 自动结束正在运行的旧实例、创建开始菜单快捷方式，装完自动启动；
- 附带卸载器（出现在系统"应用列表"）。卸载会移除程序与开机自启项，
  但**保留**你的设置与 usage 历史数据。

> 安装器未签名，Windows SmartScreen 会提示"未知发布者"——点"更多信息 → 仍要运行"。

#### 方式二：绿色版

下载 Releases 里的 zip，解压后直接运行 `CLIProxy Quota Tray.exe`。

### Linux

```bash
npm install
npm run package:linux
npm run install:linux
cliproxy-quota-tray --show
```

- 安装到 `~/.local/share/CLIProxy-Quota-Tray`
- 桌面入口：`~/.local/share/applications/cliproxy-quota-tray.desktop`
- 命令：`~/.local/bin/cliproxy-quota-tray`（需确保该目录在 `PATH` 中）
- 首次启动会写入 XDG 开机自启：`~/.config/autostart/cliproxy-quota-tray.desktop`
- 本地数据目录：`~/.config/CLIProxy Quota Tray/quota-monitor/`
  （Electron `userData`；usage 历史为其中的 `usage-events.jsonl`）

> **托盘提示（GNOME / Zorin 等）**：Linux 上 AppIndicator 常常不会把左键点击交给应用。
> 请用托盘菜单里的 **Open Dashboard** 打开面板。若系统托盘区域本身不可见，
> 需要安装/启用 AppIndicator 扩展（例如 GNOME 的 `gnome-shell-extension-appindicator`）。
>
> 默认走 X11/XWayland 显示后端（避免部分 Wayland + Vulkan 组合直接崩掉）。
> 若要强制原生 Wayland：`ELECTRON_OZONE_PLATFORM_HINT=wayland cliproxy-quota-tray`。

也可直接运行打包目录，无需安装：

```bash
npm run package:linux
"./release/CLIProxy Quota Tray-linux-x64/CLIProxy Quota Tray" --show
```

## 首次配置

1. 运行后托盘出现图标，点击打开 dashboard——首次为 **Demo 模式**（假数据），
   顶部有提示。
2. 点右上角 ⚙ 打开 Settings：
   - **CLIProxyAPI Base URL**：你的 CPA 管理地址，例如
     `http://127.0.0.1:8317/v0/management`（只填 `host:port` 也可以，会自动补全路径）。
     CPA 在远程服务器时需要其配置 `remote-management.allow-remote: true`。
   - **Management Key**：CPA 配置里的 `remote-management.secret-key` 明文。
   - **Poll seconds**：账号、状态与配额刷新间隔，默认与最小值均为 `1200`（20 分钟）。
   - **Queue batch**：每次从 usage queue 读取的记录数，默认 `200`。
   - **Show Cursor subscription usage**：显示 Cursor 订阅额度（included 美元、
     Auto/Composer 池、API 池）。优先使用 CPA 的 `cursor` OAuth；否则读取本机
     Cursor 登录态（非官方 API；JWT 只发给 `api2.cursor.sh`，不会进渲染进程）。
3. 点 **Save**——连接成功后账号与配额会立刻加载。
4. 若 Cost 卡片显示 "Queue off"，点 Settings 里的 **Enable usage queue**
   开启 CPA 的用量统计（等价于管理 API `PUT /usage-statistics-enabled`）。

> **注意**：CPA 的 `usage-queue` 是消费型队列——读取即取走。本应用会把读到的记录
> 落盘到本地（Windows：`%APPDATA%\CLIProxy Quota Tray\quota-monitor\usage-events.jsonl`；
> Linux：`~/.config/CLIProxy Quota Tray/quota-monitor/usage-events.jsonl`），
> 后续图表从本地历史计算。同一个 CPA 不要同时开多个消费端，否则成本统计会互相分流。

应用主进程会约每 30 秒独立消费 usage queue，并持续读取到当前队列排空；这个频率不受
20 分钟配额缓存影响。记录会先落盘，再进行耗时更长的账号与 provider 配额刷新。

> 连接远程 CPA 时建议使用 HTTPS 或 SSH 隧道。只有 `127.0.0.1` / `localhost` 等本机
> 地址适合直接使用 HTTP，避免 Management Key 在网络中明文传输。

### 配额刷新语义

- 账号与官方状态每次界面轮询都会刷新；usage queue 由主进程约每 30 秒独立消费；
  **配额窗口默认缓存 20 分钟**（避免频繁请求 OAuth provider 端点），点右上角 ↻
  会强制刷新配额。
- 账号行显示 `not loaded` = CPA 还没返回该账号的配额数据；如果抓取出错，
  错误原因会以红字显示在账号行内（常见：CPA 版本过旧没有 `/api-call` 端点、
  CPA 服务器出网被 Cloudflare 拦截、账号 token 过期需要重新登录）。

## 数据来源

CLIProxyAPI Management API：

- `GET /auth-files?all=true` / `GET /usage-statistics-enabled`
- `GET /usage-queue?count=...` / `GET /api-key-usage`
- `POST /api-call`（以 `$TOKEN$` 占位符由 CPA 注入对应账号的 OAuth token）

Provider 配额（经 CPA `/api-call` 代理）：

- ChatGPT/Codex：`https://chatgpt.com/backend-api/wham/usage`
- Claude：`https://api.anthropic.com/api/oauth/usage`（套餐来自 oauth/profile）
- Antigravity/Gemini：Google Cloud Code 配额汇总端点
- Grok/xAI：`https://cli-chat-proxy.grok.com/v1/billing`
- Kimi：`https://api.kimi.com/coding/v1/usages`（周额度 + 5 小时限额）
- Cursor：`GetCurrentPeriodUsage`（CPA `cursor` OAuth，或本机 Cursor JWT 回退）；
  Auto 与 Composer 共享同一用量池（`autoPercentUsed`），与 API/named 池分开显示

官方状态：`status.openai.com` / `status.claude.com` 的 statuspage summary。

## 开发

需要 Node.js 22.12 或更新版本。

```bash
npm install
npm run dev            # Vite 开发服务器（纯 UI，无 Electron 桥，自动进 Demo 模式）
npm run electron       # 构建产物 + Electron 运行（真实 CPA 数据）
npm run preview:fake   # 构建 + 假数据预览页 http://127.0.0.1:5199/preview.html
npm test               # Node 内置测试
```

假数据预览页支持 URL 参数直达任意 UI 状态：
`?click=tab:Claude`、`?click=settings`、`?click=status:Anthropic`、
`?click=expand:ChatGPT`、`?scroll=1400`。设计规范见 [AGENT.md](AGENT.md)。

## 打包

```bash
npm run package:win      # → release/CLIProxy Quota Tray-win32-x64/
npm run package:linux    # → release/CLIProxy Quota Tray-linux-x64/
npm run install:linux    # 安装到 ~/.local（仅 Linux）
```

Windows 安装器（需要 [NSIS](https://nsis.sourceforge.io/)，Windows 或 Linux 的 makensis 均可）：

```bash
makensis -DSRC="release/CLIProxy Quota Tray-win32-x64" \
         -DOUTFILE="release/CLIProxy-Quota-Tray-Setup.exe" \
         scripts/installer.nsi
```

## 常见问题

**为什么套餐（Pro/Max）不显示在 provider 卡片标题上？**
设计规则：卡片标题只显示 OAuth 数量，套餐只标在单个账号行，避免多账号时误导。

**为什么 Grok 没有 5h limit？**
xAI 的 billing 端点只提供 week / month 两个维度。

**为什么看不到单独的 Composer 额度？**
Cursor 上游把 Auto 与 Composer 放在同一池（`autoPercentUsed`），没有拆开的 Composer 数字；
卡片里的 **Auto / Composer** 就是这块额度。

**配额多久刷新一次？**
自动轮询默认每 20 分钟强制拉取一次 provider 配额；手动 ↻ 也会强制刷新。

**ChatGPT 配额全部 not loaded？**
看账号行里的红字错误。最常见的原因是 CPA 服务器自身访问不了
`chatgpt.com`（数据中心 IP 被 Cloudflare 拦截）——给 CPA 配置出口代理
（`config.yaml` 全局 `proxy-url`，或对应 auth 文件里的 `proxy_url` 字段）即可。

**Linux 托盘点一下没反应？**
多数 GNOME/Zorin 环境走 AppIndicator，左键不会触发应用的 `click` 事件。
用托盘右键/菜单里的 **Open Dashboard**。若完全没有托盘图标，安装 AppIndicator 扩展。

**CPA 里没有 cursor 账号怎么办？**
官方 CLIProxyAPI 目前没有 `--cursor-login`。Overview 会回退读取本机 Cursor 登录态；
也可以把本机 Cursor JWT 写成 CPA `auth-dir` 下的 `cursor.json`（`type: cursor`）供
`/api-call` 拉额度（不代表完整 Cursor 模型路由）。

## License

[MIT](LICENSE)
