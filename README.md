# wechat-channels-kit

微信视频号助手工具箱。读取你已发布视频的评论数，为「评论数为 0」的视频生成并提交评论。

同时提供两种入口：

- **CLI**：`wxch` 命令行，人或 AI 都能直接调用
- **MCP**：`wxch mcp` 以 stdio 方式运行 Model Context Protocol server，供 AI 客户端挂载为工具

> 本工具是原 Chrome 扩展方案的替代实现。扩展依赖浏览器常驻，MCP/CLI 则可以被 AI 直接编排。

---

## 为什么需要它

视频号官方**没有开放评论 API**（微信开放社区明确回复"暂不支持"），只有视频号助手网页端背后的内部接口可用。

CLI/MCP 与浏览器扩展的关键差异是：脱离浏览器后需要自己拿到登录态。本工具的做法是**只读复用你本机浏览器已登录的 Cookie**——你不需要扫码、不需要复制粘贴 Cookie、也不需要额外启动浏览器。

---

## 安装

```bash
# 全局安装
npm install -g wechat-channels-kit

# 或免安装直接用
npx -y wechat-channels-kit --help
```

要求 Node.js >= 22.5（依赖内置 `node:sqlite` 读取浏览器 Cookie 库；低版本会自动回退到 `sqlite3` 命令行）。

前置条件：在 Chrome（或 Edge / Brave / Chromium）里登录 <https://channels.weixin.qq.com/platform/post/list>。

---

## 快速开始（CLI）

```bash
# 1. 检查登录态（--live 会真实调用一次接口验证）
wxch login --live

# 2. 拉取已发布视频，只看评论数为 0 的
wxch videos list --page-size 20 --zero

# 3. 干跑：预览将要提交的评论，不会真的发出
wxch comment batch --limit 5

# 4. 确认无误后真正提交
wxch comment batch --limit 5 --yes
```

**干跑是默认行为**。只有显式加 `--yes` 才会真正提交评论。

---

## 接入 MCP（给 AI 用）

在支持 MCP 的客户端（Claude Desktop、TRAE、Cursor 等）里添加：

```json
{
  "mcpServers": {
    "wechat-channels": {
      "command": "npx",
      "args": ["-y", "wechat-channels-kit", "mcp"]
    }
  }
}
```

暴露的工具：

| 工具 | 作用 |
| --- | --- |
| `check_login` | 检查登录态，`live=true` 时真实调用接口验证 |
| `list_videos` | 拉取已发布视频（ID / 短标题 / 正文描述 / 评论数），可只返回 0 评论的 |
| `generate_comment` | 用本机配置的 AI 生成一条评论文案（可选，不配置 AI 时用不到） |
| `add_comment` | 给指定视频发评论，默认 `dryRun=true` 只预览 |
| `batch_comment_zero` | 批量为 0 评论视频发评论，默认 `dryRun=true` |
| `comment_config_status` | 查看评论接口配置状态（是否仍在使用内置默认值） |

> MCP 工具的 `dryRun` 默认是 `true`。AI 必须显式传 `dryRun: false` 才会真正发表评论——这是刻意的护栏。

### 让外部 AI 来编排（推荐用法）

工具本身**不需要内置 AI**。把它挂到 MCP 客户端后，由客户端那边的大模型来完成「读描述 → 想评论 → 提交」：

1. **取列表**：`list_videos({ onlyZeroComment: true })` → 得到每条视频的 `id`、`title`、`description`（完整正文）、`commentCount`。
2. **生成评论**：外部 AI 依据 `description` 自行写出贴合的评论正文（不经过本工具）。
3. **提交**：`add_comment({ videoId: id, content: 生成的正文, dryRun: false })`。

先干跑、再提交：

```jsonc
// 第 1 步
{ "name": "list_videos", "arguments": { "onlyZeroComment": true, "pageSize": 20 } }
// → { "videos": [ { "id": "export/UzFf...", "title": "分红到手 你怎么看这笔钱？", "description": "那条「分红到账」的短信…", "commentCount": 0 } ] }

// 第 3 步（先 dryRun 预览）
{ "name": "add_comment", "arguments": { "videoId": "export/UzFf...", "content": "把分红讲透了，受教。", "dryRun": true } }
// 确认无误后
{ "name": "add_comment", "arguments": { "videoId": "export/UzFf...", "content": "把分红讲透了，受教。", "dryRun": false } }
```

CLI 侧等价的两步：`wxch videos list --zero --json`（拿 `id` 与 `description`）+ `wxch comment add <id> --text "..." --yes`。

---

## 评论接口（已内置默认值）

发表评论的接口地址与请求体结构已经内置，开箱即用：

- 接口：`/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/create_comment`
  （请求时自动刷新 `_rid`，并补齐 `_aid` / `_pageUrl`）
- 请求体：`exportId` 放目标视频 ID、`content` 放评论正文，`clientId` / `timestamp` 每次自动重新生成

提交前可以先看一眼将要发送的内容：

```bash
wxch comment add export/UzFf... --text "先收藏了" --show-payload
```

`--show-payload` 只打印接口地址与请求体、不发起请求，适合排障。若字段与真实接口有出入，可用下面的 HAR 学习流程校准，或用 `--payload` / `--endpoint` 临时覆盖。

### 用 HAR 校准（可选，接口改版时用）

接口没有公开文档，页面改版后字段可能变化。此时从真实抓包里学会新结构：

1. 在视频号助手里，手动给自己的某条视频发一条评论；
2. 打开 DevTools → Network 面板 → 右键 → **Save all as HAR with content**；
3. 导入抓包：

```bash
# 先看看抓到了哪些候选请求
wxch comment template import ~/Downloads/channels.har --list

# 确认无误后写入配置
wxch comment template import ~/Downloads/channels.har
```

工具会自动排除列表类接口、定位评论请求，并把评论正文替换成 `{{content}}`、目标视频 ID 替换成 `{{objectId}}`。

之后可用 `wxch config show` 核对模板，或手动调整：

```bash
wxch config set commentEndpoint "/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/create_comment"
wxch config set commentPayloadTemplate '{"exportId":"{{objectId}}","content":"{{content}}"}'
```

---

## 命令速查

```
wxch login [--live]                    检查登录态
wxch videos list [--page-size N] [--page N] [--zero] [--json]
wxch comment add <videoId> [--text 内容] [--ai] [--payload JSON] [--endpoint PATH] [--show-payload] [--yes] [--dry-run]
wxch comment batch [--limit N] [--ai] [--yes] [--dry-run] [--interval ms]
wxch comment template import <har> [--list] [--index N]
wxch config path | show [--show-secrets] | set <key> <value>
wxch mcp                               以 MCP server 运行（stdio）
```

全局选项：

| 选项 | 说明 |
| --- | --- |
| `--cookie <header>` | 直接传入 Cookie 串，优先级最高，不落盘 |
| `--cookie-file <path>` | 从文件读取（Netscape 或 JSON 格式） |
| `--browser <name>` | `chrome` / `edge` / `brave` / `chromium` |
| `--profile <name>` | 指定浏览器 profile，缺省自动挑选**真正含 channels Cookie** 的那个 |
| `--user-data-dir <path>` | 直接指定浏览器用户数据目录 |
| `--json` | JSON 输出，便于程序与 AI 解析 |
| `-v, --verbose` | 输出调试日志 |

---

## 隐私与安全

这是本工具的设计红线，也是它能被分发的理由。

**不硬编码任何个人信息。** 仓库里没有账号 ID、没有 finder id、没有 Cookie、没有接口凭证。视频列表里的一切都来自你本机的登录态。

**凭证不出本机。** Cookie 只用于向 `channels.weixin.qq.com` 发起请求。工具不读取、不上报、不缓存到网络，也从不把 Cookie 值写入日志——日志统一经过脱敏（`wxch config show` 默认也脱敏，要看明文必须显式加 `--show-secrets`）。

**没有遥测。** 没有任何埋点、统计或"匿名上报"。除视频号站点与你自行配置的 AI 接口外，不会向任何第三方发起请求。

**只读浏览器数据。** 读取 Cookie 时先把数据库**复制到临时目录**再查询，绝不修改浏览器原始数据；临时副本用完即删。读取范围限定在 `weixin.qq.com` 域名。

**敏感配置权限收紧。** 配置文件写在 `~/.config/wxch/config.json`，权限 `0600`（仅本人可读写），目录 `0700`。

**AI 只拿到标题。** 使用 AI 生成文案时，只把「视频标题」发给该接口，不发送 Cookie、账号或任何身份信息。

**支持零落盘。** 不希望凭证写进配置文件时，用 `--cookie` 或环境变量注入：

```bash
export WXCH_COOKIE="sessionid=...; wxuin=..."
wxch videos list --zero
```

### 可用环境变量

| 变量 | 作用 |
| --- | --- |
| `WXCH_COOKIE` | 内联 Cookie 串（最高优先级） |
| `WXCH_COOKIE_FILE` | Cookie 文件路径 |
| `WXCH_COOKIE_SOURCE` | `chrome` / `file` / `inline` |
| `WXCH_CHROME_PROFILE` | 浏览器 profile |
| `WXCH_COMMENT_ENDPOINT` | 评论接口地址 |
| `WXCH_AI_BASE_URL` / `WXCH_AI_API_KEY` / `WXCH_AI_MODEL` / `WXCH_AI_PROMPT` | AI 文案生成配置 |

### AI 文案生成

任意 OpenAI 兼容接口均可：

```bash
wxch config set ai.baseUrl https://api.openai.com/v1
wxch config set ai.apiKey sk-xxxx
wxch config set ai.model gpt-4o-mini
wxch comment batch --ai
```

也可以完全不用 AI，改用固定文案池（多行随机轮换）：

```bash
wxch config set commentTexts "这条信息量很足，先收藏了。,讲得很清楚，受教了。"
wxch comment batch
```

---

## 已知限制

- 评论接口没有公开文档，但已内置默认地址与请求体模板，通常可直接使用；若接口改版或字段不符，用 HAR 校准一次即可。若视频号助手网页端本身不支持作者给自己的视频发新评论，则无法通过接口完成。
- 页面改版后接口路径可能变化，重新导入一次 HAR 即可。
- Chrome 的 `v20` 应用绑定加密 Cookie 无法在纯 JS 中解开（Windows 上较常见），此时请改用 `--cookie` 手动提供；macOS / Linux 的 `v10` 加密已支持。
- 频率需自行克制，建议保留默认 3000ms 间隔。

### 排障：errCode 300330 / 300334

这两个错误码都是**登录态**问题，与请求参数无关，改代码或换接口都不会好：

| 错误码 | 含义 |
| --- | --- |
| `300330` | 请求里没有有效会话（例如缺 `sessionid`） |
| `300334` | 会话存在但已失效 / 过期 |

处理办法：到浏览器里**重新登录视频号助手（重新扫码）**，再执行 `wxch login --live`，看到 `接口验证：通过` 即可继续。

---

## 作为库使用

```ts
import { ChannelsService } from 'wechat-channels-kit';

const service = await ChannelsService.create();
const zero = await service.listZeroCommentVideos({ pageSize: 20 });
const outcomes = await service.batchComment({ dryRun: true, limit: 3 });
```

---

## 分发

包已按 npm 发布规范配置好（`bin` / `exports` / `files` / `prepublishOnly` 构建）：

```bash
npm run build
npm publish --access public
```

MCP 市场上架时，启动命令填 `npx -y wechat-channels-kit mcp` 即可。

---

## 文件结构

```
src/
  core/
    constants.ts        站点接口路径与字段候选（无个人信息）
    client.ts           HTTP 客户端：post_list 拉取、评论提交
    parser.ts           响应通用解析（自动定位数组与字段）
    comment.ts          评论请求体模板与占位符替换
    ai.ts               OpenAI 兼容接口的文案生成
    har.ts              HAR 抓包解析与评论接口学习
    service.ts          CLI 与 MCP 共用的门面
    config.ts           配置读写（0600 权限）
    logger.ts           脱敏日志
    cookies/
      chrome.ts         定位浏览器 profile 与 Cookie 库
      decrypt.ts        AES-128-CBC 解密 + Keychain 取密钥
      jar.ts            Cookie 集合与请求头生成
      source.ts         Cookie 来源解析与缓存
  cli/                  命令行入口与表格渲染
  mcp/server.ts         MCP server 与工具定义
  index.ts              库入口
```

## License

MIT
