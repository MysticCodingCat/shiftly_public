/* 管理後台 */
"use strict";

let me = null;
let currentTab = "overview";

const PAGES = {
  overview:  { title: "總覽", desc: "系統狀態與使用統計" },
  users:     { title: "使用者", desc: "建立單位帳號、重設密碼、停用" },
  schedules: { title: "班表總覽", desc: "所有單位的班表文件" },
  jobs:      { title: "求解記錄", desc: "最近的排班計算工作" },
  backup:    { title: "備份與安全", desc: "資料庫備份下載與密碼管理" },
};

const ICONS = {
  overview:  '<rect x="3" y="12" width="5" height="8" rx="1"/><rect x="10" y="7" width="5" height="13" rx="1"/><rect x="17" y="3" width="5" height="17" rx="1"/>',
  users:     '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 010 7M17.5 14.5c2.1.8 3.5 2.9 3.5 5.5"/>',
  schedules: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M9 9v11M15 9v11"/>',
  jobs:      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  backup:    '<path d="M12 3v10m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
};

const $ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/"; throw new Error("未登入"); }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}
const postJSON = (p, d) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  for (const key of Object.keys(PAGES)) {
    nav.append(el("a", {
      class: key === currentTab ? "active" : "",
      html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg><span>${PAGES[key].title}</span>`,
      onclick: () => gotoTab(key),
    }));
  }
}

function gotoTab(name) {
  currentTab = name;
  buildNav();
  $("#page-title").textContent = PAGES[name].title;
  $("#page-desc").textContent = PAGES[name].desc;
  RENDERERS[name]();
}

// ---------- 總覽 ----------
async function renderOverview() {
  const root = $("#main");
  root.innerHTML = "";
  let s;
  try { s = await api("/api/admin/stats"); }
  catch (e) { root.append(el("p", { class: "muted" }, e.message)); return; }
  const up = s.uptimeSeconds;
  const uptime = up > 86400 ? `${Math.floor(up / 86400)} 天 ${Math.floor(up % 86400 / 3600)} 小時`
    : up > 3600 ? `${Math.floor(up / 3600)} 小時 ${Math.floor(up % 3600 / 60)} 分` : `${Math.floor(up / 60)} 分鐘`;
  const tiles = [
    ["使用者", s.userCount], ["班表文件", s.scheduleCount], ["累計求解", s.jobCount],
    ["進行中求解", s.runningJobs], ["資料庫大小", (s.dbSizeBytes / 1024).toFixed(0) + " KB"],
    ["已運行", uptime], ["版本", s.version],
  ];
  const grid = el("div", { class: "grid c3" });
  for (const [label, value] of tiles) {
    grid.append(el("div", { class: "card", style: "margin:0" },
      el("div", { class: "muted", style: "font-size:12px" }, label),
      el("div", { style: "font-size:22px;font-weight:700;margin-top:4px" }, String(value))));
  }
  root.append(grid);
}

// ---------- 使用者 ----------
async function renderUsers() {
  const root = $("#main");
  root.innerHTML = "";
  let users;
  try { users = await api("/api/admin/users"); }
  catch (e) { root.append(el("p", { class: "muted" }, e.message)); return; }

  const body = el("tbody");
  for (const u of users) {
    body.append(el("tr", {},
      el("td", {}, String(u.id)),
      el("td", {}, u.username),
      el("td", {}, u.displayName || "—"),
      el("td", {}, u.role === "admin" ? "管理員" : "單位"),
      el("td", {}, u.active ? "啟用" : el("span", { style: "color:var(--danger)" }, "已停用")),
      el("td", {}, fmtTime(u.createdAt)),
      el("td", {}, el("div", { class: "row" },
        el("button", { class: "small", onclick: async () => {
          const pw = prompt(`重設「${u.username}」的密碼（至少 8 字元）：`);
          if (!pw) return;
          try { await postJSON(`/api/admin/users/${u.id}/reset-password`, { password: pw }); toast("已重設，該使用者下次登入需改密碼"); }
          catch (e) { toast(e.message); }
        } }, "重設密碼"),
        u.username !== me.username ? el("button", { class: "small " + (u.active ? "danger" : ""), onclick: async () => {
          try { await postJSON(`/api/admin/users/${u.id}/toggle`, {}); renderUsers(); }
          catch (e) { toast(e.message); }
        } }, u.active ? "停用" : "啟用") : null))));
  }

  const nu = { username: "", password: "", displayName: "" };
  root.append(
    el("div", { class: "card" },
      el("h2", {}, "使用者清單"),
      el("table", { class: "editor" },
        el("thead", {}, el("tr", {}, ["ID", "帳號", "名稱", "角色", "狀態", "建立時間", ""].map(h => el("th", {}, h)))),
        body)),
    el("div", { class: "card" },
      el("h2", {}, "建立單位帳號"),
      el("p", { class: "hint" }, "新帳號首次登入會被要求更換密碼。"),
      el("div", { class: "grid c3" },
        el("label", { class: "field" }, "帳號",
          el("input", { type: "text", onchange: e => nu.username = e.target.value })),
        el("label", { class: "field" }, "初始密碼（至少 8 字元）",
          el("input", { type: "text", onchange: e => nu.password = e.target.value })),
        el("label", { class: "field" }, "顯示名稱（如：9A病房）",
          el("input", { type: "text", onchange: e => nu.displayName = e.target.value }))),
      el("div", { class: "right mt" },
        el("button", { class: "primary", onclick: async () => {
          try { await postJSON("/api/admin/users", nu); toast("已建立"); renderUsers(); }
          catch (e) { toast(e.message, 3000); }
        } }, "建立帳號"))));
}

// ---------- 班表總覽 ----------
async function renderSchedules() {
  const root = $("#main");
  root.innerHTML = "";
  let items;
  try { items = await api("/api/admin/schedules"); }
  catch (e) { root.append(el("p", { class: "muted" }, e.message)); return; }
  const body = el("tbody");
  for (const it of items) {
    body.append(el("tr", {},
      el("td", {}, String(it.id)),
      el("td", {}, it.name || "未命名"),
      el("td", {}, it.owner_display || it.owner_name),
      el("td", {}, it.has_result ? "已排班" : "未排班"),
      el("td", {}, fmtTime(it.updated_at)),
      el("td", {}, el("button", { class: "small danger", onclick: async () => {
        if (!confirm(`刪除「${it.name}」（${it.owner_name}）？`)) return;
        await api(`/api/admin/schedules/${it.id}`, { method: "DELETE" });
        renderSchedules();
      } }, "刪除"))));
  }
  root.append(el("div", { class: "card" },
    el("h2", {}, `全部班表（${items.length}）`),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["ID", "名稱", "單位", "狀態", "更新時間", ""].map(h => el("th", {}, h)))),
      body)));
}

// ---------- 求解記錄 ----------
async function renderJobs() {
  const root = $("#main");
  root.innerHTML = "";
  let jobs;
  try { jobs = await api("/api/admin/jobs?limit=100"); }
  catch (e) { root.append(el("p", { class: "muted" }, e.message)); return; }
  const body = el("tbody");
  for (const j of jobs) {
    const statusText = j.status === "running" ? "計算中"
      : j.status === "error" ? "錯誤"
      : j.status === "interrupted" ? "中斷（伺服器重啟）"
      : ({ optimal: "最佳解", feasible: "可行解", infeasible: "無解", timeout: "逾時" })[j.result_status] || j.result_status || "—";
    body.append(el("tr", {},
      el("td", {}, fmtTime(j.created_at)),
      el("td", {}, j.username || "—"),
      el("td", {}, j.schedule_name || "—"),
      el("td", {}, statusText),
      el("td", { class: "right" }, j.seconds != null ? j.seconds.toFixed(1) + " 秒" : "—")));
  }
  root.append(el("div", { class: "card" },
    el("h2", {}, "最近 100 筆求解"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["時間", "使用者", "班表", "結果", "耗時"].map(h => el("th", {}, h)))),
      body)));
}

// ---------- 備份與安全 ----------
function renderBackup() {
  const root = $("#main");
  root.innerHTML = "";
  const oldPw = el("input", { type: "password", autocomplete: "current-password" });
  const newPw = el("input", { type: "password", autocomplete: "new-password" });
  const confirmPw = el("input", { type: "password", autocomplete: "new-password" });
  const msg = el("p", { class: "modal-msg" });

  const submit = async () => {
    msg.textContent = ""; msg.className = "modal-msg";
    const fail = (t) => { msg.textContent = t; msg.classList.add("bad"); };
    if (newPw.value.length < 8) return fail("新密碼至少需要 8 個字元");
    if (newPw.value !== confirmPw.value) return fail("兩次輸入的新密碼不一致");
    if (newPw.value === oldPw.value) return fail("新密碼不可與目前密碼相同");
    try {
      await postJSON("/api/auth/change-password",
        { oldPassword: oldPw.value, newPassword: newPw.value });
      oldPw.value = newPw.value = confirmPw.value = "";
      msg.textContent = "密碼已更新，下次登入請使用新密碼";
      me.mustChangePassword = false;
      renderPwWarning();
    } catch (e) { fail(e.message); }
  };

  root.append(
    el("div", { class: "card" },
      el("h2", {}, "資料庫備份"),
      el("p", { class: "hint" }, "下載目前資料庫的一致性快照（包含所有帳號與班表）。建議每週下載一次，存到雲端硬碟等異地位置。"),
      el("a", { href: "/api/admin/backup", class: "btn-like", style: "display:inline-block;text-decoration:none" }, "下載備份檔")),
    el("div", { class: "card" },
      el("h2", {}, "變更自己的密碼"),
      el("p", { class: "hint" }, "對外開放服務前，請確認管理員密碼已不是預設值。"),
      el("div", { class: "grid c3" },
        el("label", { class: "field" }, "目前密碼", oldPw),
        el("label", { class: "field" }, "新密碼（至少 8 字元）", newPw),
        el("label", { class: "field" }, "再次輸入新密碼", confirmPw)),
      msg,
      el("div", { class: "right mt" },
        el("button", { class: "primary", onclick: submit }, "更新密碼"))));
}

function renderPwWarning() {
  const old = $("#pw-warn");
  if (old) old.remove();
  if (!me?.mustChangePassword) return;
  const bar = el("div", { id: "pw-warn", class: "warn-bar" },
    el("span", {}, el("b", {}, "管理員帳號仍在使用預設密碼。"),
      " 對外開放前務必更換，否則任何人都能取得管理權限。"),
    el("button", { class: "small", onclick: () => gotoTab("backup") }, "前往變更"));
  $(".content").insertBefore(bar, $(".pagehead"));
}

const RENDERERS = {
  overview: renderOverview, users: renderUsers, schedules: renderSchedules,
  jobs: renderJobs, backup: renderBackup,
};

(async function init() {
  try {
    me = await api("/api/auth/me");
  } catch { return; }
  if (me.role !== "admin") { location.href = "/"; return; }
  buildNav();
  renderPwWarning();
  gotoTab(me.mustChangePassword ? "backup" : "overview");
})();
