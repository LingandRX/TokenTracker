const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Xiaomi MiMo Token Plan usage limits.
//
// Endpoints:
//   GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
//   GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail
//
// Authenticated via console session Cookie:
//   Cookie: api-platform_serviceToken=...; userId=...
//   (also accepts xiaomichatbot_serviceToken or raw cookie header via XIAOMI_TOKEN_PLAN_COOKIE)
//
// The usage endpoint returns token quotas:
//   data.usage: { percent, items: [{ name: "plan_total_token", used, limit, percent }] }
//   data.monthUsage: { percent, items: [{ name: "month_total_token", used, limit, percent }] }
//
// The detail endpoint returns tier metadata:
//   data.planName: "Lite", data.currentPeriodEnd: "2027-08-19 23:59:59", data.expired: false

const DEFAULT_USAGE_API_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
const DEFAULT_DETAIL_API_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail";
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const XIAOMI_LIMITS_CACHE_FILE = "xiaomi-token-plan-limits-cache.json";
const XIAOMI_LIMITS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function resolveXiaomiLimitsCachePath({ home = os.homedir() } = {}) {
  return path.join(home || os.homedir(), ".tokentracker", "tracker", XIAOMI_LIMITS_CACHE_FILE);
}

function resolveXiaomiAuthPath({ home = os.homedir(), trackerDir } = {}) {
  if (trackerDir) {
    const dir = path.basename(trackerDir) === "tracker" ? trackerDir : path.join(trackerDir, "tracker");
    return path.join(dir, "xiaomi-token-plan-auth.json");
  }
  return path.join(home || os.homedir(), ".tokentracker", "tracker", "xiaomi-token-plan-auth.json");
}

function readConfig({ env = process.env, home = os.homedir() } = {}) {
  if (env && typeof env === "object") {
    const rawCookie = typeof env.XIAOMI_TOKEN_PLAN_COOKIE === "string" ? env.XIAOMI_TOKEN_PLAN_COOKIE.trim() : "";
    if (rawCookie) return { cookieHeader: rawCookie };

    const serviceToken = typeof env.XIAOMI_SERVICE_TOKEN === "string" ? env.XIAOMI_SERVICE_TOKEN.trim() : "";
    const userId = typeof env.XIAOMI_USER_ID === "string" ? env.XIAOMI_USER_ID.trim() : "";
    if (serviceToken && userId) {
      return { cookieHeader: `api-platform_serviceToken=${serviceToken}; userId=${userId}` };
    }
  }

  const authPath = resolveXiaomiAuthPath({ home });
  try {
    if (fs.existsSync(authPath)) {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (typeof parsed?.cookie === "string" && parsed.cookie.trim()) {
        return { cookieHeader: parsed.cookie.trim() };
      }
      if (parsed?.serviceToken && parsed?.userId) {
        return {
          cookieHeader: `api-platform_serviceToken=${String(parsed.serviceToken).trim()}; userId=${String(parsed.userId).trim()}`,
        };
      }
    }
  } catch (_e) {}

  return null;
}

function clampPercent(used, total) {
  if (used == null) return null;
  // Direct percentage value (e.g. clampPercent(24))
  if (total == null) {
    let p = Number(used);
    if (!Number.isFinite(p)) return 0;
    if (p > 0 && p <= 1) p *= 100;
    return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
  }
  const u = Number(used);
  const t = Number(total);
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return 0;
  const pct = (u / t) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

function normalizeDateTimeToIso(val) {
  if (!val) return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    const ts = val > 1e11 ? val : val * 1000;
    return new Date(ts).toISOString();
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (trimmed.includes("T") || trimmed.endsWith("Z")) {
      const d = new Date(trimmed);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    // Xiaomi Beijing time string: "2027-08-19 23:59:59"
    const beijingStr = trimmed.replace(" ", "T") + "+08:00";
    const d = new Date(beijingStr);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

function isCachedWindowUsable(window, { nowMs = Date.now() } = {}) {
  if (!window || typeof window !== "object") return false;
  const resetAtMs = Date.parse(window.reset_at || "");
  if (Number.isFinite(resetAtMs)) return resetAtMs > nowMs;
  return true;
}

function readXiaomiTokenPlanLimitsCache({
  home = os.homedir(),
  nowMs = Date.now(),
} = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(resolveXiaomiLimitsCachePath({ home }), "utf8"))?.xiaomiTokenPlan;
    const cachedAtMs = Date.parse(raw?.cached_at || "");
    if (!Number.isFinite(cachedAtMs) || cachedAtMs > nowMs + 60_000) return null;
    if (nowMs - cachedAtMs > XIAOMI_LIMITS_CACHE_MAX_AGE_MS) return null;
    if (!isCachedWindowUsable(raw?.primary_window, { nowMs })) return null;

    return {
      configured: true,
      error: null,
      source: "disk-cache",
      subscription_status: typeof raw?.subscription_status === "string" ? raw.subscription_status : "active",
      plan_label: typeof raw?.plan_label === "string" ? raw.plan_label : null,
      primary_window: raw.primary_window || null,
      credit_window: raw.credit_window || null,
      tokens: raw.tokens || null,
      cached: true,
      stale: true,
      cached_at: raw.cached_at,
    };
  } catch (_error) {
    return null;
  }
}

function writeXiaomiTokenPlanLimitsCache(limits, {
  home = os.homedir(),
  nowMs = Date.now(),
} = {}) {
  if (!limits?.configured || limits.error || !limits.primary_window) return;
  const cachePath = resolveXiaomiLimitsCachePath({ home });
  const payload = {
    xiaomiTokenPlan: {
      source: limits.source || "api",
      subscription_status: limits.subscription_status || null,
      plan_label: limits.plan_label || null,
      primary_window: limits.primary_window || null,
      credit_window: limits.credit_window || null,
      tokens: limits.tokens || null,
      cached_at: new Date(nowMs).toISOString(),
    },
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

async function fetchXiaomiTokenPlanLimits({
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  url = DEFAULT_USAGE_API_URL,
  detailUrl = DEFAULT_DETAIL_API_URL,
} = {}) {
  const cfg = readConfig({ env, home });
  if (!cfg) return { configured: false };

  const targetUsageUrl = (env && env.XIAOMI_TOKEN_PLAN_USAGE_URL) || url;
  const targetDetailUrl = (env && env.XIAOMI_TOKEN_PLAN_DETAIL_URL) || detailUrl;

  const reqHeaders = {
    Cookie: cfg.cookieHeader,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };

  let usageResponse;
  let detailResponse = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const [uRes, dRes] = await Promise.all([
      fetchImpl(targetUsageUrl, {
        method: "GET",
        headers: reqHeaders,
        signal: controller.signal,
      }),
      fetchImpl(targetDetailUrl, {
        method: "GET",
        headers: reqHeaders,
        signal: controller.signal,
      }).catch(() => null),
    ]).finally(() => clearTimeout(timer));

    usageResponse = uRes;
    detailResponse = dRes;
  } catch (err) {
    const cached = readXiaomiTokenPlanLimitsCache({ home, nowMs });
    if (cached) return cached;
    return { configured: true, error: err?.message || "Network error" };
  }

  if (usageResponse.status === 401) {
    return {
      configured: true,
      auth_error: true,
      auth_action_required: "reauth",
      error: "Xiaomi Token Plan session expired — update XIAOMI_TOKEN_PLAN_COOKIE.",
    };
  }

  if (usageResponse.status === 403) {
    return {
      configured: true,
      subscription_status: "inactive",
      error: "No active Xiaomi Token Plan subscription for this account.",
    };
  }

  if (!usageResponse.ok) {
    const cached = readXiaomiTokenPlanLimitsCache({ home, nowMs });
    if (cached) return cached;
    return { configured: true, error: `Xiaomi Token Plan API error ${usageResponse.status}` };
  }

  let usagePayload;
  try {
    const text = await usageResponse.text();
    usagePayload = JSON.parse(text);
  } catch (err) {
    const cached = readXiaomiTokenPlanLimitsCache({ home, nowMs });
    if (cached) return cached;
    return { configured: true, error: `Could not parse Xiaomi Token Plan response: ${err?.message || err}` };
  }

  if (usagePayload?.code !== 0 || !usagePayload?.data) {
    const cached = readXiaomiTokenPlanLimitsCache({ home, nowMs });
    if (cached) return cached;
    return { configured: true, error: usagePayload?.message || "Xiaomi Token Plan returned error" };
  }

  let detailPayload = null;
  if (detailResponse && detailResponse.ok) {
    try {
      detailPayload = await detailResponse.json();
    } catch (_e) {}
  }

  const uData = usagePayload.data || {};
  const dData = detailPayload?.data || {};

  // Extract items from real Xiaomi nested format:
  //   uData.usage.items: [{ name: "plan_total_token", used, limit, percent }]
  //   uData.monthUsage.items: [{ name: "month_total_token", used, limit, percent }]
  const items = [
    ...(Array.isArray(uData.usage?.items) ? uData.usage.items : []),
    ...(Array.isArray(uData.monthUsage?.items) ? uData.monthUsage.items : []),
  ];

  const planItem = items.find((i) => i.name === "plan_total_token") || items[0] || null;

  // Total credits and used tokens
  let total = 0;
  let used = 0;
  let percentVal = null;

  if (planItem) {
    total = Number(planItem.limit || 0);
    used = Number(planItem.used || 0);
    percentVal = planItem.percent;
  } else if (uData.totalCredits != null || uData.usedCredits != null) {
    // Compatibility with flat mock payload
    total = Number(uData.totalCredits || 0);
    used = Number(uData.usedCredits || 0);
  }

  if (percentVal == null && uData.usage?.percent != null) {
    percentVal = uData.usage.percent;
  }

  const remaining = Number(uData.remainingCredits ?? Math.max(0, total - used));
  const usedPercent = percentVal != null ? clampPercent(percentVal) : clampPercent(used, total);

  // Expiration / reset date
  const rawReset = dData.currentPeriodEnd || uData.resetAt || uData.currentPeriodEnd;
  const resetAtIso = normalizeDateTimeToIso(rawReset);

  // Plan name
  const planLabel = dData.planName || uData.planName || "Token Plan";
  const isExpired = dData.expired === true;
  const statusStr = isExpired
    ? "expired"
    : typeof uData.status === "string"
      ? uData.status.toLowerCase()
      : "active";

  const result = {
    configured: true,
    error: null,
    source: "api",
    subscription_status: statusStr,
    plan_label: planLabel,
    primary_window: {
      used_percent: usedPercent ?? 0,
      reset_at: resetAtIso,
    },
    credit_window: {
      total_credits: total,
      used_credits: used,
      remaining_credits: remaining,
    },
    tokens: uData.tokens || null,
  };

  writeXiaomiTokenPlanLimitsCache(result, { home, nowMs });
  return result;
}

module.exports = {
  fetchXiaomiTokenPlanLimits,
  readConfig,
  clampPercent,
  normalizeDateTimeToIso,
  readXiaomiTokenPlanLimitsCache,
  writeXiaomiTokenPlanLimitsCache,
  resolveXiaomiLimitsCachePath,
  resolveXiaomiAuthPath,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USAGE_API_URL,
  DEFAULT_DETAIL_API_URL,
};
