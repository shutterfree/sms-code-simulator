const apiBase = document.querySelector('meta[name="api-base"]')?.content?.replace(/\/$/, "") || "/api";
const tokenInput = document.getElementById("adminToken");
const keyRows = document.getElementById("keyRows");
const problemRows = document.getElementById("problemRows");
let adminToken = "";

function apiUrl(path) {
  return `${apiBase}${path}`;
}

async function getJson(path) {
  const res = await fetch(apiUrl(path), { headers: { "Accept": "application/json" } });
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

// \u628a UTC \u65f6\u95f4\u56fa\u5b9a\u8f6c\u6210\u5317\u4eac\u65f6\u95f4\uff08UTC+8\uff09\u663e\u793a\uff0c\u4e0e\u670d\u52a1\u5668/\u6d4f\u89c8\u5668\u65f6\u533a\u65e0\u5173
function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const s = n => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${s(bj.getUTCMonth() + 1)}-${s(bj.getUTCDate())} ${s(bj.getUTCHours())}:${s(bj.getUTCMinutes())}:${s(bj.getUTCSeconds())}`;
}

async function loadAdmin() {
  try {
    adminToken = tokenInput.value.trim();
    const data = await getJson(`/admin?token=${encodeURIComponent(adminToken)}`);
    document.getElementById("readyKeys").textContent = data.totals.readyKeys;
    document.getElementById("lockedKeys").textContent = data.totals.lockedKeys;
    document.getElementById("usedKeys").textContent = data.totals.usedKeys;
    document.getElementById("problemNumbers").textContent = data.totals.problemNumbers;

    keyRows.innerHTML = "";
    data.keys.forEach(item => {
      keyRows.insertAdjacentHTML("beforeend",
        `<tr><td data-label="密钥">${item.key}</td><td data-label="状态">${item.status}</td><td data-label="绑定号码">${item.phone || "-"}</td><td data-label="完成时间">${formatTime(item.usedAt)}</td></tr>`);
    });

    problemRows.innerHTML = "";
    data.problems.forEach(item => {
      const key = data.keys.find(k => k.id === item.keyId);
      const isUsed = key && key.status === "used";
      problemRows.insertAdjacentHTML("beforeend",
        `<tr><td data-label="手机号">${item.phone}</td><td data-label="原因">${item.note}</td><td data-label="时间">${formatTime(item.time)}</td>
         <td data-label="操作"><button class="recoverBtn" data-phone="${item.phone}" ${isUsed ? "disabled" : ""}>${isUsed ? "不可恢复" : "恢复"}</button></td></tr>`
      );
    });
  } catch (error) {
    alert(error.message);
  }
}

async function recoverPhone(phone) {
  if (!adminToken) { alert("请先登录后台"); return; }
  if (!confirm(`确定要恢复号码 ${phone} 为可用状态吗？\n\n如果该号码关联的密钥没有验证码且未使用，密钥也会一并恢复。`)) return;
  try {
    const res = await fetch(apiUrl("/admin/recover"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ adminToken, phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    alert(`已恢复号码 ${data.recoveredPhone}`);
    loadAdmin();
  } catch (error) {
    alert(error.message);
  }
}

problemRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".recoverBtn");
  if (btn && !btn.disabled) recoverPhone(btn.dataset.phone);
});

document.getElementById("loadBtn").addEventListener("click", loadAdmin);

const addNumbersText = document.getElementById("addNumbersText");
const addNumbersBtn = document.getElementById("addNumbersBtn");
const addNumbersMsg = document.getElementById("addNumbersMsg");

addNumbersBtn.addEventListener("click", async () => {
  if (!adminToken) { alert("请先登录后台"); return; }
  const text = addNumbersText.value.trim();
  if (!text) { alert("请先粘贴号码和接口内容"); return; }
  try {
    const res = await fetch(apiUrl("/admin/add-numbers"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ adminToken, text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    addNumbersMsg.textContent = `补充成功：新增 ${data.added} 个，更新 ${data.updated} 个，当前共 ${data.total} 个号码`;
    addNumbersMsg.className = "ok";
    addNumbersText.value = "";
    loadAdmin();
  } catch (error) {
    addNumbersMsg.textContent = error.message;
    addNumbersMsg.className = "err";
  }
});

const addKeysCount = document.getElementById("addKeysCount");
const addKeysBtn = document.getElementById("addKeysBtn");
const addKeysMsg = document.getElementById("addKeysMsg");
const newKeysOut = document.getElementById("newKeysOut");
const keyModal = document.getElementById("keyModal");
const modalKeysOut = document.getElementById("modalKeysOut");
const copyKeysBtn = document.getElementById("copyKeysBtn");
const closeKeysModal = document.getElementById("closeKeysModal");

addKeysBtn.addEventListener("click", async () => {
  if (!adminToken) { alert("请先登录后台"); return; }
  const count = Math.max(1, Math.min(200, parseInt(addKeysCount.value || "10", 10) || 10));
  try {
    const res = await fetch(apiUrl("/admin/add-keys"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ adminToken, count })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    addKeysMsg.textContent = `已生成 ${data.added} 个密钥，当前共 ${data.total} 个`;
    addKeysMsg.className = "ok";
    const keysText = data.keys.join("\n");
    newKeysOut.value = keysText;
    modalKeysOut.value = keysText;
    keyModal.style.display = "flex";
    loadAdmin();
  } catch (error) {
    addKeysMsg.textContent = error.message;
    addKeysMsg.className = "err";
  }
});

// 新密钥弹窗交互
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

copyKeysBtn.addEventListener("click", async () => {
  const ok = await copyText(modalKeysOut.value);
  copyKeysBtn.textContent = ok ? "已复制 ✓" : "复制失败，请手动选择复制";
  setTimeout(() => { copyKeysBtn.textContent = "复制全部"; }, 1500);
});

closeKeysModal.addEventListener("click", () => { keyModal.style.display = "none"; });
keyModal.addEventListener("click", (e) => { if (e.target === keyModal) keyModal.style.display = "none"; });
