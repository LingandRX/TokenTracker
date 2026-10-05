# Xiaomi Token Plan (小米 MiMo Token Plan) 接入与配额查询方案

> 本文档针对 **Xiaomi Token Plan（小米 MiMo Token Plan）** 提供背景调研、上游数据契约分析，以及如何按照 TokenTracker 现有架构（参考 `docs/usage-module-analysis.zh-CN.md`）进行接入和余额查询的完整技术设计。

---

## 一、背景与核心概念

**Xiaomi MiMo Token Plan** 是小米大模型开放平台（MiMo）面向开发者推出的包月/订阅式 Token 额度套餐（分 Lite / Standard / Pro / Max 等档位），提供按月计量的 Credits 额度，供 `mimo-v2.6-pro`、`mimo-v2.6-flash` 等模型调用。

在 TokenTracker 体系中接入时，需要注意核心的技术特性与架构边界：

1. **推理 Key 与配额查询解耦**：
   - 订阅后生成的 API Key 格式为 `tp-xxxxxx`（区别于按量付费的 `sk-xxxxxx`），专用于模型推理（BaseURL 如 `https://token-plan-cn.xiaomimimo.com/v1`）。
   - **`tp-` Key 无法直接调用查询余额或限额的 API**（请求控制台接口会直接重定向至 401 登录页）。
2. **查询必须走控制台 Session**：
   - 实时配额与剩余额度托管在控制台接口 `https://platform.xiaomimimo.com/api/v1/tokenPlan/usage`。
   - 鉴权依赖小米账号的 Web 控制台 Session Cookie（`api-platform_serviceToken` 与 `userId`）。
   - 该机制与 TokenTracker 中 `OpenCode Go` 的 Cookie 抓取及 `Devin` 的 RPC 鉴权机制非常类似。

---

## 二、上游 API 契约与查询接口

### 1. 核心端点

- **URL**: `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage`
- **鉴权 Header**:
  ```http
  Cookie: api-platform_serviceToken=<SERVICE_TOKEN>; userId=<USER_ID>
  Accept: application/json
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
  ```

### 2. 响应数据结构（JSON）

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "planId": "tp_plan_2026_pro",
    "planName": "Token Plan Pro",
    "status": "ACTIVE",
    "totalCredits": 456000000,
    "usedCredits": 42150000,
    "remainingCredits": 413850000,
    "tokens": {
      "inputTokens": 28450000,
      "outputTokens": 5600000,
      "cachedTokens": 8100000
    },
    "currentPeriodStart": 1775001600,
    "currentPeriodEnd": 1777593600,
    "resetAt": "2026-05-01T00:00:00Z"
  }
}
```

### 3. 状态码与异常行为

| 状态 | 含义 | TokenTracker 应对行为 |
|---|---|---|
| `code: 0` (200) | 成功获取当前额度 | 组装数据，写入磁盘缓存，清空错误 |
| HTTP 401 | Cookie 缺失或过期 | 标记 `auth_error: true`，透出 `auth_action_required: "reauth"`，**绝不被过期缓存遮掩** |
| HTTP 403 | 账号未开通 Token Plan | 标记 `subscription_status: "inactive"` 或未订阅提示 |
| 网络超时 / 5xx | 瞬时网络故障 | 标 `stale: true` 回落磁盘缓存，避免面板爆红闪烁 |

---

## 三、按照 TokenTracker 规范接入（4 个核心触点）

依据 `docs/usage-module-analysis.zh-CN.md` 总结的模式，接入需修改 4 个核心触点：

### 触点 ①：新建 `src/lib/xiaomi-token-plan-limits.js`（抓取与归一化）

该文件负责读取本地环境变量、发起请求、将数据归一化为 TokenTracker 统一的 `{ used_percent, reset_at }` 契约：

```js
// src/lib/xiaomi-token-plan-limits.js
const USAGE_API_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
const DEFAULT_TIMEOUT_MS = 10_000;

function readConfig(env = process.env) {
  const cookie = env.XIAOMI_TOKEN_PLAN_COOKIE?.trim();
  const serviceToken = env.XIAOMI_SERVICE_TOKEN?.trim();
  const userId = env.XIAOMI_USER_ID?.trim();

  if (cookie) return { cookieHeader: cookie };
  if (serviceToken && userId) {
    return { cookieHeader: `api-platform_serviceToken=${serviceToken}; userId=${userId}` };
  }
  return null;
}

function clampPercent(used, total) {
  if (!total || total <= 0) return 0;
  const pct = (used / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

async function fetchXiaomiTokenPlanLimits({ env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = readConfig(env);
  if (!cfg) return { configured: false };

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetchImpl(USAGE_API_URL, {
      method: "GET",
      headers: {
        Cookie: cfg.cookieHeader,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    return { configured: true, error: err?.message || "Network error" };
  }

  if (response.status === 401) {
    return {
      configured: true,
      auth_error: true,
      auth_action_required: "reauth",
      error: "Xiaomi Token Plan session expired — update XIAOMI_TOKEN_PLAN_COOKIE.",
    };
  }
  if (response.status === 403) {
    return { configured: true, subscription_status: "inactive", error: "No active Xiaomi Token Plan subscription." };
  }
  if (!response.ok) {
    return { configured: true, error: `Xiaomi Token Plan API error ${response.status}` };
  }

  const payload = await response.json().catch(() => null);
  if (payload?.code !== 0 || !payload?.data) {
    return { configured: true, error: payload?.message || "Invalid response format" };
  }

  const d = payload.data;
  const total = Number(d.totalCredits || 0);
  const used = Number(d.usedCredits || 0);
  const remaining = Number(d.remainingCredits || (total - used));

  // 格式化重置时间
  const resetAt = d.resetAt
    || (d.currentPeriodEnd ? new Date(d.currentPeriodEnd * 1000).toISOString() : null);

  return {
    configured: true,
    error: null,
    source: "api",
    subscription_status: (d.status || "ACTIVE").toLowerCase(),
    plan_label: d.planName || "Token Plan",
    primary_window: {
      used_percent: clampPercent(used, total),
      reset_at: resetAt,
    },
    // 额度明细供前端额外展示
    credit_window: {
      total_credits: total,
      used_credits: used,
      remaining_credits: remaining,
    },
  };
}

module.exports = {
  fetchXiaomiTokenPlanLimits,
  readConfig,
  clampPercent,
};
```

---

### 触点 ②：挂入 `src/lib/usage-limits.js`（并发编排与缓存兜底）

在全局拉取与装配流程中引入该模块：

1. **并发拉取**（在 `fetchUsageLimitsUncached` 的 `Promise.all` 中挂一槽）：
   ```js
   const { fetchXiaomiTokenPlanLimits } = require("./xiaomi-token-plan-limits");

   // ...在 Promise.all 数组里
   withProviderTimeout(
     fetchXiaomiTokenPlanLimits({ env, fetchImpl: providerFetch }),
     "Xiaomi Token Plan",
     providerTimeoutMs
   ).catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
   ```

2. **组装与缓存策略**（参考 OpenCode Go 的防丢弃与防隐藏逻辑）：
   ```js
   let xiaomiTokenPlan;
   if (xiaomiRaw?.configured === false) {
     xiaomiTokenPlan = xiaomiRaw;
   } else if (xiaomiRaw?.auth_error) {
     // 认证失效绝不用旧缓存遮掩
     xiaomiTokenPlan = xiaomiRaw;
   } else if (xiaomiRaw && !xiaomiRaw.error && xiaomiRaw.primary_window) {
     xiaomiTokenPlan = {
       ...xiaomiRaw,
       stale: false,
       cached_at: new Date(nowMs).toISOString(),
     };
     writeXiaomiTokenPlanLimitsCache(xiaomiTokenPlan, { home, nowMs });
   } else {
     // 瞬时错误回退磁盘缓存
     const cached = readXiaomiTokenPlanLimitsCache({ home, nowMs });
     xiaomiTokenPlan = cached || xiaomiRaw || { configured: true, error: "Unknown error" };
   }

   // 挂入返回对象
   data.xiaomiTokenPlan = withPlanLabel(xiaomiTokenPlan, xiaomiTokenPlan?.plan_label, "Xiaomi Token Plan");
   ```

3. **数据追溯性**：系统循环会根据 `source: "api"` 自动挂载 `provenance: { source: "api", confidence: "official", ... }`。

---

### 触点 ③：`dashboard/.../usage-limits-provider-specs.js`（声明渲染窗口）

```js
// dashboard/src/ui/dashboard/components/usage-limits-provider-specs.js
export const PROVIDER_LIMIT_SPECS = {
  // ...其它 provider
  xiaomiTokenPlan: {
    windows(data) {
      return [
        {
          key: "monthly",
          labelKey: "limits.label.xiaomi_token_plan_credits",
          window: data.primary_window,
          windowSeconds: 30 * 86400, // 30天周期，支持 pace 预测消耗速率
        },
      ];
    },
  },
};
```

---

### 触点 ④：前端注册、文案与类型定义

1. **注册 Provider 与图标** (`dashboard/src/lib/limits-providers.js`)：
   ```js
   export const LIMIT_PROVIDER_IDS = [
     // ...
     "xiaomiTokenPlan",
   ];

   export const PROVIDER_ICON_MAP = {
     // 复用项目中已有的 MIMO 品牌图标 (/brand-logos/mimo.svg)
     xiaomiTokenPlan: "MIMO",
   };
   ```

2. **添加文案** (`dashboard/src/content/copy.csv`)：
   ```csv
   limits.label.xiaomi_token_plan_credits,ui,LimitsPage,UsageLimitsPanel,xiaomi_token_plan_credits,"Plan Credits",,active
   ```
   *(严禁在 JSX 中直接写死字符串，否则会被 `npm run validate:ui-hardcode` 校验拦截)*。

3. **TypeScript 接口更新** (`dashboard/src/hooks/use-usage-limits.ts`)：
   在 `UsageLimitsData` 接口中为 `xiaomiTokenPlan` 添加类型定义：
   ```ts
   xiaomiTokenPlan?: {
     configured: boolean;
     error?: string | null;
     plan_label?: string | null;
     auth_action_required?: string | null;
     primary_window?: { used_percent: number; reset_at?: string | null };
     credit_window?: { total_credits: number; used_credits: number; remaining_credits: number };
   };
   ```

4. **配置模板** (`.env.example`)：
   ```dotenv
   # Xiaomi MiMo Token Plan
   # Cookie from https://platform.xiaomimimo.com
   XIAOMI_TOKEN_PLAN_COOKIE=
   ```

---

## 四、如何查询对应的余额？

### 方式 1：终端直连验证（快速测试 Cookie 是否有效）

直接在命令行发送带 Cookie 的请求：

```bash
curl -sS "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage" \
  -H "Cookie: $XIAOMI_TOKEN_PLAN_COOKIE" \
  -H "Accept: application/json" | jq .
```

### 方式 2：通过 TokenTracker 本地 API 查询（带缓存、防抖与 Provenance）

启动服务并查询统一端点：

```bash
# 启动本地服务
node bin/tracker.js serve

# 1. 常规查询（受 2 分钟内存缓存保护）
curl -s localhost:7680/functions/tokentracker-usage-limits | jq .xiaomiTokenPlan

# 2. 强制刷新（穿透磁盘缓存打上游）
curl -s "localhost:7680/functions/tokentracker-usage-limits?refresh=1" | jq .xiaomiTokenPlan
```

提取**余额与重置时间**的可读输出：

```bash
curl -s "localhost:7680/functions/tokentracker-usage-limits?refresh=1" \
| jq -r '
  .xiaomiTokenPlan as $x |
  "套餐: \($x.plan_label // "Xiaomi Token Plan")  状态: \($x.subscription_status)",
  (if $x.error then "异常: \($x.error)" else empty end),
  "使用比例: \($x.primary_window.used_percent)%  剩余比例: \(100 - $x.primary_window.used_percent)%",
  "重置时间: \($x.primary_window.reset_at)",
  (if $x.credit_window then "剩余额度: \($x.credit_window.remaining_credits) / \($x.credit_window.total_credits) Credits" else empty end)
'
```

### 方式 3：前端 Dashboard 面板展示

启动仪表盘或打开桌面版：
- 访问 `http://localhost:5173/limits`（开发环境）或 `http://localhost:7680/limits`。
- 在页面中会渲染一个带有 **MIMO**（小米橙色）Logo 的分组。
- 展示一根 **Plan Credits** 进度条，右上角支持切换 **Used**（已消耗）或 **Remaining**（剩余额度）。
- 如果配置了 `windowSeconds`，当消耗速度过快时，右侧会自动根据 `limit-pace.js` 预测何时用完并给出预警。

---

## 五、接入后的测试与发布清单

1. **编写单元测试**：
   - 新增 `test/xiaomi-token-plan-limits.test.js`：覆盖 Cookie 解析、百分比计算、401/403 错误分支、上游异常回落。
2. **本地全量 CI 校验**：
   ```bash
   node --test test/xiaomi-token-plan-limits.test.js
   npm run validate:copy          # 校验 copy.csv 一致性
   npm run validate:ui-hardcode   # 校验无前端硬编码字符串
   npm run ci:local               # 全量测试与构建
   ```
3. **版本发布提醒**：
   因为改动涉及 `src/` 和 `dashboard/`，依照 `CLAUDE.md` 规则，需要执行：
   `npm run sync-versions` 并在 GitHub Actions 触发全平台发布，保证 macOS (`TokenTrackerBar`)、Windows (`TokenTrackerWin`)、Linux 的内嵌包同步更新。
