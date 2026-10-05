const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  fetchXiaomiTokenPlanLimits,
  readConfig,
  clampPercent,
  readXiaomiTokenPlanLimitsCache,
  writeXiaomiTokenPlanLimitsCache,
  resolveXiaomiLimitsCachePath,
} = require("../src/lib/xiaomi-token-plan-limits");
const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("../src/lib/usage-limits");

function makeTempHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-xiaomi-test-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  return {
    home: tmp,
    trackerDir,
    cleanup() {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (_e) {}
    },
  };
}

describe("xiaomi-token-plan-limits", () => {
  let envBackup;

  beforeEach(() => {
    envBackup = { ...process.env };
    delete process.env.XIAOMI_TOKEN_PLAN_COOKIE;
    delete process.env.XIAOMI_SERVICE_TOKEN;
    delete process.env.XIAOMI_USER_ID;
    resetUsageLimitsCache();
  });

  afterEach(() => {
    process.env = envBackup;
    resetUsageLimitsCache();
  });

  describe("clampPercent", () => {
    it("handles zero, fraction, and maximum values correctly", () => {
      assert.equal(clampPercent(0, 1000), 0);
      assert.equal(clampPercent(500, 1000), 50);
      assert.equal(clampPercent(1200, 1000), 100);
      assert.equal(clampPercent(42150000, 456000000), 9.2);
    });

    it("returns 0 for negative, non-finite, or zero total", () => {
      assert.equal(clampPercent(0, 0), 0);
      assert.equal(clampPercent(10, -5), 0);
      assert.equal(clampPercent(null, 100), null);
    });
  });

  describe("readConfig", () => {
    it("returns null when no env or file exists", () => {
      const { home, cleanup } = makeTempHome();
      try {
        assert.equal(readConfig({ env: {}, home }), null);
      } finally {
        cleanup();
      }
    });

    it("prefers XIAOMI_TOKEN_PLAN_COOKIE when provided", () => {
      const cfg = readConfig({
        env: { XIAOMI_TOKEN_PLAN_COOKIE: "api-platform_serviceToken=st123; userId=u456" },
      });
      assert.deepEqual(cfg, { cookieHeader: "api-platform_serviceToken=st123; userId=u456" });
    });

    it("constructs cookie from XIAOMI_SERVICE_TOKEN and XIAOMI_USER_ID", () => {
      const cfg = readConfig({
        env: { XIAOMI_SERVICE_TOKEN: "st-abc", XIAOMI_USER_ID: "10086" },
      });
      assert.deepEqual(cfg, { cookieHeader: "api-platform_serviceToken=st-abc; userId=10086" });
    });

    it("reads auth JSON file from home when env is absent", () => {
      const { home, trackerDir, cleanup } = makeTempHome();
      try {
        fs.writeFileSync(
          path.join(trackerDir, "xiaomi-token-plan-auth.json"),
          JSON.stringify({ cookie: "api-platform_serviceToken=file_st; userId=file_uid" }),
        );
        const cfg = readConfig({ env: {}, home });
        assert.deepEqual(cfg, { cookieHeader: "api-platform_serviceToken=file_st; userId=file_uid" });
      } finally {
        cleanup();
      }
    });
  });

  describe("fetchXiaomiTokenPlanLimits", () => {
    it("returns configured: false when no configuration is found", async () => {
      const { home, cleanup } = makeTempHome();
      try {
        const res = await fetchXiaomiTokenPlanLimits({ env: {}, home });
        assert.deepEqual(res, { configured: false });
      } finally {
        cleanup();
      }
    });

    it("parses successful response and normalizes windows and credits", async () => {
      const { home, cleanup } = makeTempHome();
      const mockPayload = {
        code: 0,
        message: "success",
        data: {
          planId: "tp_plan_2026_pro",
          planName: "Token Plan Pro",
          status: "ACTIVE",
          totalCredits: 456000000,
          usedCredits: 42150000,
          remainingCredits: 413850000,
          tokens: {
            inputTokens: 28450000,
            outputTokens: 5600000,
            cachedTokens: 8100000,
          },
          currentPeriodStart: 1775001600,
          currentPeriodEnd: 4102444800,
          resetAt: "2099-05-01T00:00:00Z",
        },
      };

      const fetchImpl = async (url, init) => {
        assert.match(init.headers.Cookie, /api-platform_serviceToken=test/);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(mockPayload);
          },
        };
      };

      try {
        const res = await fetchXiaomiTokenPlanLimits({
          home,
          env: { XIAOMI_TOKEN_PLAN_COOKIE: "api-platform_serviceToken=test; userId=123" },
          fetchImpl,
        });

        assert.equal(res.configured, true);
        assert.equal(res.error, null);
        assert.equal(res.source, "api");
        assert.equal(res.subscription_status, "active");
        assert.equal(res.plan_label, "Token Plan Pro");
        assert.equal(res.primary_window.used_percent, 9.2);
        assert.equal(res.primary_window.reset_at, "2099-05-01T00:00:00.000Z");
        assert.deepEqual(res.credit_window, {
          total_credits: 456000000,
          used_credits: 42150000,
          remaining_credits: 413850000,
        });
        assert.deepEqual(res.tokens, mockPayload.data.tokens);

        // Verify disk cache was written
        const cached = readXiaomiTokenPlanLimitsCache({ home });
        assert.ok(cached);
        assert.equal(cached.primary_window.used_percent, 9.2);
      } finally {
        cleanup();
      }
    });

    it("parses real Xiaomi nested usage and detail responses", async () => {
      const { home, cleanup } = makeTempHome();
      const usagePayload = {
        code: 0,
        message: "",
        data: {
          monthUsage: {
            percent: 0.2373,
            items: [{ name: "month_total_token", used: 11673115824, limit: 49200000000, percent: 0.2373 }],
          },
          usage: {
            percent: 0.24,
            items: [
              { name: "plan_total_token", used: 11673115824, limit: 49200000000, percent: 0.24 },
              { name: "compensation_total_token", used: 0, limit: 0, percent: 0 },
            ],
          },
        },
      };

      const detailPayload = {
        code: 0,
        message: "",
        data: {
          planCode: "lite:year",
          planName: "Lite",
          currentPeriodEnd: "2027-08-19 23:59:59",
          expired: false,
        },
      };

      const fetchImpl = async (url) => {
        if (url.includes("detail")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return detailPayload;
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(usagePayload);
          },
        };
      };

      try {
        const res = await fetchXiaomiTokenPlanLimits({
          home,
          env: { XIAOMI_TOKEN_PLAN_COOKIE: "xiaomichatbot_serviceToken=real_token" },
          fetchImpl,
        });

        assert.equal(res.configured, true);
        assert.equal(res.error, null);
        assert.equal(res.plan_label, "Lite");
        assert.equal(res.subscription_status, "active");
        assert.equal(res.primary_window.used_percent, 24);
        assert.equal(res.primary_window.reset_at, "2027-08-19T15:59:59.000Z");
        assert.deepEqual(res.credit_window, {
          total_credits: 49200000000,
          used_credits: 11673115824,
          remaining_credits: 37526884176,
        });
      } finally {
        cleanup();
      }
    });

    it("surfaces 401 as re-auth action required without falling back to stale cache", async () => {
      const { home, cleanup } = makeTempHome();
      // Pre-seed disk cache
      writeXiaomiTokenPlanLimitsCache(
        {
          configured: true,
          source: "api",
          plan_label: "Cached Plan",
          primary_window: { used_percent: 10, reset_at: "2099-01-01T00:00:00Z" },
        },
        { home },
      );

      const fetchImpl = async () => ({
        ok: false,
        status: 401,
        async text() {
          return "Unauthorized";
        },
      });

      try {
        const res = await fetchXiaomiTokenPlanLimits({
          home,
          env: { XIAOMI_TOKEN_PLAN_COOKIE: "expired" },
          fetchImpl,
        });

        assert.equal(res.configured, true);
        assert.equal(res.auth_error, true);
        assert.equal(res.auth_action_required, "reauth");
        assert.match(res.error, /session expired/i);
      } finally {
        cleanup();
      }
    });

    it("surfaces 403 as inactive subscription", async () => {
      const { home, cleanup } = makeTempHome();
      const fetchImpl = async () => ({
        ok: false,
        status: 403,
        async text() {
          return "Forbidden";
        },
      });

      try {
        const res = await fetchXiaomiTokenPlanLimits({
          home,
          env: { XIAOMI_TOKEN_PLAN_COOKIE: "no_sub" },
          fetchImpl,
        });

        assert.equal(res.configured, true);
        assert.equal(res.subscription_status, "inactive");
      } finally {
        cleanup();
      }
    });

    it("falls back to disk cache on network failure", async () => {
      const { home, cleanup } = makeTempHome();
      writeXiaomiTokenPlanLimitsCache(
        {
          configured: true,
          source: "api",
          plan_label: "Cached Plan",
          primary_window: { used_percent: 25, reset_at: "2099-01-01T00:00:00Z" },
        },
        { home },
      );

      const fetchImpl = async () => {
        throw new Error("ETIMEDOUT");
      };

      try {
        const res = await fetchXiaomiTokenPlanLimits({
          home,
          env: { XIAOMI_TOKEN_PLAN_COOKIE: "valid_cookie" },
          fetchImpl,
        });

        assert.equal(res.configured, true);
        assert.equal(res.stale, true);
        assert.equal(res.source, "disk-cache");
        assert.equal(res.primary_window.used_percent, 25);
      } finally {
        cleanup();
      }
    });
  });

  describe("getUsageLimits integration", () => {
    it("includes xiaomiTokenPlan in aggregated result with provenance", async () => {
      const { home, cleanup } = makeTempHome();
      const mockPayload = {
        code: 0,
        message: "success",
        data: {
          planName: "Token Plan Standard",
          status: "ACTIVE",
          totalCredits: 132000000,
          usedCredits: 13200000,
          remainingCredits: 118800000,
          resetAt: "2099-01-01T00:00:00Z",
        },
      };

      const customFetch = async (url, init) => {
        if (typeof url === "string" && url.includes("platform.xiaomimimo.com")) {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify(mockPayload);
            },
          };
        }
        return {
          ok: false,
          status: 404,
          async text() {
            return "{}";
          },
          async json() {
            return {};
          },
        };
      };

      try {
        const data = await getUsageLimits({
          home,
          env: {
            ...process.env,
            XIAOMI_TOKEN_PLAN_COOKIE: "api-platform_serviceToken=st; userId=123",
          },
          fetchImpl: customFetch,
        });

        assert.ok(data.xiaomiTokenPlan);
        assert.equal(data.xiaomiTokenPlan.configured, true);
        assert.equal(data.xiaomiTokenPlan.plan_label, "Token Plan Standard");
        assert.equal(data.xiaomiTokenPlan.primary_window.used_percent, 10);
        assert.equal(data.xiaomiTokenPlan.provenance.source, "api");
        assert.equal(data.xiaomiTokenPlan.provenance.confidence, "official");
      } finally {
        cleanup();
      }
    });
  });
});
