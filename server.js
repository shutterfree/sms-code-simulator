const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8088;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "demo-admin"; // 本地运行示例口令
const HOST = process.env.HOST || "127.0.0.1";
const DEMO_MODE = process.env.DEMO_MODE !== "false"; // 默认完全模拟，不请求真实短信接口
const SMS_ENDPOINT_TEMPLATE = process.env.SMS_ENDPOINT_TEMPLATE || "";
const MOCK_ENABLED = DEMO_MODE || process.env.MOCK_ENABLED === "true"; // 测试用 mock 验证码接口，默认关闭
const dataFile = path.join(__dirname, "data.json");
const smsEndpointsFile = path.join(__dirname, "sms-endpoints.json");
const smsEndpoints = readSmsEndpoints();

const phones = ["+000000000001", "+000000000002", "+000000000003", "+000000000004", "+000000000005", "+000000000006"]; // 虚构号码，不能接收真实短信

function makeKeys() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    key: `DEMO-KEY-${String(i + 1).padStart(3, "0")}`,
    status: "ready",
    phone: "",
    code: "",
    createdAt: new Date().toISOString(),
    usedAt: ""
  }));
}

function initialData() {
  return {
    keys: makeKeys(),
    numbers: phones.map((phone, index) => ({ id: index + 1, phone, status: "ready", keyId: null, note: "" })),
    problems: [],
    sessions: {}
  };
}

function readData() {
  if (!fs.existsSync(dataFile)) {
    const fresh = initialData();
    fs.writeFileSync(dataFile, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(dataFile, "utf8"));
}

function writeData(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function readSmsEndpoints() {
  try {
    if (!fs.existsSync(smsEndpointsFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(smsEndpointsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("SMS endpoints load failed:", error.message);
    return {};
  }
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise(resolve => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function serveFile(req, res) {
  const urlPath = req.url === "/" ? "/user.html" : req.url.split("?")[0];
  const publicFiles = new Set(["/user.html", "/user.js", "/admin.html", "/admin.js"]);
  if (!publicFiles.has(urlPath) || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon"
  };
  const type = types[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(fs.readFileSync(filePath));
}

function cleanExpired(data) {
  const now = Date.now();
  let removed = 0;
  for (const [token, session] of Object.entries(data.sessions)) {
    // 超时的会话：释放被占用的密钥和号码，避免号池被永久锁死
    if (session.expiresAt < now && !session.code && !session.expired) {
      session.expired = true;
      const key = data.keys.find(k => k.id === session.keyId);
      if (key && key.status === "locked" && !key.code) {
        key.status = "ready";
        key.phone = "";
      }
      const number = data.numbers.find(n => n.phone === session.phone && n.status === "locked");
      if (number && number.keyId === session.keyId) {
        number.status = "ready";
        number.keyId = null;
        number.note = "";
      }
      delete data.sessions[token];
      removed++;
    }
  }
  return removed;
}

// —— 并发保护：data.json 的「读-改-写」统一经 withDataLock 串行执行，避免并发请求互相覆盖 ——
let dataLock = Promise.resolve();
function withDataLock(fn) {
  const run = dataLock.then(fn, fn);
  dataLock = run.catch(() => {});
  return run;
}

// —— /api/claim 限速：按客户端 IP，防止恶意刷取耗尽号码池 ——
const RATE_WINDOW_MS = (Number(process.env.RATE_WINDOW_SECONDS) || 60) * 1000;
const RATE_MAX = Number(process.env.RATE_MAX) || 10;
const rateBuckets = new Map();
function clientIp(req) {
  // 直连场景取远端地址；若经反向代理部署，可改为读取 x-forwarded-for（注意防伪造）
  return req.socket.remoteAddress || "unknown";
}
function checkClaimRate(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  // 防内存膨胀：条目过多时清理过期窗口
  if (rateBuckets.size > 5000) {
    for (const [key, b] of rateBuckets) {
      if (b.resetAt <= now) rateBuckets.delete(key);
    }
  }
  return bucket.count <= RATE_MAX;
}

function makeSmsUrl(phone) {
  const normalized = String(phone || "").trim();
  const withoutPlus = normalized.replace(/^\+/, "");
  const direct = smsEndpoints[normalized] || smsEndpoints[withoutPlus] || smsEndpoints[`+${withoutPlus}`];
  if (direct) return direct;
  if (!SMS_ENDPOINT_TEMPLATE) return "";
  return SMS_ENDPOINT_TEMPLATE.replace(/\{phone\}/g, encodeURIComponent(normalized));
}

function extractSmsCode(raw) {
  const text = String(raw || "").trim();
  if (!text || /^no\|/i.test(text)) return "";
  if (!/^yes\|/i.test(text)) return "";
  const body = text.split("|").slice(1).join("|");
  const match = body.match(/\b\d{4,8}\b/);
  return match ? match[0] : "";
}

function pickRandomReady(numbers) {
  const ready = numbers.filter(n => n.status === "ready");
  if (!ready.length) return null;
  return ready[Math.floor(Math.random() * ready.length)];
}

async function pollSmsCode(phone) {
  if (DEMO_MODE) return "123456"; // 仅演示，绝不发送外部查询请求
  const url = makeSmsUrl(phone);
  if (!url) return "";
  // 10 秒超时，避免某个接口卡住导致请求长时间挂起
  const response = await fetch(url, { headers: { "Accept": "text/plain" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) return "";
  const raw = await response.text();
  return extractSmsCode(raw);
}

async function handleApi(req, res) {
  if (req.method === "POST" && req.url === "/api/claim") {
    // 限速：防止恶意刷取耗尽号码池
    if (!checkClaimRate(clientIp(req))) {
      return send(res, 429, { error: "请求过于频繁，请稍后再试" });
    }
    const body = await parseBody(req);
    const claimedKey = String(body.key || "").trim();
    const result = await withDataLock(() => {
      const data = readData();
      cleanExpired(data);
      const key = data.keys.find(item => item.key === claimedKey);
      if (!key) return { status: 400, payload: { error: "密钥无效" } };
      // 已使用的密钥：提示无法再次使用，但回看绑定的号码和验证码
      if (key.status === "used") {
        return { status: 200, payload: { used: true, phone: key.phone, code: key.code || "", finished: true } };
      }
      if (key.status !== "ready") return { status: 400, payload: { error: "此密钥正在使用中，无法重复获取号码" } };
      const number = pickRandomReady(data.numbers);
      if (!number) return { status: 400, payload: { error: "暂无可用手机号" } };
      const token = crypto.randomBytes(16).toString("hex");
      key.status = "locked";
      key.phone = number.phone;
      number.status = "locked";
      number.keyId = key.id;
      data.sessions[token] = { keyId: key.id, phone: number.phone, code: "", expiresAt: Date.now() + 10 * 60 * 1000, expired: false, changeCount: 0 };
      writeData(data);
      return { status: 200, payload: { token, phone: number.phone, expiresAt: data.sessions[token].expiresAt } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "GET" && req.url.startsWith("/api/status")) {
    const token = new URL(req.url, "http://localhost").searchParams.get("token");
    // 锁内快照读取会话状态；网络轮询放在锁外，避免阻塞其他请求
    const snap = await withDataLock(() => {
      const data = readData();
      if (cleanExpired(data)) writeData(data);
      const s = data.sessions[token];
      if (!s) return null;
      return { phone: s.phone, code: s.code, expiresAt: s.expiresAt, expired: s.expired, keyId: s.keyId };
    });
    if (!snap) return send(res, 404, { error: "会话不存在" });

    if (!snap.code && !snap.expired) {
      let code = "";
      try {
        code = await pollSmsCode(snap.phone);
      } catch (error) {
        console.error("SMS lookup failed:", error.message);
      }
      if (code) {
        // 锁内写回验证码（并发轮询只会写一次）
        await withDataLock(() => {
          const data = readData();
          const s = data.sessions[token];
          if (s && !s.code) {
            s.code = code;
            const key = data.keys.find(item => item.id === s.keyId);
            if (key) key.code = code;
            writeData(data);
          }
        });
      }
    }

    // 最终读取：收到验证码 → 自动完成，无需用户手动点击
    const result = await withDataLock(() => {
      const data = readData();
      const s = data.sessions[token];
      if (!s) return { status: 404, payload: { error: "会话不存在" } };
      if (s.code) {
        const key = data.keys.find(item => item.id === s.keyId);
        const number = data.numbers.find(item => item.phone === s.phone);
        if (key) {
          key.status = "used";
          key.usedAt = new Date().toISOString();
        }
        if (number) number.status = "used";
        const phone = s.phone;
        const code = s.code;
        delete data.sessions[token];
        writeData(data);
        return { status: 200, payload: { phone, code, finished: true } };
      }
      return { status: 200, payload: { phone: s.phone, code: s.code, expiresAt: s.expiresAt, expired: s.expired } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/change-phone") {
    const body = await parseBody(req);
    const result = await withDataLock(() => {
      const data = readData();
      cleanExpired(data);
      const session = data.sessions[body.token];
      if (!session || session.code) return { status: 400, payload: { error: "当前状态不能换号" } };
      const changeCount = session.changeCount || 0;
      if (changeCount >= 3) return { status: 400, payload: { error: "更换次数已达上限（3次）" } };
      // 先确认有可用号码，再标记旧号码为 problem，避免换号失败还误伤旧号码
      const next = pickRandomReady(data.numbers);
      if (!next) return { status: 400, payload: { error: "暂无可替换手机号" } };
      const oldNumber = data.numbers.find(item => item.phone === session.phone);
      if (oldNumber) {
        oldNumber.status = "problem";
        oldNumber.note = "用户超时未收到验证码并换号";
        data.problems.unshift({ phone: oldNumber.phone, keyId: session.keyId, note: oldNumber.note, time: new Date().toISOString() });
      }
      next.status = "locked";
      next.keyId = session.keyId;
      session.phone = next.phone;
      session.code = "";
      session.expiresAt = Date.now() + 10 * 60 * 1000;
      session.expired = false;
      session.changeCount = changeCount + 1;
      const key = data.keys.find(item => item.id === session.keyId);
      if (key) key.phone = next.phone;
      writeData(data);
      return { status: 200, payload: { phone: session.phone, expiresAt: session.expiresAt } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/mock-code") {
    // 仅当显式设置 MOCK_ENABLED=true 时才开放，避免公网被利用伪造验证码
    if (!MOCK_ENABLED) return send(res, 404, { error: "接口不存在" });
    const body = await parseBody(req);
    const result = await withDataLock(() => {
      const data = readData();
      cleanExpired(data);
      const session = data.sessions[body.token];
      if (!session) return { status: 404, payload: { error: "会话不存在" } };
      session.code = String(Math.floor(100000 + Math.random() * 900000));
      const key = data.keys.find(item => item.id === session.keyId);
      if (key) key.code = session.code;
      writeData(data);
      return { status: 200, payload: { code: session.code } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/finish") {
    const body = await parseBody(req);
    const result = await withDataLock(() => {
      const data = readData();
      cleanExpired(data);
      const session = data.sessions[body.token];
      if (!session) return { status: 400, payload: { error: "会话已失效或已完成" } };
      if (!session.code) return { status: 400, payload: { error: "验证码未收到" } };
      const key = data.keys.find(item => item.id === session.keyId);
      const number = data.numbers.find(item => item.phone === session.phone);
      if (key) {
        key.status = "used";
        key.usedAt = new Date().toISOString();
      }
      if (number) number.status = "used";
      delete data.sessions[body.token];
      writeData(data);
      return { status: 200, payload: { ok: true } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/admin/recover") {
    const body = await parseBody(req);
    if (body.adminToken !== ADMIN_TOKEN) return send(res, 403, { error: "后台口令错误" });
    const result = await withDataLock(() => {
      const data = readData();
      cleanExpired(data);
      const number = data.numbers.find(n => n.phone === String(body.phone || "").trim() && n.status === "problem");
      if (!number) return { status: 404, payload: { error: "号码不存在或状态不是problem" } };
      // 检查关联密钥：如果密钥已使用，说明这个换号记录是真实的，不能恢复
      if (number.keyId) {
        const key = data.keys.find(k => k.id === number.keyId);
        if (key && key.status === "used") {
          return { status: 400, payload: { error: "该号码关联的密钥已使用，换号记录真实，无法恢复" } };
        }
        // 如果密钥是 locked 且无验证码 → 连带恢复密钥及其锁定号码
        if (key && key.status === "locked" && !key.code) {
          for (const [t, s] of Object.entries(data.sessions)) {
            if (s.keyId === key.id) delete data.sessions[t];
          }
          const lockedNumber = data.numbers.find(n => n.keyId === key.id && n.status === "locked");
          if (lockedNumber) {
            lockedNumber.status = "ready";
            lockedNumber.note = "";
            lockedNumber.keyId = null;
          }
          // 清理所有关联 problem 号码的 keyId，防止密钥被重新使用后误判
          data.numbers.forEach(n => {
            if (n.keyId === key.id && n.status === "problem") n.keyId = null;
          });
          key.status = "ready";
          key.phone = "";
        }
      }
      // 恢复号码
      number.status = "ready";
      number.note = "";
      number.keyId = null;
      // 从 problems 中删除
      data.problems = data.problems.filter(p => p.phone !== number.phone);
      writeData(data);
      return { status: 200, payload: { ok: true, recoveredPhone: number.phone } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/admin/add-numbers") {
    const body = await parseBody(req);
    if (body.adminToken !== ADMIN_TOKEN) return send(res, 403, { error: "后台口令错误" });
    const text = String(body.text || "").trim();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes("----"));
    const entries = [];
    for (const line of lines) {
      const [phone, url] = line.split("----").map(s => s.trim());
      if (!/^\+?\d{6,15}$/.test(phone)) continue;
      if (!/^https?:\/\/\S+$/.test(url)) continue;
      entries.push({ phone, url });
    }
    if (!entries.length) return send(res, 400, { error: "没有解析到有效的「号码----接口」行" });
    const result = await withDataLock(() => {
      const data = readData();
      let added = 0, updated = 0;
      for (const { phone, url } of entries) {
        smsEndpoints[phone] = url;
        const existing = data.numbers.find(n => n.phone === phone);
        if (existing) {
          updated++; // 已有该号码：仅更新接口映射，不改变其状态（不复活已用完的号码）
        } else {
          const maxId = data.numbers.reduce((m, n) => Math.max(m, n.id), 0);
          data.numbers.push({ id: maxId + 1, phone, status: "ready", keyId: null, note: "" });
          added++;
        }
      }
      // 持久化接口映射 + 号码数据
      fs.writeFileSync(smsEndpointsFile, JSON.stringify(smsEndpoints, null, 4) + "\n");
      writeData(data);
      return { status: 200, payload: { added, updated, total: data.numbers.length } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "POST" && req.url === "/api/admin/add-keys") {
    const body = await parseBody(req);
    if (body.adminToken !== ADMIN_TOKEN) return send(res, 403, { error: "后台口令错误" });
    const count = Math.min(200, Math.max(1, Number(body.count) || 10));
    const result = await withDataLock(() => {
      const data = readData();
      const maxId = data.keys.reduce((m, k) => Math.max(m, k.id), 0);
      const fresh = [];
      for (let i = 0; i < count; i++) {
        fresh.push({
          id: maxId + i + 1,
          key: `SMS-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
          status: "ready",
          phone: "",
          code: "",
          createdAt: new Date().toISOString(),
          usedAt: ""
        });
      }
      data.keys.push(...fresh);
      writeData(data);
      return { status: 200, payload: { added: fresh.length, total: data.keys.length, keys: fresh.map(k => k.key) } };
    });
    return send(res, result.status, result.payload);
  }

  if (req.method === "GET" && req.url.startsWith("/api/admin")) {
    const token = new URL(req.url, "http://localhost").searchParams.get("token");
    if (token !== ADMIN_TOKEN) return send(res, 403, { error: "后台口令错误" });
    const result = await withDataLock(() => {
      const data = readData();
      if (cleanExpired(data)) writeData(data);
      const summary = {
        keys: data.keys,
        numbers: data.numbers,
        problems: data.problems,
        totals: {
          readyKeys: data.keys.filter(k => k.status === "ready").length,
          usedKeys: data.keys.filter(k => k.status === "used").length,
          lockedKeys: data.keys.filter(k => k.status === "locked").length,
          readyNumbers: data.numbers.filter(n => n.status === "ready").length,
          problemNumbers: data.problems.length
        }
      };
      return { status: 200, payload: summary };
    });
    return send(res, result.status, result.payload);
  }

  send(res, 404, { error: "接口不存在" });
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveFile(req, res);
}).listen(PORT, HOST, () => {
  console.log(`本地模拟模式：${DEMO_MODE ? "开启（虚构号码，模拟验证码）" : "关闭"}`);
  console.log(`短信测试台已启动：http://${HOST}:${PORT}`);
  console.log(`后台地址：http://${HOST}:${PORT}/admin.html 口令：${ADMIN_TOKEN}`);
});
