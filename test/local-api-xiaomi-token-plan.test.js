const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-xiaomi-"));
const queuePath = path.join(sandbox, "tracker", "queue.jsonl");
const { createLocalApiHandler } = require("../src/lib/local-api");
const { resolveXiaomiAuthPath } = require("../src/lib/xiaomi-token-plan-limits");

function request({ method = "GET", pathname, headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}`);
  const listeners = {};
  const req = {
    method,
    headers: { host: "localhost", ...headers },
    on(event, listener) {
      listeners[event] = listener;
      return req;
    },
  };
  process.nextTick(() => {
    if (body != null) listeners.data?.(Buffer.from(JSON.stringify(body)));
    listeners.end?.();
  });
  return { req, url };
}

function response() {
  let status = 200;
  let body = "";
  return {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      if (chunk) body += chunk;
    },
    get result() {
      return { status, body: body ? JSON.parse(body) : null };
    },
  };
}

async function call(handler, options) {
  const { req, url } = request(options);
  const res = response();
  assert.equal(await handler(req, res, url), true);
  return res.result;
}

describe("local xiaomi-token-plan-config API", () => {
  let handler;
  let token;
  const trackerDir = path.dirname(queuePath);
  const authPath = resolveXiaomiAuthPath({ trackerDir });

  before(async () => {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    handler = createLocalApiHandler({ queuePath });
    const authRes = await call(handler, { pathname: "/api/local-auth" });
    token = authRes.body.token;
  });

  after(() => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch (_e) {}
  });

  it("reports configured: false when no auth file exists", async () => {
    const res = await call(handler, {
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.maskedCookie, null);
  });

  it("rejects unauthorized mutation requests with 401", async () => {
    const res = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
      body: { action: "save", cookie: "test-cookie" },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
  });

  it("saves cookie with local authorization token and updates status", async () => {
    const cookie = "api-platform_serviceToken=test_secret_token_12345; userId=10086";
    const saveRes = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
      headers: { "x-tokentracker-local-auth": token },
      body: { action: "save", cookie },
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.ok, true);
    assert.equal(saveRes.body.configured, true);

    // Verify file on disk
    assert.ok(fs.existsSync(authPath));
    const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(saved.cookie, cookie);
    assert.ok(saved.updatedAt);

    // Verify GET reports configured with masked preview
    const getRes = await call(handler, {
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.configured, true);
    assert.ok(getRes.body.maskedCookie.includes("..."));
    assert.equal(getRes.body.maskedCookie.startsWith("api-platfo"), true);
  });

  it("clears saved cookie with local authorization", async () => {
    const clearRes = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
      headers: { "x-tokentracker-local-auth": token },
      body: { action: "clear" },
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.body.ok, true);
    assert.equal(clearRes.body.configured, false);
    assert.equal(fs.existsSync(authPath), false);

    const getRes = await call(handler, {
      pathname: "/functions/tokentracker-xiaomi-token-plan-config",
    });
    assert.equal(getRes.body.configured, false);
  });
});
