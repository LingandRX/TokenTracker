# 用量模块解析（中文）

> 本文是对 Token Tracker 用量相关模块的架构解析，以及「如何接入一个新 provider 并查询余额」的完整示例。
> 官方英文文档见 [opencode-go-limits.md](./opencode-go-limits.md)，项目总纲见 `CLAUDE.md`。

---

## 一、两条独立的「用量」线

项目里有两个容易混淆的「用量」概念：

| | A. 用量统计 | B. 用量限额 |
|---|---|---|
| 回答的问题 | 我用了多少 token / 花了多少钱 | 各订阅还剩多少配额 |
| 数据来源 | 本地日志 → `queue.jsonl` | 各 provider 官方 API / 本地凭据 |
| 后端核心 | `src/lib/local-api.js` 聚合端点 | `src/lib/usage-limits.js` |
| 前端入口 | `DashboardPage` / `UsageOverview` | `LimitsPage` / `UsageLimitsPanel` |

---

## 二、A 线：用量统计

```
AI CLI → hook → rollout.js 解析 → ~/.tokentracker/queue.jsonl → local-api 聚合 → dashboard
```

### 聚合端点（`src/lib/local-api.js`）

| 端点 | 作用 |
|---|---|
| `tokentracker-usage-summary` | 区间总计 + 滚动 7/30 天（`last_7d` / `last_30d` / `avg_per_active_day`） |
| `tokentracker-usage-daily` / `-hourly` / `-monthly` | 三档时间粒度 |
| `tokentracker-usage-heatmap` | 活跃热力图 |
| `tokentracker-usage-model-breakdown` / `-category-breakdown` | 模型 / 类别拆分 |
| `tokentracker-project-usage-summary` / `-detail` | 按项目维度 |
| `tokentracker-sessions` / `-session-insights` / `-context-health` | 会话级分析 |
| `tokentracker-achievements` / `-wrapped` | 徽章 / 年度报告 |

### 关键约束：token 归一化

```
input_tokens                 = 仅非缓存输入（不含 cache 读写）
cached_input_tokens          = cache 读取
cache_creation_input_tokens  = cache 写入
reasoning_output_tokens      = 推理 token
total_tokens                 = input + output + cache_creation + cache_read (+ reasoning_output)
```

**成本只由这五个分项算出，绝不用 `total_tokens`**（`computeRowCost`，`src/lib/pricing/index.js`）：

```
input + output + cached_input + cache_creation + reasoning_output
```

> 如果新 provider 只填 `total_tokens` 而 input/output 为 0，面板会显示 **$0 成本**，与定价配置无关。
> 要么把 total 拆分到各列，要么扩展 `computeRowCost`。

### Queue entry 格式

```json
{
  "hour_start": "2026-04-05T14:00:00Z",
  "source": "claude|codex|cursor|gemini|...",
  "model": "claude-opus-4-6|gpt-5.4|...",
  "input_tokens": 0, "output_tokens": 0,
  "cached_input_tokens": 0, "cache_creation_input_tokens": 0,
  "reasoning_output_tokens": 0,
  "total_tokens": 0, "conversation_count": 1
}
```

UTC、半小时桶、只追加 —— 读取方按 `(source, model, hour_start)` 取最新一条。

### 前端数据层

`use-usage-data.ts` / `use-trend-data.ts` / `use-usage-model-breakdown.ts` / `use-project-usage-*.ts`
→ `UsageOverview.jsx`、`StatsPanel`、`TrendMonitor`、`ActivityHeatmap`

---

## 三、B 线：用量限额（重点）

### 编排核心：`src/lib/usage-limits.js`（4308 行）

#### `getUsageLimits()` 流程（L3761）

1. **两层缓存 key**：按 Devin 开关分 `on` / `off` 两份缓存
   - 内存缓存 TTL **2 分钟**（`CACHE_TTL_MS = 2 * 60 * 1000`）
   - `cacheExpiresAtMs()` 把**下一次窗口重置时刻**算进过期时间，让菜单栏的重置庆祝（confetti）不落后于 TTL（下限 `CACHE_MIN_TTL_MS = 5s`）
   - **singleflight**：并发请求复用同一个 in-flight promise（`inFlightByDevinSelection`）

2. **`fetchUsageLimitsUncached()`** 两段并发：
   - 第一段 `Promise.all`：读 Claude OAuth token + 订阅详情 + Codex auth bundle；Codex 令牌按 JWT 过期时间**提前 5 分钟**主动刷新（opaque/legacy token 回退到 `last_refresh > 8 天`）
   - 第二段大 `Promise.all`：**20 个 provider 并发拉取**，每个都包 `withProviderTimeout(..., DEFAULT_PROVIDER_TIMEOUT_MS = 15s)`
     - Claude / Codex / Cursor / Kimi / Gemini / Kiro / Antigravity / Copilot / Grok / ZCode / OpenCode Go / Qoder / Qoder CN / Ark Coding Plan / Ark Agent Plan / CommandCode / Devin / 服务状态探针

3. **组装 `data`**：每个 provider 挂 `withPlanLabel()` 计划名

4. **统一 `provenance` 元数据**（每个 provider 都有）：

   ```js
   {
     source,                             // provider-api | disk-cache | local-estimate | ...
     confidence,                         // official | observed | inferred
     captured_at,
     stale,                              // 显式 stale 或 age > 10 分钟
     age_seconds
   }
   ```

   推断规则：
   - `estimate|inferred` → `inferred`
   - `local|database|sqlite|cache` → `observed`
   - 其余 → `official`

5. 按**任意窗口的最近重置时刻**写入缓存过期

#### 容错设计

| 场景 | 行为 |
|---|---|
| Claude 429 | 记冷却时间到磁盘，**冷却期内完全跳过上游调用**（重试只会续罚）；有缓存发缓存，没缓存发 `retry in ~Nm` |
| Claude 令牌被清空 | 凭据**条目存在**即判为「登录过期」→ `auth_action_required: "reauth"`，而不是隐藏整个区块 |
| Claude/Codex/OpenCode 拉取失败 | 回落磁盘缓存，标 `stale: true` + `cached_at`，前端显示「Updated Xm ago」 |
| Codex 主动刷新失败但 access token 还有效 | **优先信 200 的实时读取**，不让刷新错误丢掉可用配额 |
| Auth 类错误（401/403/过期） | **绝不被 stale 缓存掩盖**，必须透出 `auth_action_required` / `auth_error` |
| 服务状态 | Claude 区块在组装**之后**才附加 `service_status`，确保不写进磁盘缓存（否则几小时后还会弹事故横幅） |
| 任何 provider 抛错 | `.catch()` → `{ configured: true, error }`，**单家失败不拖垮整体** |

#### 分层文件结构

| 文件 | 行数 | 职责 |
|---|---|---|
| `usage-limits.js` | 4308 | 编排 + Claude/Codex/Cursor/Kimi/Gemini/Kiro/Copilot/Antigravity |
| `grok-limits.js` | 796 | 周/月周期由 API `period_type` 决定 |
| `zcode-limits.js` | 972 | |
| `qoder-limits.js` | 837 | |
| `opencode-go-limits.js` | 807 | 三级数据源 |
| `devin-limits.js` | 249 | 纯服务端窗口，无本地兜底 |
| `commandcode-limits.js` | 317 | |
| `ark-coding-plan-limits.js` / `ark-agent-plan-limits.js` | 537 / 438 | |

#### Devin 特例：opt-in

`src/lib/local-api.js:3393`：

```js
const localAuthorized = isAuthorizedLocalMutation(req);   // 先做授权检查
const devinEnabled = devinParam === "1" || devinParam === "true";
if (devinEnabled && !localAuthorized) return json(res, { error: "Unauthorized" }, 401);
```

- 授权检查**不依赖用户可控的 `devin=1` 参数**，先无条件求值
- 未授权直接 401，**绝不会因为开关被绕过而去读 `credentials.toml` 或发网络请求**
- 前端 `withoutUnselectedDevin()` 会在开关关闭时把残留数据改写成 `{ configured: false }`

#### 端点

```
GET /functions/tokentracker-usage-limits[?refresh=1][&devin=1]
```

- `refresh=1` → 穿透磁盘缓存打上游，但**绝不穿透 429 冷却**
- 普通请求 → 走 2 分钟内存缓存 + 磁盘兜底

### 前端

#### Hook：`dashboard/src/hooks/use-usage-limits.ts`

- 挂载/切换页面走**服务端缓存**（非强制），只有手动 Refresh 才 `refresh=1`
  > 因为每次导航都强制刷新曾经把 Claude 的 OAuth usage 端点打到限流
- `focus` / `visibilitychange` 节流 **15s** 刷新
- `useLatestRequestGuard([devinSelected, localEnabled])` 防慢响应覆盖新数据
- Devin 开关变化会让旧请求**整体失效**并清掉残留行
- 每次拿到 data 后触发 `sendPredictiveLimitAlerts(data)`（若用户开启了告警）

#### 规格驱动渲染：`usage-limits-provider-specs.js`

```js
export const PROVIDER_LIMIT_SPECS = {
  claude: {
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.claude_5h", window: data.five_hour,
          pctField: "utilization", resetField: "resets_at", windowSeconds: 5 * 3600 },
        // ...
      ];
    },
  },
  // ...
};
```

窗口统一声明为 `{ key, labelKey, window, pctField, resetField, windowSeconds }`。

**同一份 spec 被三处复用**：
1. `UsageLimitsPanel.jsx` 渲染进度条
2. `paceForSpec()` / `limit-pace.js` 计算消耗速率
3. `lib/limit-alerts.js` 生成预测告警

#### UI 组件

- `UsageLimitsPanel.jsx`（1254 行）→ `LimitsPage.jsx`
  - `LimitBar` / `StatusBadge` / `ToolGroup` / `LimitWindowSection`
  - `SubscriptionBar` / `SubscriptionDetail`（第三方订阅）
  - `ResetBankSection`（Codex 重置积分卡）
  - 各 provider 的 setup hint（`OpenCodeGoSetupHint` / `DevinSetupHint` / ...）
- 显示偏好 `use-limits-display-prefs.js`：
  - provider 排序 / 可见性 / Used vs Remaining 模式
  - localStorage key：`tt.limits.providerOrder`、`tt.limits.providerVisibility`
  - 跨 tab 用 `storage` 事件 + `LIMITS_PREFS_CHANGED_EVENT` 同步

#### 预测告警：`dashboard/src/lib/limit-alerts.js`

```js
const pace = computePace({ usedPercent, windowSeconds, resetMs, mode: "used", now });
if (!pace.runsOutEta || !pace.paceOver || usedPercent < 20 || !(resetMs > now)) continue;
alerts.push({ id: `${providerId}:${spec.key}:${resetMs}`, ... });
```

- 按 `provider:key:resetMs` 去重，避免同一周期重复骚扰
- `id` 里带 `resetMs`，窗口重置后自动成为新告警

### 原生端消费

| 平台 | 文件 |
|---|---|
| macOS | `APIClient.swift:112` 拉同端点 → `UsageLimitsWidget.swift`（WidgetKit）、`UsageLimitBar.swift`、重置庆祝 |
| Windows | `TokenTrackerWin/UsagePoller.cs:187` 轮询同端点 |
| 测试 | `UsageLimitsPublicationTests`、`UsageLimitsRetentionTests`、`macos-limit-reset-celebration.test.js` |

### 测试覆盖

```
test/usage-limits.test.js
test/usage-limits-singleflight.test.js
test/usage-limits-reset-bank.test.js
test/macos-usage-limits-timeout.test.js
test/limits-providers-parity.test.js
test/macos-limit-reset-celebration.test.js
test/<provider>-limits.test.js            # 每家一个
dashboard/.../UsageLimitsPanel.test.jsx
dashboard/.../use-usage-limits.test.ts
```

### 一句话总结

> 「**并发拉 20 家 provider 配额 + 三级缓存 + 磁盘兜底 + 429 冷却 + provenance 溯源 + 规格驱动渲染**」的模块。
> 最大的设计主题是：**永不让单家失败或限流毁掉整块面板，也永不让可操作的认证错误藏在缓存后面。**

---

## 四、示例：接入 OpenCode Go 并查询余额

OpenCode Go 已是完整实现，正好当**接入新 provider 的样板**。共 4 个必改触点（`CLAUDE.md` 明确列出）。

### 触点 ①：`src/lib/opencode-go-limits.js` — 抓取 + 归一化

把上游任何格式**归一成统一契约**：

```js
const GO_USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";

// 百分比容错：上游有时给 0-1 小数（0.02 = 2%），只在 <1 时才乘 100
function clampPercent(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) n *= 100;   // 真正的 "1" 保持 1%，不变成 100%
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

// 唯一契约：used_percent + reset_at(ISO)
function buildWindow({ usagePercent, resetInSec, nowMs }) {
  const pct = clampPercent(usagePercent);
  if (pct === null) return null;
  const seconds = Number(resetInSec);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return { used_percent: pct, reset_at: new Date(nowMs + seconds * 1000).toISOString() };
}
```

上游有**两种响应形状**，先试新版再回退旧版：

```js
// 旧 spec: { rollingUsage: { usagePercent, resetInSec } }
// 线上   : { usage: { rolling: { percent, resetsAt } } }
const rolling = resolveApiWindow(payload?.rollingUsage, payload?.usage?.rolling ?? payload?.rolling);
const weekly  = resolveApiWindow(payload?.weeklyUsage,  payload?.usage?.weekly);
const monthly = resolveApiWindow(payload?.monthlyUsage, payload?.usage?.monthly);
```

**三级数据源优先级**：

| 优先级 | 来源 | 配置 | 语义 |
|---|---|---|---|
| 1 | 官方 Go usage API | `OPENCODE_GO_API_KEY` | 服务端权威窗口 |
| 2 | 登录态仪表盘抓取 | `OPENCODE_GO_AUTH_COOKIE`（+ 可选 `OPENCODE_GO_WORKSPACE_ID`） | 遗留兼容回退 |
| 3 | 本地 `opencode.db` 成本聚合 | `TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1` | 显式标注的历史估算，**无法证明订阅有效** |

```js
if (apiKey) {                       // 1️⃣ 官方 API（权威）
  const api = await fetchOpencodeGoApiLimits({ ... });
  if (有窗口) return { ...api, source: "api" };
  if (api.auth_error) return api;   // ⚠️ 认证错误绝不降级隐藏
  if (!cfg) return api;             // 没配 cookie 就到此为止
}
if (cfg) {                          // 2️⃣ 仪表盘抓取
  const web = await scrapeOpencodeGoWeb({ ... });
  if (web && 有窗口) return { ...web, source: "web" };
  if (allowLocalEstimate) return localGoResult(await collectOpencodeGoLocal({ ... })); // 3️⃣ 本地估算
}
if (!allowLocalEstimate) return { configured: false };  // 默认不猜
```

> 为什么本地估算要显式开关：本地 `opencode.db` 只有历史消费记录，**无法证明订阅还活着**。
> 所以默认关闭，必须用 `TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1` 显式承担这个不确定性。
> 美元上限硬编码在 `goDollarLimits()`：**$12/5h、$30/周、$60/月**。

**错误语义**（必须区分，前端据此行动）：

```js
if (response.status === 401) return { configured: true, auth_error: true,
  error: "OpenCode Go API key is missing, invalid, expired, or not entitled..." };
if (response.status === 403) return { configured: true, auth_error: true,
  error: "OpenCode Go subscription required for this API key." };
```

SQLite 走 `readSqliteJsonRowsAsync` —— **限额轮询绝不能阻塞事件循环**。

### 触点 ②：`src/lib/usage-limits.js` — 挂进并发 poll

```js
// L3851 的 Promise.all 里加一槽
withProviderTimeout(
  fetchOpencodeGoLimits({ home, env, fetchImpl: providerFetch }),
  "OpenCode Go", providerTimeoutMs,
).catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
```

组装阶段（L4134）决定走缓存还是透出错误：

```js
const opencodeGoIsAuthError = Boolean(opencodeGoRaw?.auth_error)
  || /Not signed in|auth cookie|Refresh the auth cookie|401|403/.test(opencodeGoRaw?.error || "");

if (opencodeGoRaw.configured === false)        opencodeGo = opencodeGoRaw;   // 未配置
else if (opencodeGoIsAuthError)                opencodeGo = opencodeGoRaw;   // ⚠️ 不被缓存掩盖
else if (subscription_status === "inactive")   opencodeGo = opencodeGoRaw;   // 未订阅
else if (有窗口) {                                 // ✅ 成功 → 写磁盘缓存
  opencodeGo = { ...opencodeGoRaw, stale: false, cached_at: new Date(nowMs).toISOString() };
  writeOpencodeGoLimitsCache(opencodeGo, { home, nowMs });
}
else {                                           // 瞬时失败 → 回落磁盘缓存
  const cached = readOpencodeGoLimitsCache({ home, nowMs });
  opencodeGo = cached || opencodeGoRaw;
}

// 计划名归一化（L4220）
opencodeGo: withPlanLabel(opencodeGo, opencodeGo?.plan_label, "OpenCode Go"),
```

磁盘缓存还会**校验 `reset_at` 是否已过期**（`isOpencodeGoCacheWindowUsable`）—— 过期窗口不算可用。

### 触点 ③：`dashboard/src/ui/dashboard/components/usage-limits-provider-specs.js`

```js
opencodeGo: {
  // 窗口长度由服务端定义，没有可信的客户端窗口长度就无法算 pace 预测，
  // 所以故意不设 windowSeconds —— paceForSpec 会自动跳过预测文案。
  windows(data) {
    return [
      { key: "5h",     labelKey: "limits.label.opencode_go_5h",       window: data.primary_window },
      { key: "weekly", labelKey: "limits.label.opencode_go_weekly",   window: data.secondary_window },
      { key: "monthly", labelKey: "limits.label.opencode_go_monthly", window: data.tertiary_window },
    ];
  },
},
```

### 触点 ④：注册与文案

| 改动 | 位置 |
|---|---|
| provider ID + 图标 key | `dashboard/src/lib/limits-providers.js:15`（`LIMIT_PROVIDER_IDS`、`opencodeGo: "OPENCODE"`） |
| 窗口标签文案 | `dashboard/src/content/copy.csv:1272-1274`（**禁止硬编码**，`validate:ui-hardcode` 会拦） |
| TS 类型 | `dashboard/src/hooks/use-usage-limits.ts` 的 `UsageLimitsData` 加 `opencodeGo` 字段 |
| 本地 API 端点 | **无需改动** —— `getUsageLimits()` 整个对象直接透传 |
| 桌面端 | macOS/Windows 走同一个端点，**无需改动** |

### 查询余额

#### 1. 先验证上游 key（最直接）

```bash
curl -sS https://opencode.ai/zen/go/v1/usage \
  -H "Authorization: Bearer $OPENCODE_GO_API_KEY" | jq
```

```json
{
  "usage": {
    "rolling": { "percent": 42, "resetsAt": "2026-01-01T09:00:00Z" },
    "weekly":  { "percent": 18, "resetsAt": "..." },
    "monthly": { "percent": 7,  "resetsAt": "..." }
  },
  "useBalance": ...,
  "status": "active"
}
```

- `401` = key 缺失 / 失效 / 无 Go 订阅（早期上游不区分）
- `403` = 无 Go 订阅（新版上游区分了）

#### 2. 走本地端点（生产路径，含缓存/降级）

```bash
# 启动本地服务
node bin/tracker.js serve          # :7680

# 普通读：走 2 分钟内存缓存
curl -s localhost:7680/functions/tokentracker-usage-limits | jq .opencodeGo

# 强制刷新：穿透磁盘缓存打上游
curl -s "localhost:7680/functions/tokentracker-usage-limits?refresh=1" | jq .opencodeGo
```

提取「余额」（剩余百分比 + 重置时间）：

```bash
curl -s "localhost:7680/functions/tokentracker-usage-limits?refresh=1" \
| jq -r '
  .opencodeGo as $o |
  "来源: \($o.source)  订阅: \($o.subscription_status // "-")",
  (if $o.error then "错误: \($o.error)" else empty end),
  { "5h  剩 \(100 - $o.primary_window.used_percent)%":   $o.primary_window.reset_at,
    "周  剩 \(100 - $o.secondary_window.used_percent)%": $o.secondary_window.reset_at,
    "月  剩 \(100 - $o.tertiary_window.used_percent)%":  $o.tertiary_window.reset_at }
  | to_entries[] | "  \(.key) → 重置于 \(.value)"
'
```

查数据可信度：

```bash
curl -s localhost:7680/functions/tokentracker-usage-limits \
| jq '{opencodeGo: .opencodeGo.provenance}'
# → { source:"api", confidence:"official", stale:false, age_seconds:3 }
```

#### 3. 看美元余额（本地估算，非权威）

```bash
TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1 node bin/tracker.js serve
```

本地 `opencode.db` 的消费 cost ÷ 硬编码上限（$12/5h、$30/周、$60/月）→
`source: "local-estimate"`，`confidence` 判为 `inferred`。

#### 4. 前端 UI

`/limits` 页面 → **OPENCODE** 分组 → 三条进度条（5h / Weekly / Monthly），
显示 Used 或 Remaining（右上角 Display settings 切换）；
失败时显示红条 + setup hint（`OpenCodeGoSetupHint`）而非静默消失。

### 配置（`.env.example`）

```dotenv
# 首选：官方 OpenCode Go usage API
OPENCODE_GO_API_KEY=

# 遗留回退：登录态仪表盘抓取
OPENCODE_GO_WORKSPACE_ID=
OPENCODE_GO_AUTH_COOKIE=

# 可选：显式标注、未经核实的本地历史估算
# TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1
```

> 密钥只放本地环境，**绝不提交、不打印、不进前端 `VITE_` 变量**。

### 验证

```bash
node --test test/opencode-go-limits.test.js   # 单文件
npm run ci:local                              # 全量：测试 + validate:copy/ui-hardcode/guardrails + 构建
```

### 发布注意

改了 `src/` 或 `dashboard/` 就要：

1. bump `package.json` 版本 → `npm run sync-versions` 同步其余版本文件
2. 触发 release workflow（macOS + Windows + Linux 一起发）

因为三个桌面平台的 `EmbeddedServer/` 都内嵌这份 CLI + 构建好的 dashboard，**只发 npm 会让桌面用户停在旧版**。

---

## 五、快速索引

| 我想... | 去看 |
|---|---|
| 加/改 provider 解析 | `src/lib/rollout.js` — 搜 `parse*Incremental` |
| 加限额 provider | `src/lib/<provider>-limits.js` + `usage-limits.js` 挂槽 + `usage-limits-provider-specs.js` + `limits-providers.js` + `copy.csv` |
| 加本地 API 端点 | `src/lib/local-api.js` — 搜 `p === "/functions/tokentracker-` |
| 加模型定价 | `src/lib/pricing/curated-overrides.json` + `dashboard/edge-patches/tokentracker-leaderboard-refresh.ts`（verbatim 复制到其余 4 个 edge 文件）|
| 加 dashboard 页面 | `dashboard/src/pages/` + `App.jsx` 里 `React.lazy()`（`NativeAuthCallbackPage` 例外，必须 eager） |
| 加 UI 文案 | `dashboard/src/content/copy.csv` — 永不硬编码 |
| 改菜单栏 UI | `TokenTrackerBar/Services/` + `Views/` |
| 原生 ↔ Web 桥接 | `TokenTrackerBar/Services/NativeBridge.swift` + `dashboard/src/lib/native-bridge.js` |
