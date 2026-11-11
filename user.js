let token = localStorage.getItem("smsShareDemoSessionToken") || "";
let expiresAt = 0;
let timer = null;

const apiBase = document.querySelector('meta[name="api-base"]')?.content?.replace(/\/$/, "") || "/api";
const keyInput = document.getElementById("keyInput");
const phoneText = document.getElementById("phoneText");
const stateText = document.getElementById("stateText");
const timerText = document.getElementById("timerText");
const codeText = document.getElementById("codeText");
const msgText = document.getElementById("msgText");
const copyBtn = document.getElementById("copyBtn");
const refreshBtn = document.getElementById("refreshBtn");
const changeBtn = document.getElementById("changeBtn");
const finishBtn = document.getElementById("finishBtn");

const requiredElements = {
  keyInput,
  phoneText,
  stateText,
  timerText,
  codeText,
  msgText,
  copyBtn,
  refreshBtn,
  changeBtn,
  finishBtn,
  claimBtn: document.getElementById("claimBtn")
};
const missingElements = Object.entries(requiredElements).filter(([, element]) => !element).map(([name]) => name);
if (missingElements.length) {
  throw new Error(`\u9875\u9762\u6587\u4ef6\u4e0d\u5339\u914d\uff0c\u7f3a\u5c11\u5143\u7d20\uff1a${missingElements.join(", ")}`);
}

function apiUrl(path) {
  return `${apiBase}${path}`;
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    ...options
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    const looksLikeHtml = /^\s*</.test(text);
    throw new Error(looksLikeHtml
      ? "\u63a5\u53e3\u8fd4\u56de\u4e86\u7f51\u9875\u5185\u5bb9\u3002\u8bf7\u786e\u8ba4 Node \u670d\u52a1\u6b63\u5728\u8fd0\u884c\uff0c\u5e76\u4e14 /api \u5df2\u8f6c\u53d1\u5230\u8be5\u670d\u52a1\u3002"
      : "\u63a5\u53e3\u8fd4\u56de\u683c\u5f0f\u4e0d\u662f JSON\u3002");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "\u8bf7\u6c42\u5931\u8d25");
  return data;
}

function fmt(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function setButtons(hasPhone, hasCode) {
  copyBtn.disabled = !hasPhone;
  refreshBtn.disabled = !hasPhone || hasCode;
  changeBtn.disabled = !hasPhone || hasCode;
  finishBtn.disabled = !hasCode;
}

function paint(status) {
  phoneText.textContent = status.phone || "\u672a\u5206\u914d";
  codeText.textContent = status.code || "----";
  expiresAt = status.expiresAt || 0;

  if (status.finished) {
    stateText.textContent = status.used ? "\u5bc6\u94a5\u5df2\u4f7f\u7528" : "\u5df2\u5b8c\u6210";
    msgText.textContent = status.used
      ? "\u6b64\u5bc6\u94a5\u5df2\u88ab\u4f7f\u7528\uff0c\u65e0\u6cd5\u518d\u6b21\u83b7\u53d6\u53f7\u7801\u3002\u4ee5\u4e0b\u662f\u8be5\u5bc6\u94a5\u7ed1\u5b9a\u7684\u624b\u673a\u53f7\u548c\u9a8c\u8bc1\u7801\u3002"
      : "\u9a8c\u8bc1\u7801\u5df2\u6536\u5230\uff0c\u5bc6\u94a5\u5df2\u81ea\u52a8\u5931\u6548\u3002\u8bf7\u590d\u5236\u9a8c\u8bc1\u7801\u4f7f\u7528\u3002";
    setButtons(true, Boolean(status.code));
    copyBtn.disabled = false;
    refreshBtn.disabled = true;
    changeBtn.disabled = true;
    finishBtn.disabled = true;
    return;
  }

  if (!status.phone) {
    stateText.textContent = "\u7b49\u5f85\u8f93\u5165\u5bc6\u94a5";
    msgText.textContent = "这是功能演示，领取虚构号码后将自动显示模拟验证码。";
    setButtons(false, false);
    return;
  }
  stateText.textContent = status.code ? "\u5df2\u6536\u5230\u9a8c\u8bc1\u7801" : "\u7b49\u5f85\u9a8c\u8bc1\u7801";
  msgText.textContent = status.code ? "\u8bf7\u5c3d\u5feb\u4f7f\u7528\u9a8c\u8bc1\u7801\uff0c\u5b8c\u6210\u540e\u70b9\u51fb\u5b8c\u6210\u3002" : "\u5982\u679c\u957f\u65f6\u95f4\u6ca1\u6709\u6536\u5230\uff0c\u53ef\u4ee5\u5237\u65b0\u6216\u6362\u4e00\u4e2a\u624b\u673a\u53f7\u3002";
  setButtons(true, Boolean(status.code));
}

function paintSessionGone() {
  // \u5982\u679c\u5df2\u7ecf\u62ff\u5230\u9a8c\u8bc1\u7801\uff0c\u4e0d\u8986\u76d6\u754c\u9762\uff08\u907f\u514d\u5e76\u53d1\u8f6e\u8be2\u628a\u521a\u663e\u793a\u7684\u9a8c\u8bc1\u7801\u51b2\u6389\uff09
  if (codeText.textContent && codeText.textContent !== "----") return;
  clearInterval(timer);
  phoneText.textContent = "\u672a\u5206\u914d";
  codeText.textContent = "----";
  stateText.textContent = "\u4f1a\u8bdd\u5df2\u5931\u6548";
  msgText.textContent = "\u83b7\u53d6\u53f7\u7801\u540e 10 \u5206\u949f\u672a\u6536\u5230\u9a8c\u8bc1\u7801\uff0c\u53f7\u7801\u4f1a\u81ea\u52a8\u91ca\u653e\u3002\u8bf7\u91cd\u65b0\u8f93\u5165\u5bc6\u94a5\u83b7\u53d6\u53f7\u7801\u3002";
  timerText.textContent = "00:00";
  setButtons(false, false);
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    timerText.textContent = expiresAt ? fmt(expiresAt - Date.now()) : "10:00";
  }, 1000);
}

async function refreshStatus() {
  if (!token) return;
  try {
    const status = await api(`/status?token=${encodeURIComponent(token)}`);
    if (status.finished) {
      paint(status);
      localStorage.removeItem("smsShareDemoSessionToken");
      token = "";
      return;
    }
    paint(status);
    startTimer();
  } catch {
    localStorage.removeItem("smsShareDemoSessionToken");
    token = "";
    paintSessionGone();
  }
}

requiredElements.claimBtn.addEventListener("click", async () => {
  try {
    const data = await api("/claim", {
      method: "POST",
      body: JSON.stringify({ key: keyInput.value })
    });
    if (data.used) {
      // 已使用的密钥：回看号码和验证码，不建立新会话
      localStorage.removeItem("smsShareDemoSessionToken");
      token = "";
      paint(data);
      return;
    }
    token = data.token;
    localStorage.setItem("smsShareDemoSessionToken", token);
    paint(data);
    startTimer();
  } catch (error) {
    alert(error.message);
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    return ok;
  }
}

copyBtn.addEventListener("click", async () => {
  const ok = await copyText(phoneText.textContent);
  msgText.textContent = ok ? "已复制手机号。" : "复制失败，请长按号码手动选择复制。";
});
refreshBtn.addEventListener("click", refreshStatus);
changeBtn.addEventListener("click", async () => {
  try {
    const data = await api("/change-phone", { method: "POST", body: JSON.stringify({ token }) });
    paint(data);
  } catch (error) {
    alert(error.message);
  }
});
finishBtn.addEventListener("click", async () => {
  try {
    await api("/finish", { method: "POST", body: JSON.stringify({ token }) });
    localStorage.removeItem("smsShareDemoSessionToken");
    token = "";
    paint({});
    alert("\u5df2\u5b8c\u6210\uff0c\u5bc6\u94a5\u5df2\u5931\u6548\u3002");
  } catch (error) {
    alert(error.message);
  }
});

refreshStatus();
setInterval(refreshStatus, 5000);
startTimer();
