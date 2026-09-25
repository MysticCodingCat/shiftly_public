/* 排班平台前端 */
"use strict";

// ============ 全域狀態 ============
let schema = null;
let lastResult = null;
let resultPristine = null;   // 求解原始結果（還原手動修改用）
let manualEdits = {};        // "empId|date" -> shiftId（手動微調暫存）
let pollTimer = null;
let currentTab = "files";
let solving = false;
let currentUser = null;      // 登入者資訊
let currentScheduleId = null; // 目前開啟的伺服器班表文件
let saveTimer = null;

function saveResult() {
  try { localStorage.setItem("scheduler-last-result", JSON.stringify(lastResult)); } catch {}
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"]; // getDay() 索引

const BLOCK_INFO = {
  rest_in_window:          { name: "七休一", desc: "任意連續 N 天內至少 M 天休息" },
  max_consecutive_work:    { name: "連續工作上限", desc: "最多連續上班 N 天" },
  min_rest_between_shifts: { name: "輪班間隔", desc: "依班別起訖時間自動禁止間隔不足的接班" },
  hours_cap_per_period:    { name: "週期工時上限", desc: "每週或每月工時不得超過上限" },
  hours_target_per_block:  { name: "變形工時區塊", desc: "四週區塊工時貼近目標，跨月自動按比例折算" },
  overtime_cap_rolling:    { name: "滾動加班上限", desc: "近 N 個月加班總時數上限" },
  rest_quota_per_period:   { name: "假別配額", desc: "每週或每四週的例假、休假天數規定" },
  national_holiday_rule:   { name: "國定假日", desc: "特定職稱國假強制休，國假班別限國假日使用" },
  max_consecutive_shift:   { name: "連續特定班別上限", desc: "例如大夜最多連上四天" },
  forbidden_sequence:      { name: "禁止班別序列", desc: "例如禁止大夜隔日接白班" },
  shift_variety_limit:     { name: "班別種類上限", desc: "每人每月最多使用 N 種工作班別" },
  fixed_shift_pattern:     { name: "固定班別模式", desc: "特定人員依週間固定模式排班" },
  balance:                 { name: "公平性平衡", desc: "休假數、夜班數、週末休在人員間平均" },
  quota_annual_spread:     { name: "年度配額消化", desc: "年度配額類假別的逐月投放控制" },
  pair_alignment:          { name: "配對同休", desc: "新人休假日盡量與帶領者一致" },
  preference_default_shift:{ name: "偏好預設班別", desc: "盡量排每個人的預設班別" },
  avoid_single_rest:       { name: "避免單日夾休", desc: "避免上、休、上的孤立休息日" },
  avoid_consecutive_rest:  { name: "避免休假集中", desc: "避免連續多天休息" },
  group_rest_exclusion:    { name: "小組同日休假限制", desc: "同一小組平日同一天最多一人休" },
  weekend_rest_default:    { name: "預設週休二日", desc: "週六排例假、週日排休假" },
  support_staff_cost:      { name: "支援人力成本", desc: "動用支援或虛擬人力時計價" },
  skill_assignment:        { name: "技能位分配", desc: "每班需要特定技能的人數，一人一天只計一個技能位" },
  group_dispatch:          { name: "小組整組出勤", desc: "小組要嘛不出勤，出勤就須達最小規模與職級組成" },
  staffing_cost:           { name: "人力成本計價", desc: "每個班次計入成本，只排剛好足夠的人力（精實模式使用）" },
};

// 排班取向：對應到「偏好預設班別」與「人力成本」兩個積木的參數組合
const MODES = {
  full: {
    name: "排滿模式",
    subtitle: "人力穩定、收入穩定",
    desc: "在合法範圍內盡量把每個人排滿並固定在自己的班別。適合正職為主、員工希望工時穩定的單位。",
    preferenceWeight: 300, staffingCost: 0,
  },
  lean: {
    name: "精實模式",
    subtitle: "人事成本優先",
    desc: "只排剛好滿足需求的人力，其餘時間排休。適合人力充裕、想控制加班與人事成本的單位。",
    preferenceWeight: 30, staffingCost: 100,
  },
};

function findConstraint(block) {
  return (schema.constraints || []).find(c => c.block === block);
}

function detectMode() {
  const cost = findConstraint("staffing_cost");
  const pref = findConstraint("preference_default_shift");
  const costOn = cost && cost.enabled;
  const prefW = pref ? (pref.params?.rewardWeight ?? pref.weight ?? 0) : 0;
  for (const [key, m] of Object.entries(MODES)) {
    if (!!m.staffingCost === !!costOn && prefW === m.preferenceWeight) return key;
  }
  return "custom";
}

function applyMode(key) {
  const m = MODES[key];
  if (!m) return;
  let pref = findConstraint("preference_default_shift");
  if (!pref) {
    pref = { id: "c-prefer-default", block: "preference_default_shift", enabled: true,
             enforcement: "soft", params: { attributeField: "defaultShift" } };
    schema.constraints.push(pref);
  }
  pref.enabled = true;
  pref.weight = m.preferenceWeight;
  pref.params = { ...(pref.params || {}), rewardWeight: m.preferenceWeight };

  let cost = findConstraint("staffing_cost");
  if (m.staffingCost > 0) {
    if (!cost) {
      cost = { id: "c-staffing-cost", block: "staffing_cost", enabled: true,
               enforcement: "soft", params: {} };
      schema.constraints.push(cost);
    }
    cost.enabled = true;
    cost.params = { ...(cost.params || {}), perShiftPenalty: m.staffingCost };
  } else if (cost) {
    cost.enabled = false;
  }
  saveDraft();
  renderRules();
  toast(`已切換為${m.name}，請重新排班`);
}

const PARAM_LABELS = {
  windowDays: "視窗天數", minRestDays: "最少休息天數", maxDays: "天數上限",
  minHours: "最少間隔(時)", maxHours: "工時上限", period: "週期",
  targetHours: "目標工時", mode: "模式", softWeight: "軟性權重", blockType: "區塊類型",
  windowMonths: "月數", historyField: "歷史欄位", count: "數量", op: "運算",
  maxDistinct: "種類上限", maxConsecutive: "連續上限", maxRestPerDay: "每日休假上限",
  groupField: "分組欄位", pairField: "配對欄位", attributeField: "屬性欄位",
  rewardWeight: "獎勵權重", metric: "指標", target: "目標", rangePenaltyWeight: "差距權重",
  quotaKey: "配額鍵", shiftId: "班別", monthlyOverCap: "單月上限", forceShiftId: "指定班別",
  onlyWeekdays: "僅平日", onlyWorkdays: "僅工作日", settleInDecember: "12月結清",
  regularReward: "正職獎勵", sat: "週六班別", sun: "週日班別",
};

const PAGES = {
  files:   { title: "我的班表", desc: "此帳號建立的所有班表文件" },
  start:   { title: "模板", desc: "選擇行業模板建立新班表，或匯入既有設定檔" },
  basic:   { title: "基本設定", desc: "班表期間、變形工時區塊與國定假日" },
  shifts:  { title: "班別", desc: "定義工作班與休假類班別的時間與工時" },
  staff:   { title: "人員", desc: "人員名單、年資、技能與可上班別" },
  demands: { title: "人力需求", desc: "每日各班別的最低人數與資格要求" },
  rules:   { title: "排班規則", desc: "開關規則、調整硬性或軟性與權重" },
  prefill: { title: "預班與請假", desc: "指定班別、請假與禁排設定" },
  history: { title: "上期銜接", desc: "上期期末班表，供跨月的七休一、連續夜班與輪班間隔檢核" },
  result:  { title: "班表結果", desc: "產生班表、手動微調、檢視違規與公平性統計" },
  audit:   { title: "班表檢核", desc: "檢查任何一份既有班表是否違反規則，包含人工排出來的班表" },
};

const ICONS = {
  files:   '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  start:   '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  basic:   '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="15" cy="8" r="2.5"/><circle cx="7" cy="16" r="2.5"/>',
  shifts:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  staff:   '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 010 7M17.5 14.5c2.1.8 3.5 2.9 3.5 5.5"/>',
  demands: '<path d="M4 20V10M10 20V4M16 20v-8M21 20H3"/>',
  rules:   '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  prefill: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  history: '<path d="M3 12a9 9 0 109-9 9.4 9.4 0 00-6.7 3L3 8"/><path d="M3 3v5h5M12 7v5l3.5 2"/>',
  result:  '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M9 9v11M15 9v11M3 14.5h18"/>',
  audit:   '<path d="M9 11l2 2 4-4"/><circle cx="11" cy="11" r="8"/><path d="M17 17l4 4"/>',
};

// ============ 小工具 ============
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

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

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401 && path !== "/api/auth/login") {
    showLogin();
    throw new Error("請先登入");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}
const postJSON = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const putJSON = (path, data) => api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function setSaveStatus(text) {
  const s = $("#save-status");
  if (s) s.textContent = text;
}

function saveDraft() {
  if (!schema) return;
  localStorage.setItem("scheduler-draft", JSON.stringify(schema));
  if (currentUser && currentScheduleId) {
    setSaveStatus("儲存中…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await putJSON(`/api/schedules/${currentScheduleId}`, { schema });
        setSaveStatus("已儲存");
      } catch { setSaveStatus("儲存失敗"); }
    }, 1200);
  }
}

async function createScheduleDoc() {
  if (!currentUser || !schema) return;
  const r = await postJSON("/api/schedules", { schema });
  currentScheduleId = r.id;
  setSaveStatus("已儲存");
}

function field(labelText, inputEl) { return el("label", { class: "field" }, labelText, inputEl); }

function textInput(value, onchange, attrs = {}) {
  const i = el("input", { type: "text", value: value ?? "", ...attrs });
  i.addEventListener("change", () => { onchange(i.value); saveDraft(); });
  return i;
}
function numInput(value, onchange, attrs = {}) {
  const i = el("input", { type: "number", value: value ?? "", ...attrs });
  i.addEventListener("change", () => { onchange(i.value === "" ? null : Number(i.value)); saveDraft(); });
  return i;
}
function dateInput(value, onchange) {
  const i = el("input", { type: "date", value: value ?? "" });
  i.addEventListener("change", () => { onchange(i.value); saveDraft(); });
  return i;
}
function selectInput(value, options, onchange) {
  const s = el("select", {}, options.map(([v, label]) =>
    el("option", { value: v, ...(String(v) === String(value) ? { selected: "" } : {}) }, label)));
  s.addEventListener("change", () => { onchange(s.value); saveDraft(); });
  return s;
}
function checkbox(checked, onchange) {
  const label = el("label", { class: "switch" });
  const i = el("input", { type: "checkbox" });
  i.checked = !!checked;
  i.addEventListener("change", () => { onchange(i.checked); saveDraft(); });
  label.append(i, el("span", { class: "sl" }));
  return label;
}

const workShifts = () => (schema?.shifts || []).filter(s => s.kind === "work");
const allShiftIds = () => (schema?.shifts || []).map(s => s.id);

// ============ 導覽 ============
function buildNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  for (const key of Object.keys(PAGES)) {
    const a = el("a", {
      class: key === currentTab ? "active" : "",
      html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg><span>${PAGES[key].title}</span>`,
      onclick: () => gotoTab(key),
    });
    nav.append(a);
  }
}

function gotoTab(name) {
  currentTab = name;
  buildNav();
  $("#page-title").textContent = PAGES[name].title;
  $("#page-desc").textContent = PAGES[name].desc;
  document.title = `${PAGES[name].title}－排班平台`;
  RENDERERS[name]?.();
}

// ============ 模板頁 ============
async function renderStart() {
  const root = $("#main");
  root.innerHTML = "";
  const card = el("div", { class: "card" }, el("h2", {}, "行業模板"),
    el("p", { class: "hint" }, "模板內含預先設好的班別、規則與參數，載入後可自由調整。"));
  root.append(card);
  try {
    const templates = await api("/api/templates");
    for (const t of templates) {
      card.append(el("div", { class: "tpl-card" },
        el("div", {},
          el("b", {}, t.name),
          el("div", { class: "desc" }, t.description || "")),
        el("button", { class: "primary", onclick: async () => {
          schema = await api(`/api/templates/${t.id}`);
          lastResult = null;
          resultPristine = null;
          manualEdits = {};
          await createScheduleDoc();
          saveDraft();
          toast(`已建立新班表：${t.name}`);
          gotoTab("basic");
        }}, "使用此模板")));
    }
  } catch (e) {
    card.append(el("p", { class: "muted" }, "無法載入模板清單：" + e.message));
  }
  if (schema) {
    card.append(el("p", { class: "mt muted" },
      `目前工作區：${schema.meta?.name || "(未命名)"}，共 ${schema.employees?.length || 0} 名人員。重新載入模板會覆蓋目前內容。`));
  }
}

// ============ 我的班表 ============
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderFiles() {
  const root = $("#main");
  root.innerHTML = "";
  const card = el("div", { class: "card" },
    el("h2", {}, "班表文件"),
    el("p", { class: "hint" }, "儲存在伺服器上的班表，換裝置登入同一帳號即可繼續編輯。"));
  root.append(card);
  let items = [];
  try { items = await api("/api/schedules"); }
  catch (e) { card.append(el("p", { class: "muted" }, "載入失敗：" + e.message)); return; }

  if (!items.length) {
    card.append(el("div", { class: "onboard" },
      el("div", { class: "onboard-hd" }, "第一次使用？兩種開始方式"),
      el("div", { class: "onboard-grid" },
        el("div", { class: "onboard-card" },
          el("div", { class: "onboard-num" }, "A"),
          el("b", {}, "看已排好的示範"),
          el("p", {}, "立刻載入一份 12 人護理病房的完整班表，看看系統排出來長什麼樣、違規怎麼標示、統計怎麼看。不需要任何設定。"),
          el("button", { class: "primary", onclick: async () => {
            try {
              const r = await postJSON("/api/demo", {});
              const doc = await api(`/api/schedules/${r.id}`);
              schema = doc.schema; lastResult = doc.result;
              resultPristine = JSON.stringify(doc.result); manualEdits = {};
              currentScheduleId = doc.id;
              localStorage.setItem("scheduler-draft", JSON.stringify(schema));
              saveResult(); setSaveStatus("已儲存");
              toast("已載入示範班表");
              gotoTab("result");
            } catch (e) { toast("載入失敗：" + e.message); }
          } }, "載入示範班表")),
        el("div", { class: "onboard-card" },
          el("div", { class: "onboard-num" }, "B"),
          el("b", {}, "建立自己的班表"),
          el("p", {}, "從護理三班、診所早晚班、工廠兩班制三種模板挑一個，改成自己單位的班別與人員後排班。"),
          el("button", { onclick: () => gotoTab("start") }, "選擇模板")))));
    return;
  }
  for (const it of items) {
    card.append(el("div", { class: "tpl-card" },
      el("div", {},
        el("b", {}, it.name || "未命名班表"),
        el("div", { class: "desc" },
          `更新於 ${fmtTime(it.updated_at)}`,
          it.has_result ? "・已有排班結果" : "・尚未排班",
          it.id === currentScheduleId ? "・目前開啟中" : "")),
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: async () => {
          const doc = await api(`/api/schedules/${it.id}`);
          schema = doc.schema;
          lastResult = doc.result;
          resultPristine = doc.result ? JSON.stringify(doc.result) : null;
          manualEdits = {};
          currentScheduleId = doc.id;
          localStorage.setItem("scheduler-draft", JSON.stringify(schema));
          if (lastResult) saveResult(); else localStorage.removeItem("scheduler-last-result");
          setSaveStatus("已儲存");
          toast(`已開啟：${doc.name}`);
          gotoTab(doc.result ? "result" : "basic");
        } }, "開啟"),
        el("button", { class: "danger", onclick: async () => {
          if (!confirm(`刪除「${it.name}」？此動作無法復原。`)) return;
          await api(`/api/schedules/${it.id}`, { method: "DELETE" });
          if (currentScheduleId === it.id) currentScheduleId = null;
          renderFiles();
        } }, "刪除"))));
  }
  card.append(el("div", { class: "row mt" },
    el("button", { onclick: () => gotoTab("start") }, "從模板建立新班表")));
}

// ============ 登入 ============
function showLogin() {
  if ($("#login-ov")) return;
  const user = el("input", { type: "text", placeholder: "帳號", autocomplete: "username" });
  const pass = el("input", { type: "password", placeholder: "密碼", autocomplete: "current-password" });
  const msg = el("p", { class: "muted", style: "min-height:18px;margin:6px 0 0;font-size:12.5px" });
  const doLogin = async () => {
    try {
      currentUser = await postJSON("/api/auth/login", { username: user.value, password: pass.value });
      $("#login-ov").remove();
      afterLogin();
    } catch (e) { msg.textContent = e.message; msg.style.color = "var(--danger)"; }
  };
  pass.addEventListener("keydown", ev => { if (ev.key === "Enter") doLogin(); });
  const ov = el("div", { class: "login-overlay", id: "login-ov" },
    el("div", { class: "login-card" },
      el("div", { class: "login-logo" },
        el("span", { html: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8 14h3M13 14h3M8 17.5h3"/></svg>` }),
        "排班平台"),
      el("p", { class: "muted", style: "margin:4px 0 18px" }, "登入以管理你的班表"),
      field("帳號", user),
      el("div", { style: "height:10px" }),
      field("密碼", pass),
      msg,
      el("button", { class: "primary", style: "width:100%;margin-top:16px;padding:10px", onclick: doLogin }, "登入")));
  document.body.append(ov);
  user.focus();
}

function buildUserBox() {
  const foot = document.querySelector(".sidebar-foot");
  const old = $("#user-box");
  if (old) old.remove();
  if (!currentUser) return;
  const box = el("div", { id: "user-box", class: "user-box" },
    el("div", { class: "user-name" }, currentUser.displayName || currentUser.username),
    el("div", { class: "row", style: "gap:6px" },
      currentUser.role === "admin" ? el("a", { href: "/admin", class: "user-link" }, "管理後台") : null,
      currentUser.isDemo ? null : el("a", { class: "user-link", onclick: () => changeOwnPassword() }, "改密碼"),
      el("a", { class: "user-link", onclick: async () => { await postJSON("/api/auth/logout", {}); location.reload(); } }, "登出")));
  foot.prepend(box);
}

function openModal(title, bodyEl, actions, { dismissible = true } = {}) {
  const ov = el("div", { class: "modal-ov", onclick: (ev) => { if (dismissible && ev.target === ov) ov.remove(); } });
  const card = el("div", { class: "modal-card" },
    el("h2", {}, title), bodyEl,
    el("div", { class: "modal-actions" }, actions));
  ov.append(card);
  document.body.append(ov);
  const first = card.querySelector("input");
  if (first) first.focus();
  return ov;
}

function changeOwnPassword(forced = false) {
  const oldPw = el("input", { type: "password", autocomplete: "current-password" });
  const newPw = el("input", { type: "password", autocomplete: "new-password" });
  const confirmPw = el("input", { type: "password", autocomplete: "new-password" });
  const msg = el("p", { class: "modal-msg" });
  const body = el("div", {},
    el("p", { class: "hint", style: "margin-top:0" },
      forced ? "此帳號使用的是預設或管理員重設的密碼，必須先變更才能繼續使用。新密碼至少 8 個字元。"
             : "新密碼至少 8 個字元。變更後其他裝置上的登入會被登出。"),
    field("目前密碼", oldPw), el("div", { style: "height:10px" }),
    field("新密碼", newPw), el("div", { style: "height:10px" }),
    field("再次輸入新密碼", confirmPw), msg);

  const submit = async () => {
    msg.textContent = "";
    msg.className = "modal-msg";
    if (newPw.value.length < 8) { msg.textContent = "新密碼至少需要 8 個字元"; msg.classList.add("bad"); return; }
    if (newPw.value !== confirmPw.value) { msg.textContent = "兩次輸入的新密碼不一致"; msg.classList.add("bad"); return; }
    if (newPw.value === oldPw.value) { msg.textContent = "新密碼不可與目前密碼相同"; msg.classList.add("bad"); return; }
    try {
      await postJSON("/api/auth/change-password",
        { oldPassword: oldPw.value, newPassword: newPw.value });
      currentUser.mustChangePassword = false;
      ov.remove();
      renderPasswordWarning();
      toast("密碼已更新，下次登入請使用新密碼", 4000);
      if (forced) gotoTab("files");
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("bad");
    }
  };
  for (const inp of [oldPw, newPw, confirmPw]) {
    inp.addEventListener("keydown", ev => { if (ev.key === "Enter") submit(); });
  }
  const ov = openModal("變更密碼", body, [
    forced
      ? el("button", { onclick: async () => { await postJSON("/api/auth/logout", {}); location.reload(); } }, "登出")
      : el("button", { onclick: () => ov.remove() }, "取消"),
    el("button", { class: "primary", onclick: submit }, "確認變更"),
  ], { dismissible: !forced });
}

function renderPasswordWarning() {
  const old = $("#pw-warn");
  if (old) old.remove();
  if (!currentUser?.mustChangePassword) return;
  const bar = el("div", { id: "pw-warn", class: "warn-bar" },
    el("span", {},
      el("b", {}, "此帳號仍在使用預設密碼。"),
      " 在把服務對外開放之前務必更換，否則任何人都能登入。"),
    el("button", { class: "small", onclick: () => changeOwnPassword(true) }, "立即變更"));
  $(".content").insertBefore(bar, $(".pagehead"));
}

function afterLogin() {
  buildUserBox();
  buildNav();
  renderPasswordWarning();
  // 伺服器在改密碼前會拒絕其他 API，所以直接要求變更，不先載入班表
  if (currentUser.mustChangePassword) { changeOwnPassword(true); return; }
  gotoTab("files");
}

// ============ 排班週期 ============
const CYCLES = {
  month: {
    name: "月曆月", days: null,
    desc: "以日曆月為一期，符合一般人與薪資作業的習慣。缺點是週與變形工時區塊會被月底切斷，"
        + "需要在「上期銜接」填入前幾天的班表才能正確接續。",
  },
  four_weeks: {
    name: "四週週期", days: 28,
    desc: "以四週（28 天）為一期，自動對齊每週起算日。四個完整的週、一個完整的變形工時區塊，"
        + "週期性規則完全不需要跨期估算。",
  },
  eight_weeks: {
    name: "八週週期", days: 56,
    desc: "以八週（56 天）為一期，適合採八週變形工時的單位。一次排兩個月份量的班。",
  },
};

function weekStartDow() {
  return schema.horizon.weekStartsOn === "monday" ? 1 : 0;
}

function snapToWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const diff = (d.getDay() - weekStartDow() + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toISODate(d);
}

function currentCycle() {
  return schema.meta?.cycleMode || "month";
}

function applyCycleMode(mode, startStr) {
  schema.meta = schema.meta || {};
  schema.meta.cycleMode = mode;
  const cfg = CYCLES[mode];
  if (cfg.days) {
    const start = snapToWeekStart(startStr || schema.horizon.start);
    schema.horizon.start = start;
    schema.horizon.end = addDays(start, cfg.days - 1);
    schema.horizon.blocks = [{ id: "cycle", start, end: schema.horizon.end, type: mode }];
  }
  saveDraft();
  renderBasic();
  toast(`已改為${cfg.name}` + (cfg.days ? "，期間與變形工時區塊已自動對齊" : ""), 3500);
}

function cycleCard() {
  const active = currentCycle();
  const card = el("div", { class: "card" },
    el("h2", {}, "排班週期"),
    el("p", { class: "hint" }, "決定一次排多長的班表。選擇週期制可讓週與變形工時區塊完整落在期間內，避免跨期估算。"));
  const row = el("div", { class: "mode-row", style: "grid-template-columns:repeat(3,1fr)" });
  for (const [key, cfg] of Object.entries(CYCLES)) {
    row.append(el("div", {
      class: "mode-option" + (active === key ? " active" : ""),
      onclick: () => applyCycleMode(key, schema.horizon.start),
    },
      el("div", { class: "mode-title" }, cfg.name,
        cfg.days ? el("span", { class: "mode-sub" }, `${cfg.days} 天`) : null),
      el("div", { class: "mode-desc" }, cfg.desc)));
  }
  card.append(row);

  // 週期健檢
  const start = new Date(schema.horizon.start + "T00:00:00");
  const end = new Date(schema.horizon.end + "T00:00:00");
  const total = Math.round((end - start) / 86400000) + 1;
  const aligned = start.getDay() === weekStartDow();
  const cfg = CYCLES[active];
  const notes = [];
  if (cfg.days) {
    notes.push(aligned ? "期間起日已對齊每週起算日" : "期間起日未對齊每週起算日，週規則會出現不完整的週");
    notes.push(total === cfg.days ? `期間長度 ${total} 天，正確`
      : `期間長度 ${total} 天，應為 ${cfg.days} 天`);
    notes.push(total % 7 === 0 && aligned ? `含 ${total / 7} 個完整的週，無跨期估算`
      : "週期不完整，部分規則需依賴上期資料");
  } else {
    const fullWeeks = Math.floor((total - ((7 - ((start.getDay() - weekStartDow() + 7) % 7)) % 7)) / 7);
    notes.push(`期間長度 ${total} 天，其中約 ${fullWeeks} 個完整的週`);
    notes.push("月初與月底的不完整週、跨月的變形工時區塊，需要「上期銜接」資料才能正確計算");
  }
  card.append(el("div", { class: "cycle-notes" },
    notes.map(n => el("div", {}, n))));
  return card;
}

// ============ 基本設定頁 ============
function renderBasic() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  const c1 = el("div", { class: "card" },
    el("h2", {}, "班表資訊"),
    el("div", { class: "grid c2" },
      field("班表名稱", textInput(schema.meta.name, v => schema.meta.name = v)),
      field("單位名稱", textInput(schema.meta.organization, v => schema.meta.organization = v))));

  const cyc = CYCLES[currentCycle()];
  const c2 = el("div", { class: "card" },
    el("h2", {}, "排班期間"),
    cyc.days ? el("p", { class: "hint" },
      "週期制下結束日由起日自動推算；變更起日時會自動對齊到每週起算日。") : null,
    el("div", { class: "grid c3" },
      field("開始日", dateInput(schema.horizon.start, v => {
        if (cyc.days) applyCycleMode(currentCycle(), v);
        else schema.horizon.start = v;
      })),
      cyc.days
        ? field("結束日（自動）", el("input", { type: "date", value: schema.horizon.end, disabled: "" }))
        : field("結束日", dateInput(schema.horizon.end, v => schema.horizon.end = v)),
      field("一週起算日", selectInput(schema.horizon.weekStartsOn,
        [["sunday", "週日（勞基法慣例）"], ["monday", "週一"]],
        v => {
          schema.horizon.weekStartsOn = v;
          if (cyc.days) applyCycleMode(currentCycle(), schema.horizon.start);
        }))));

  schema.horizon.blocks = schema.horizon.blocks || [];
  const blkBody = el("tbody");
  const renderBlocks = () => {
    blkBody.innerHTML = "";
    schema.horizon.blocks.forEach((b, i) => {
      blkBody.append(el("tr", {},
        el("td", {}, textInput(b.id, v => b.id = v, { style: "width:80px" })),
        el("td", {}, dateInput(b.start, v => b.start = v)),
        el("td", {}, dateInput(b.end, v => b.end = v)),
        el("td", {}, selectInput(b.type, [["four_weeks", "四週"], ["eight_weeks", "八週"], ["two_weeks", "二週"]], v => b.type = v)),
        el("td", {}, el("button", { class: "small danger", onclick: () => { schema.horizon.blocks.splice(i, 1); renderBlocks(); saveDraft(); } }, "刪除"))));
    });
  };
  renderBlocks();
  const c3 = el("div", { class: "card" },
    el("h2", {}, "變形工時區塊"),
    el("p", { class: "hint" }, "採四週或八週變形工時者，填寫核備的區塊起訖日期，可跨月，引擎會自動裁切。未採用者留空即可。"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["代號", "起", "訖", "類型", ""].map(h => el("th", {}, h)))), blkBody),
    el("button", { class: "small mt", onclick: () => { schema.horizon.blocks.push({ id: "blk" + (schema.horizon.blocks.length + 1), start: schema.horizon.start, end: schema.horizon.end, type: "four_weeks" }); renderBlocks(); saveDraft(); } }, "新增區塊"));

  schema.calendar = schema.calendar || { holidays: [] };
  const holBody = el("tbody");
  const renderHols = () => {
    holBody.innerHTML = "";
    (schema.calendar.holidays || []).forEach((h, i) => {
      holBody.append(el("tr", {},
        el("td", {}, dateInput(h.date, v => h.date = v)),
        el("td", {}, textInput(h.name, v => h.name = v)),
        el("td", {}, el("button", { class: "small danger", onclick: () => { schema.calendar.holidays.splice(i, 1); renderHols(); saveDraft(); } }, "刪除"))));
    });
  };
  renderHols();
  const c4 = el("div", { class: "card" },
    el("h2", {}, "國定假日"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["日期", "名稱", ""].map(h => el("th", {}, h)))), holBody),
    el("button", { class: "small mt", onclick: () => { schema.calendar.holidays.push({ date: schema.horizon.start, name: "" }); renderHols(); saveDraft(); } }, "新增假日"));

  if (cyc.days) {
    c3.style.display = "none";   // 週期制的區塊由系統自動管理
  }
  root.append(cycleCard(), c1, c2, c3, c4);
}

// ============ 班別頁 ============
function renderShifts() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  const body = el("tbody");
  schema.shifts.forEach((s, i) => {
    body.append(el("tr", {},
      el("td", {}, textInput(s.id, v => s.id = v, { style: "width:90px" })),
      el("td", {}, textInput(s.name, v => s.name = v, { style: "width:90px" })),
      el("td", {}, selectInput(s.kind, [["work", "工作班"], ["rest", "休息"], ["leave", "請假"]], v => { s.kind = v; renderShifts(); })),
      el("td", {}, s.kind === "work" ? el("input", { type: "time", value: s.start || "", onchange: e => { s.start = e.target.value; saveDraft(); } }) : el("span", { class: "muted" }, "—")),
      el("td", {}, s.kind === "work" ? el("input", { type: "time", value: s.end || "", onchange: e => { s.end = e.target.value; saveDraft(); } }) : el("span", { class: "muted" }, "—")),
      el("td", {}, numInput(s.hours, v => s.hours = v ?? 0, { style: "width:64px", min: 0 })),
      el("td", {}, numInput(s.overtimeHours, v => s.overtimeHours = v ?? 0, { style: "width:64px", min: 0 })),
      el("td", {}, textInput((s.tags || []).join(","), v => s.tags = v.split(",").map(x => x.trim()).filter(Boolean), { placeholder: "night" })),
      el("td", {}, el("button", { class: "small danger", onclick: () => { schema.shifts.splice(i, 1); renderShifts(); saveDraft(); } }, "刪除"))));
  });

  root.append(el("div", { class: "card" },
    el("h2", {}, "班別定義"),
    el("p", { class: "hint" }, "工作班需填起訖時間，系統據此自動計算輪班間隔。跨日班（如大夜 00:00 至 08:00）視為標示日的隔日凌晨開始。標籤供規則引用，例如夜班標 night。"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["代碼", "名稱", "類型", "上班", "下班", "工時", "加班時數", "標籤", ""].map(h => el("th", {}, h)))),
      body),
    el("button", { class: "small mt", onclick: () => { schema.shifts.push({ id: "S" + (schema.shifts.length + 1), name: "", kind: "work", start: "08:00", end: "16:00", hours: 8, overtimeHours: 0, tags: [] }); renderShifts(); saveDraft(); } }, "新增班別")));
}

// ============ 人員頁 ============
function renderStaff() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  const wIds = workShifts().map(s => s.id);
  const empOptions = () => [["", "（無）"], ...schema.employees.map(e => [e.id, `${e.id} ${e.name}`])];

  const body = el("tbody");
  schema.employees.forEach((e, i) => {
    e.attributes = e.attributes || {};
    const allowedBox = el("div", { class: "row", style: "gap:6px" });
    for (const sid of wIds) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !e.allowedShifts || e.allowedShifts.includes(sid);
      cb.addEventListener("change", () => {
        let set = e.allowedShifts ? [...e.allowedShifts] : [...wIds];
        if (cb.checked) { if (!set.includes(sid)) set.push(sid); }
        else set = set.filter(x => x !== sid);
        e.allowedShifts = set.length === wIds.length ? null : set;
        saveDraft();
      });
      allowedBox.append(el("label", { style: "font-size:12px;display:inline-flex;gap:3px;align-items:center" }, cb, sid));
    }

    body.append(el("tr", {},
      el("td", {}, textInput(e.id, v => e.id = v, { style: "width:70px" })),
      el("td", {}, textInput(e.name, v => e.name = v, { style: "width:96px" })),
      el("td", {}, selectInput(e.level, [["regular", "正職"], ["support", "支援"], ["virtual", "虛擬"]], v => e.level = v)),
      el("td", {}, textInput(e.attributes.title, v => e.attributes.title = v, { style: "width:80px" })),
      el("td", {}, numInput(e.attributes.seniorityYears, v => e.attributes.seniorityYears = v ?? 0, { style: "width:64px", step: "0.1", min: 0 })),
      el("td", {}, textInput(e.attributes.group, v => e.attributes.group = v || null, { style: "width:52px" })),
      el("td", {}, selectInput(e.attributes.defaultShift || "", [["", "（無）"], ...wIds.map(x => [x, x])], v => e.attributes.defaultShift = v || null)),
      el("td", {}, selectInput(e.attributes.mentorId || "", empOptions(), v => e.attributes.mentorId = v || null)),
      el("td", {}, allowedBox),
      el("td", {}, textInput((e.skills || []).join(","), v => e.skills = v.split(",").map(x => x.trim()).filter(Boolean), { style: "width:88px", placeholder: "ACLS" })),
      el("td", {}, (() => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = !!e.attributes.pregnant;
        cb.addEventListener("change", () => { e.attributes.pregnant = cb.checked || undefined; saveDraft(); });
        return cb;
      })()),
      el("td", {}, el("button", { class: "small danger", onclick: () => { schema.employees.splice(i, 1); renderStaff(); saveDraft(); } }, "刪除"))));
  });

  root.append(el("div", { class: "card" },
    el("h2", {}, `人員名單（${schema.employees.length} 人）`),
    el("p", { class: "hint" }, "年資供資深搭配規則使用；預設班別供包班與偏好使用；小組供同組不同休使用；取消勾選可上班別可限制輪班範圍。懷孕者請同時到「預班與請假」設定整月禁排夜班。"),
    el("div", { style: "overflow-x:auto" },
      el("table", { class: "editor" },
        el("thead", {}, el("tr", {}, ["編號", "姓名", "類型", "職稱", "年資", "小組", "預設班別", "帶領者", "可上班別", "技能", "懷孕", ""].map(h => el("th", {}, h)))),
        body)),
    el("div", { class: "row mt" },
      el("button", { class: "small", onclick: () => {
        schema.employees.push({ id: "N" + String(schema.employees.length + 1).padStart(3, "0"), name: "", level: "regular", attributes: { title: "護理師", seniorityYears: 0, isNew: false, group: null, defaultShift: null, mentorId: null }, skills: [], exemptions: [] });
        renderStaff(); saveDraft();
      } }, "新增人員"),
      xlsxButton("從 Excel 匯入名單", "staff", (data) => {
        let added = 0, updated = 0;
        for (const inc of data.employees) {
          const cur = schema.employees.find(e => e.id === inc.id);
          if (cur) {
            cur.name = inc.name || cur.name;
            cur.attributes = { ...cur.attributes, ...inc.attributes };
            if (inc.skills.length) cur.skills = inc.skills;
            updated++;
          } else { schema.employees.push(inc); added++; }
        }
        saveDraft(); renderStaff();
        toast(`Excel 匯入完成：新增 ${added} 人、更新 ${updated} 人`, 3500);
      }),
      (() => {
        const label = el("label", { class: "btn-like small", style: "font-size:12px" }, "從 CSV 匯入");
        const input = el("input", { type: "file", accept: ".csv,.txt", hidden: "" });
        input.addEventListener("change", async () => {
          if (input.files[0]) { await importStaffCSV(input.files[0]); input.value = ""; }
        });
        label.append(input);
        return label;
      })(),
      el("button", { class: "small", onclick: downloadStaffTemplate }, "下載匯入範本"))));
}

async function uploadXlsx(kind, file) {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  const start = new Date(schema.horizon.start + "T00:00:00");
  fd.append("year", start.getFullYear());
  fd.append("month", start.getMonth() + 1);
  const res = await fetch("/api/import/xlsx", { method: "POST", body: fd });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function xlsxButton(label, kind, onDone) {
  const wrap = el("label", { class: "btn-like small", style: "font-size:12px" }, label);
  const input = el("input", { type: "file", accept: ".xlsx,.xlsm", hidden: "" });
  input.addEventListener("change", async () => {
    const f = input.files[0];
    input.value = "";
    if (!f) return;
    try {
      toast("解析中…");
      const data = await uploadXlsx(kind, f);
      onDone(data);
    } catch (e) { toast("匯入失敗：" + e.message, 4500); }
  });
  wrap.append(input);
  return wrap;
}

function downloadStaffTemplate() {
  const csv = "﻿編號,姓名,職稱,年資,小組,預設班別,技能\r\nN001,王小明,護理師,3.5,A,D,ACLS\r\nN002,李小華,護理師,0.5,B,E,\r\n";
  const a = el("a", {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
    download: "人員匯入範本.csv",
  });
  a.click();
}

async function importStaffCSV(file) {
  let text = await file.text();
  text = text.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { toast("檔案沒有資料列"); return; }
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ""));
  const idx = name => headers.findIndex(h => h === name);
  const col = { id: idx("編號"), name: idx("姓名"), title: idx("職稱"), seniority: idx("年資"),
                group: idx("小組"), defaultShift: idx("預設班別"), skills: idx("技能") };
  if (col.id < 0) { toast("找不到「編號」欄位，請使用匯入範本格式"); return; }
  let added = 0, updated = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
    const id = cells[col.id];
    if (!id) continue;
    const get = c => (c >= 0 && cells[c] !== undefined ? cells[c] : "");
    let emp = schema.employees.find(e => e.id === id);
    if (!emp) {
      emp = { id, name: "", level: "regular", attributes: {}, skills: [], exemptions: [] };
      schema.employees.push(emp);
      added++;
    } else { updated++; }
    emp.attributes = emp.attributes || {};
    if (col.name >= 0) emp.name = get(col.name);
    if (col.title >= 0) emp.attributes.title = get(col.title);
    if (col.seniority >= 0 && get(col.seniority) !== "") emp.attributes.seniorityYears = Number(get(col.seniority)) || 0;
    if (col.group >= 0) emp.attributes.group = get(col.group) || null;
    if (col.defaultShift >= 0) emp.attributes.defaultShift = get(col.defaultShift) || null;
    if (col.skills >= 0) emp.skills = get(col.skills).split(/[;、,]/).map(s => s.trim()).filter(Boolean);
  }
  saveDraft();
  renderStaff();
  toast(`匯入完成：新增 ${added} 人、更新 ${updated} 人`);
}

// ============ 需求頁 ============
function getWeekendDelta(dem) {
  const adj = (dem.adjustments || []).find(a => (a.daysOfWeek || []).includes("sat") && (a.daysOfWeek || []).includes("sun"));
  return adj ? adj.delta : 0;
}
function setWeekendDelta(dem, delta) {
  dem.adjustments = (dem.adjustments || []).filter(a => !((a.daysOfWeek || []).includes("sat") && (a.daysOfWeek || []).includes("sun")));
  if (delta) dem.adjustments.push({ daysOfWeek: ["sat", "sun"], delta });
}

function renderDemands() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }
  const wIds = workShifts().map(s => s.id);

  const body = el("tbody");
  schema.demands.forEach((d, i) => {
    const isQualified = d.minQualified != null;
    body.append(el("tr", {},
      el("td", {}, selectInput(d.shiftId, wIds.map(x => [x, x]), v => d.shiftId = v)),
      el("td", {}, isQualified
        ? el("span", { class: "chip" }, `年資達標者至少 ${d.minQualified} 人`)
        : numInput(d.min, v => d.min = v, { style: "width:64px", min: 0 })),
      el("td", {}, isQualified ? el("span", { class: "muted" }, "—") : numInput(d.max, v => d.max = v, { style: "width:64px", min: 0 })),
      el("td", {}, isQualified ? el("span", { class: "muted" }, "—") : numInput(getWeekendDelta(d), v => setWeekendDelta(d, v ?? 0), { style: "width:64px" })),
      el("td", {}, isQualified && d.qualifier ? numInput(d.qualifier.value, v => d.qualifier.value = v ?? 0, { style: "width:64px", step: "0.5" }) : el("span", { class: "muted" }, "—")),
      el("td", {}, isQualified ? numInput(d.minQualified, v => d.minQualified = v ?? 1, { style: "width:56px", min: 0 }) : el("span", { class: "muted" }, "—")),
      el("td", {}, selectInput(d.enforcement, [["hard", "硬性"], ["soft", "軟性"]], v => { d.enforcement = v; renderDemands(); })),
      el("td", {}, d.enforcement === "soft" ? numInput(d.weight, v => d.weight = v ?? 100, { style: "width:64px" }) : el("span", { class: "muted" }, "—")),
      el("td", {}, el("button", { class: "small danger", onclick: () => { schema.demands.splice(i, 1); renderDemands(); saveDraft(); } }, "刪除"))));
  });

  root.append(el("div", { class: "card" },
    el("h2", {}, "每日人力需求"),
    el("p", { class: "hint" }, "各班別每日最低人數。「週末增減」加在週六日的最低人數上，例如 -1 表示週末少一人。資格需求列可要求該班達到年資門檻的人數。"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["班別", "最低人數", "上限", "週末增減", "年資門檻", "資格人數", "硬性/軟性", "權重", ""].map(h => el("th", {}, h)))),
      body),
    el("div", { class: "row mt" },
      el("button", { class: "small", onclick: () => { schema.demands.push({ shiftId: wIds[0], min: 1, adjustments: [], enforcement: "hard", weight: 100 }); renderDemands(); saveDraft(); } }, "新增人數需求"),
      el("button", { class: "small", onclick: () => { schema.demands.push({ shiftId: wIds[0], min: 1, qualifier: { field: "seniorityYears", op: ">=", value: 2 }, minQualified: 1, enforcement: "hard", weight: 100 }); renderDemands(); saveDraft(); } }, "新增資格需求"))));
}

// ============ 規則頁 ============
function renderRules() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  // 排班取向
  const active = detectMode();
  const modeCard = el("div", { class: "card" },
    el("h2", {}, "排班取向"),
    el("p", { class: "hint" }, "決定在滿足所有法規與人力需求之後，多出來的人力要拿去排班還是排休。這會同時調整下方「偏好預設班別」與「人力成本計價」兩條規則。"));
  const modeRow = el("div", { class: "mode-row" });
  for (const [key, m] of Object.entries(MODES)) {
    modeRow.append(el("div", {
      class: "mode-option" + (active === key ? " active" : ""),
      onclick: () => applyMode(key),
    },
      el("div", { class: "mode-title" }, m.name, el("span", { class: "mode-sub" }, m.subtitle)),
      el("div", { class: "mode-desc" }, m.desc)));
  }
  modeCard.append(modeRow);
  if (active === "custom") {
    modeCard.append(el("p", { class: "muted mt", style: "font-size:12px" },
      "目前為自訂設定（權重已手動調整過）。點選上方任一取向可套用標準組合。"));
  }
  root.append(modeCard);

  const card = el("div", { class: "card" },
    el("h2", {}, "規則清單"),
    el("p", { class: "hint" }, "硬性規則必須滿足，找不到解時會列入衝突診斷；軟性規則盡量滿足，違反會依權重扣分。"));

  schema.constraints.forEach((c) => {
    const info = BLOCK_INFO[c.block] || { name: c.block, desc: "" };
    const row = el("div", { class: "rule-row" + (c.enabled ? "" : " disabled") });

    // 參數：純量值直接給欄位，巢狀結構收在進階 JSON
    const params = c.params || {};
    const flatKeys = Object.keys(params).filter(k => ["number", "string", "boolean"].includes(typeof params[k]));
    const complexKeys = Object.keys(params).filter(k => !flatKeys.includes(k));
    const paramFields = el("div", { class: "param-fields" });
    for (const k of flatKeys) {
      const label = PARAM_LABELS[k] || k;
      const v = params[k];
      if (typeof v === "number") {
        paramFields.append(field(label, numInput(v, nv => { params[k] = nv ?? v; }, { step: "any" })));
      } else if (typeof v === "boolean") {
        paramFields.append(field(label, selectInput(String(v), [["true", "是"], ["false", "否"]], nv => params[k] = nv === "true")));
      } else {
        paramFields.append(field(label, textInput(v, nv => params[k] = nv)));
      }
    }

    const paramsArea = el("textarea", { rows: 3 }, JSON.stringify(params, null, 1));
    const applyBtn = el("button", { class: "small", onclick: () => {
      try { c.params = JSON.parse(paramsArea.value); toast("已更新參數"); saveDraft(); renderRules(); }
      catch { toast("JSON 格式錯誤"); }
    } }, "套用");

    const weightInput = numInput(c.weight, v => c.weight = v, { style: "width:76px", placeholder: "權重" });
    weightInput.style.display = c.enforcement === "soft" ? "" : "none";

    row.append(
      el("div", { class: "rule-head" },
        checkbox(c.enabled, v => { c.enabled = v; row.classList.toggle("disabled", !v); }),
        el("div", { class: "name" }, info.name, el("small", {}, info.desc)),
        selectInput(c.enforcement, [["hard", "硬性"], ["soft", "軟性"]], v => {
          c.enforcement = v;
          weightInput.style.display = v === "soft" ? "" : "none";
          saveDraft();
        }),
        weightInput),
      flatKeys.length ? paramFields : null,
      el("details", { class: "adv" },
        el("summary", {}, "進階（JSON 參數與適用範圍）"),
        el("div", { class: "mt" }, paramsArea, el("div", { class: "right mt" }, applyBtn),
          c.scope ? el("p", { class: "muted", style: "font-size:12px" }, "適用範圍：" + JSON.stringify(c.scope)) : null,
          complexKeys.length ? el("p", { class: "muted", style: "font-size:12px" }, "含巢狀參數：" + complexKeys.join(", ")) : null)));
    card.append(row);
  });

  const blockOptions = Object.entries(BLOCK_INFO).map(([k, v]) => [k, v.name]);
  let newBlock = blockOptions[0][0];
  card.append(el("div", { class: "row mt" },
    selectInput(newBlock, blockOptions, v => newBlock = v),
    el("button", { class: "small", onclick: () => {
      schema.constraints.push({ id: "c-" + Math.random().toString(36).slice(2, 7), block: newBlock, enabled: true, enforcement: "hard", params: {} });
      renderRules(); saveDraft();
    } }, "新增規則")));
  root.append(card);
}

// ============ 預班/請假頁 ============
function paType(pa) {
  if (pa.forbid) return "forbid";
  return pa.mode === "prefer" ? "prefer" : "lock";
}

function renderPrefill() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }
  const empOpts = schema.employees.map(e => [e.id, `${e.id} ${e.name}`]);
  const shiftOpts = allShiftIds();

  const body = el("tbody");
  schema.preAssignments.forEach((pa, i) => {
    const type = paType(pa);
    const shifts = pa.forbid || pa.assign || [];
    const shiftBox = el("div", { class: "row", style: "gap:6px" });
    for (const sid of shiftOpts) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = shifts.includes(sid);
      cb.addEventListener("change", () => {
        let set = [...(pa.forbid || pa.assign || [])];
        if (cb.checked) set.push(sid); else set = set.filter(x => x !== sid);
        if (pa.forbid) pa.forbid = set; else pa.assign = set;
        saveDraft();
      });
      shiftBox.append(el("label", { style: "font-size:11px;display:inline-flex;gap:2px" }, cb, sid));
    }
    const isRange = !!pa.dateRange;
    body.append(el("tr", {},
      el("td", {}, selectInput(pa.employeeId, empOpts, v => pa.employeeId = v)),
      el("td", {}, selectInput(type, [["lock", "指定（鎖定）"], ["prefer", "偏好（軟性）"], ["forbid", "禁排"]], v => {
        const cur = pa.forbid || pa.assign || [];
        delete pa.forbid; delete pa.assign;
        if (v === "forbid") { pa.forbid = cur; pa.mode = "lock"; }
        else { pa.assign = cur; pa.mode = v; }
        renderPrefill(); saveDraft();
      })),
      el("td", {}, isRange
        ? el("div", { class: "row" },
            dateInput(pa.dateRange[0], v => pa.dateRange[0] = v), "至",
            dateInput(pa.dateRange[1], v => pa.dateRange[1] = v))
        : dateInput(pa.date, v => pa.date = v)),
      el("td", {}, (() => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = isRange;
        cb.addEventListener("change", () => {
          if (cb.checked) { pa.dateRange = [pa.date || schema.horizon.start, schema.horizon.end]; delete pa.date; }
          else { pa.date = pa.dateRange?.[0] || schema.horizon.start; delete pa.dateRange; }
          renderPrefill(); saveDraft();
        });
        return cb;
      })()),
      el("td", {}, shiftBox),
      el("td", {}, type === "prefer" ? numInput(pa.weight, v => pa.weight = v ?? 30, { style: "width:60px" }) : el("span", { class: "muted" }, "—")),
      el("td", {}, el("button", { class: "small danger", onclick: () => { schema.preAssignments.splice(i, 1); renderPrefill(); saveDraft(); } }, "刪除"))));
  });

  root.append(el("div", { class: "card" },
    el("h2", {}, "預班、請假與禁排"),
    el("p", { class: "hint" }, "「指定」表示該日必為所選班別之一（請假請選假別班）；「偏好」表示盡量排入；「禁排」表示該期間不得排所選班別，例如懷孕禁夜班。勾選「區間」可設定連續日期範圍。"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["人員", "類型", "日期", "區間", "班別", "權重", ""].map(h => el("th", {}, h)))),
      body),
    el("div", { class: "row mt" },
      el("button", { class: "small", onclick: () => {
        schema.preAssignments.push({ employeeId: schema.employees[0]?.id, date: schema.horizon.start, assign: [], mode: "lock", weight: 30 });
        renderPrefill(); saveDraft();
      } }, "新增"),
      xlsxButton("從 Excel 匯入預班表", "preassign", (data) => {
        const known = new Set(schema.employees.map(e => e.id));
        const knownShifts = new Set(allShiftIds());
        const ok = data.entries.filter(x => known.has(x.employeeId) && knownShifts.has(x.assign[0]));
        const badEmp = [...new Set(data.employeesSeen.filter(x => !known.has(x)))];
        const badShift = data.shiftsSeen.filter(s => !knownShifts.has(s));
        schema.preAssignments.push(...ok);
        saveDraft(); renderPrefill();
        let msg = `匯入 ${ok.length} 筆預班`;
        if (badEmp.length) msg += `；查無人員 ${badEmp.slice(0, 3).join("、")}${badEmp.length > 3 ? "…" : ""}`;
        if (badShift.length) msg += `；查無班別 ${badShift.slice(0, 3).join("、")}`;
        toast(msg, 5000);
      }))));
}

// ============ 上期銜接頁 ============
function toISODate(d) {
  // 不可用 toISOString()：那會轉成 UTC，在 UTC+8 會整個掉一天
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function renderHistory() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  schema.history = schema.history || [];

  // 需要幾天：一般跨期規則看前 7 天就夠；但若有變形工時區塊往前跨月，
  // 必須涵蓋整個區塊在上期的那一段，否則工時只能用比例估算
  let needed = 7;
  for (const b of schema.horizon.blocks || []) {
    if (b.start < schema.horizon.start) {
      const gap = Math.round((new Date(schema.horizon.start + "T00:00:00")
        - new Date(b.start + "T00:00:00")) / 86400000);
      needed = Math.max(needed, gap);
    }
  }
  needed = Math.min(needed, 31);
  const days = [...Array(needed)].map((_, i) => addDays(schema.horizon.start, i - needed));
  const shiftOpts = [["", "（無資料）"], ...allShiftIds().map(x => [x, x])];

  const lookup = {};
  for (const h of schema.history) lookup[h.employeeId + "|" + h.date] = h.shiftId;

  const setHist = (empId, date, sid) => {
    schema.history = schema.history.filter(h => !(h.employeeId === empId && h.date === date));
    if (sid) schema.history.push({ employeeId: empId, date, shiftId: sid });
    saveDraft();
  };

  const body = el("tbody");
  for (const e of schema.employees) {
    const row = el("tr", {}, el("td", {}, `${e.id} ${e.name || ""}`));
    for (const d of days) {
      row.append(el("td", {},
        selectInput(lookup[e.id + "|" + d] || "", shiftOpts, v => setHist(e.id, d, v))));
    }
    body.append(row);
  }

  const filled = new Set((schema.history || []).map(h => h.employeeId));
  const blockNote = needed > 7
    ? `因為設定了跨月的變形工時區塊，需要往前填到 ${needed} 天，工時才能精確累計；`
      + `未填的日子系統會以比例估算，可能低估或高估已上工時。`
    : "一般跨期規則往前看 7 天即足夠。";

  root.append(el("div", { class: "card" },
    el("h2", {}, `上期期末班表（前 ${needed} 天）`),
    el("p", { class: "hint" },
      "填入上期最後幾天的實際班表後，系統會把七休一、連續工作上限、連續夜班、輪班間隔、"
      + "週工時、變形工時與假別配額的計算跨月接續。" + blockNote
      + "完全沒填的人視為無上期資料，不做跨月檢核；填了任一天即啟用。"),
    el("p", { class: "hint", style: "margin-top:-8px" },
      `目前已填：${filled.size} / ${schema.employees.length} 人`),
    el("div", { style: "overflow-x:auto" },
      el("table", { class: "editor" },
        el("thead", {}, el("tr", {},
          el("th", {}, "人員"),
          days.map(d => {
            const dt = new Date(d + "T00:00:00");
            return el("th", {}, `${dt.getMonth() + 1}/${dt.getDate()}（${WEEKDAY_ZH[dt.getDay()]}）`);
          }))),
        body)),
    el("div", { class: "row mt" },
      xlsxButton("從 Excel 匯入上期班表", "history", (data) => {
        const known = new Set(schema.employees.map(e => e.id));
        const knownShifts = new Set(allShiftIds());
        const ok = data.entries.filter(x => known.has(x.employeeId) && knownShifts.has(x.shiftId));
        // 同人同日以匯入資料覆蓋
        const keys = new Set(ok.map(x => x.employeeId + "|" + x.date));
        schema.history = (schema.history || []).filter(h => !keys.has(h.employeeId + "|" + h.date));
        schema.history.push(...ok);
        saveDraft(); renderHistory();
        const skipped = data.entries.length - ok.length;
        toast(`匯入 ${ok.length} 筆上期班表${skipped ? `，略過 ${skipped} 筆無法對應的資料` : ""}`, 4000);
      }),
      el("button", { class: "small danger", onclick: () => {
        if (!confirm("清空所有上期班表資料？")) return;
        schema.history = [];
        saveDraft(); renderHistory();
      } }, "全部清空"))));
}

// ============ 班表檢核 ============
let auditResult = null;
let auditSource = "";
let liveViolations = [];   // 手動微調後的即時檢核結果
let checkTimer = null;
let lintIssues = [];       // 設定健檢結果

async function runCheck(assignments) {
  return postJSON("/api/check", { schema, assignments });
}

function assignmentsFromResult() {
  return (lastResult?.assignments || []).map(a => ({
    employeeId: a.employeeId, date: a.date, shiftId: a.shiftId,
  }));
}

function scheduleLiveCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    if (!lastResult?.assignments?.length) return;
    try {
      const r = await runCheck(assignmentsFromResult());
      liveViolations = r.violations;
      renderResult();
    } catch { /* 檢核失敗不影響編輯 */ }
  }, 400);
}

function violationList(violations) {
  const list = el("div", { class: "viol-list" });
  for (const v of violations) {
    list.append(el("div", { class: "viol-item" },
      el("span", { class: "who" }, v.employeeId || "全體"),
      el("span", {}, v.message)));
  }
  return list;
}

const BLOCK_LABEL = (b) => BLOCK_INFO[b]?.name
  || ({ demand_coverage: "人力需求", pre_assignment: "預班指定", unavailable: "禁排" })[b]
  || b;

function renderAudit() {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  const card = el("div", { class: "card" },
    el("h2", {}, "選擇要檢核的班表"),
    el("p", { class: "hint" },
      "檢核會逐條比對所有硬性規則，指出違反的人、日期與原因。"
      + "可以用來檢查系統排出來的班表，也可以匯入人工排的班表——"
      + "不需要改變原本的作業方式，就能先看出現行班表有沒有合規風險。"),
    el("div", { class: "row" },
      el("button", {
        class: "primary",
        onclick: async () => {
          if (!lastResult?.assignments?.length) { toast("目前沒有排班結果"); return; }
          try {
            auditResult = await runCheck(assignmentsFromResult());
            auditSource = "目前的排班結果";
            renderAudit();
          } catch (e) { toast("檢核失敗：" + e.message); }
        },
      }, "檢核目前的排班結果"),
      xlsxButton("匯入 Excel 班表並檢核", "history", async (data) => {
        const known = new Set(schema.employees.map(e => e.id));
        const knownShifts = new Set(allShiftIds());
        const ok = data.entries.filter(x => known.has(x.employeeId) && knownShifts.has(x.shiftId));
        const skipped = data.entries.length - ok.length;
        if (!ok.length) { toast("匯入的班表沒有任何可對應的資料"); return; }
        try {
          auditResult = await runCheck(ok);
          auditSource = `匯入的 Excel 班表（${ok.length} 格`
            + (skipped ? `，略過 ${skipped} 格無法對應` : "") + "）";
          renderAudit();
        } catch (e) { toast("檢核失敗：" + e.message); }
      })));
  root.append(card);

  if (!auditResult) {
    root.append(el("div", { class: "card empty-state" },
      el("div", { class: "big" }, "尚未檢核"),
      el("div", {}, "選擇上方任一來源開始。匯入的 Excel 請用第一欄放人員編號、第一列放日期的格式。")));
    return;
  }

  const total = auditResult.total;
  root.append(el("div", { class: `status-banner ${total ? "bad" : "ok"}` },
    total === 0
      ? `完全合規：檢查了 ${auditResult.checkedAssignments} 格班別，沒有發現任何違反硬性規則的情形`
      : `發現 ${total} 項違規（來源：${auditSource}）`));

  if (total) {
    const rows = el("tbody");
    for (const [block, n] of Object.entries(auditResult.byBlock)
      .sort((a, b) => b[1] - a[1])) {
      rows.append(el("tr", {},
        el("td", {}, BLOCK_LABEL(block)),
        el("td", { class: "right" }, String(n)),
        el("td", { class: "muted" }, BLOCK_INFO[block]?.desc || "")));
    }
    root.append(el("div", { class: "card" },
      el("h2", {}, "違規類型統計"),
      el("table", { class: "editor" },
        el("thead", {}, el("tr", {}, ["規則", "筆數", "說明"].map(h => el("th", {}, h)))),
        rows)));
    root.append(el("div", { class: "card" },
      el("h2", {}, "違規明細"),
      violationList(auditResult.violations)));
  }
}

// ============ 求解與結果 ============
const WORK_PALETTE = [
  { bg: "#e3efeb", fg: "#0c5f4e" },
  { bg: "#fbf0dd", fg: "#8a5905" },
  { bg: "#e7e7f9", fg: "#4740a8" },
  { bg: "#fde8ef", fg: "#a83368" },
  { bg: "#e2f1f8", fg: "#0b6285" },
  { bg: "#eef4dd", fg: "#55700e" },
  { bg: "#f9e5e2", fg: "#a13c2e" },
  { bg: "#e5f3f0", fg: "#0f766e" },
];
const REST_STYLE = { bg: "#f1f3f6", fg: "#7d8a9c" };
const LEAVE_STYLE = { bg: "#f3eaf8", fg: "#7b3f9e" };

function shiftStyle(sid) {
  const shift = schema.shifts.find(s => s.id === sid);
  if (!shift) return REST_STYLE;
  if (shift.kind === "rest") return REST_STYLE;
  if (shift.kind === "leave") return LEAVE_STYLE;
  const idx = workShifts().findIndex(s => s.id === sid);
  return WORK_PALETTE[idx % WORK_PALETTE.length];
}

function shortLabel(sid) {
  const shift = schema.shifts.find(s => s.id === sid);
  if (!shift) return sid;
  if (shift.kind !== "work") {
    if (sid.includes("REG")) return "例";
    if (sid.includes("FLX")) return "休";
    if (sid.includes("NAT")) return "國";
    return shift.name?.slice(0, 2) || sid.slice(0, 3);
  }
  return sid;
}

async function startSolve() {
  if (!schema) { toast("請先載入模板"); return; }
  if (solving) return;
  gotoTab("result");
  try {
    solving = true;
    $("#btn-solve").disabled = true;
    await startSolveInner();
  } catch (e) {
    solving = false;
    $("#btn-solve").disabled = false;
    renderResult({ banner: "排班請求失敗：" + e.message, kind: "bad" });
  }
}

async function startSolveInner() {
  const v = await postJSON("/api/validate", schema);
  if (!v.valid) { solving = false; $("#btn-solve").disabled = false; renderResult({ banner: "設定檔驗證失敗：" + v.detail, kind: "bad" }); return; }
  lintIssues = v.issues || [];
  const { jobId } = currentScheduleId
    ? await postJSON(`/api/schedules/${currentScheduleId}/solve`, { schema })
    : await postJSON("/api/solve", schema);
  renderResult({ banner: "排班計算中，依規模需要數十秒", kind: "run" });
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      if (job.state === "running") {
        renderResult({ banner: job.progress || "排班計算中", kind: "run" });
      } else {
        clearInterval(pollTimer);
        solving = false;
        $("#btn-solve").disabled = false;
        lastResult = job.result;
        resultPristine = JSON.stringify(job.result);
        manualEdits = {};
        saveResult();
        renderResult();
      }
    } catch (e) {
      clearInterval(pollTimer);
      solving = false;
      $("#btn-solve").disabled = false;
      renderResult({ banner: "查詢失敗：" + e.message, kind: "bad" });
    }
  }, 1200);
}

function editCell(td, empId, dateStr, currentSid) {
  if (td.querySelector("select")) return;
  const sel = el("select", { style: "min-width:80px;font-size:12px" },
    allShiftIds().map(sid => el("option", { value: sid, ...(sid === currentSid ? { selected: "" } : {}) }, sid)));
  td.innerHTML = "";
  td.append(sel);
  sel.focus();
  const done = (commit) => {
    if (commit && sel.value !== currentSid) {
      const a = lastResult.assignments.find(x => x.employeeId === empId && x.date === dateStr);
      if (a) a.shiftId = sel.value;
      manualEdits[empId + "|" + dateStr] = sel.value;
      saveResult();
      scheduleLiveCheck();
    }
    renderResult();
  };
  sel.addEventListener("change", () => done(true));
  sel.addEventListener("blur", () => done(false));
  sel.addEventListener("keydown", ev => { if (ev.key === "Escape") done(false); });
}

function applyManualEdits() {
  // 把手動修改轉成鎖定預班，再重新求解（其餘格子由引擎重排以維持合法性）
  for (const [key, sid] of Object.entries(manualEdits)) {
    const [employeeId, date] = key.split("|");
    schema.preAssignments = schema.preAssignments.filter(
      pa => !(pa.note === "manual-edit" && pa.employeeId === employeeId && pa.date === date));
    schema.preAssignments.push({ employeeId, date, assign: [sid], mode: "lock", weight: 30, note: "manual-edit" });
  }
  manualEdits = {};
  saveDraft();
  toast("已鎖定修改，重新排班中");
  startSolve();
}

function revertManualEdits() {
  if (resultPristine) lastResult = JSON.parse(resultPristine);
  manualEdits = {};
  liveViolations = [];
  saveResult();
  renderResult();
}

function requiredFor(shiftId, dateStr) {
  // 依需求表計算某班別某日的最低需求（供覆蓋列顯示）
  const d = new Date(dateStr + "T00:00:00");
  const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
  const holidaySet = new Set((schema.calendar?.holidays || []).map(h => h.date));
  let req = null;
  for (const dem of schema.demands) {
    if (dem.shiftId !== shiftId || dem.min == null || dem.minQualified != null) continue;
    if (dem.except?.holidays && holidaySet.has(dateStr)) continue;
    let delta = 0;
    for (const adj of dem.adjustments || []) {
      if ((adj.daysOfWeek || []).includes(wd) || (adj.dates || []).includes(dateStr)) delta += adj.delta;
    }
    const need = Math.max(0, dem.min + delta);
    req = req === null ? need : Math.max(req, need);
  }
  return req;
}

async function exportXlsx() {
  if (!lastResult?.assignments?.length) { toast("尚無班表可匯出"); return; }
  try {
    const res = await fetch("/api/export/xlsx", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem: schema, result: lastResult }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const blob = await res.blob();
    const a = el("a", { href: URL.createObjectURL(blob), download: (schema.meta?.name || "班表") + ".xlsx" });
    a.click();
  } catch (e) { toast("匯出失敗：" + e.message); }
}

function startNextPeriod() {
  if (!lastResult?.assignments?.length) { toast("尚無班表結果"); return; }
  if (!confirm("以本期結果建立下一期？\n本期最後 7 天將帶入「上期銜接」，預班與請假會清空，需重新設定下期的國定假日。")) return;

  const oldEnd = schema.horizon.end;
  const newStart = addDays(oldEnd, 1);
  const startDate = new Date(newStart + "T00:00:00");
  const cycleCfg = CYCLES[currentCycle()];
  let newEnd;
  if (cycleCfg.days) {
    newEnd = addDays(newStart, cycleCfg.days - 1);
  } else {
    newEnd = toISODate(new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0));
  }

  // 本期末尾 → 下期的上期銜接。若下期有跨月的變形工時區塊，需帶足夠天數
  let carryDays = 7;
  for (const b of schema.horizon.blocks || []) {
    if (b.end >= newStart && b.start <= oldEnd) {
      const gap = Math.round((new Date(newStart + "T00:00:00")
        - new Date(b.start + "T00:00:00")) / 86400000);
      carryDays = Math.max(carryDays, Math.min(gap, 31));
    }
  }
  const tail = [...new Set(lastResult.assignments.map(a => a.date))].sort().slice(-carryDays);
  schema.history = lastResult.assignments
    .filter(a => tail.includes(a.date))
    .map(a => ({ employeeId: a.employeeId, date: a.date, shiftId: a.shiftId }));

  schema.horizon.start = newStart;
  schema.horizon.end = newEnd;
  if (cycleCfg.days) {
    schema.horizon.blocks = [{ id: "cycle", start: newStart, end: newEnd, type: currentCycle() }];
  } else {
    schema.horizon.blocks = (schema.horizon.blocks || []).filter(b => b.end >= newStart);
  }
  schema.calendar.holidays = (schema.calendar?.holidays || []).filter(h => h.date >= newStart && h.date <= newEnd);
  schema.preAssignments = [];

  // 名稱自動遞增：年月格式或「第 N 期」格式
  if (schema.meta?.name) {
    if (/(\d{4})年(\d{1,2})月/.test(schema.meta.name)) {
      schema.meta.name = schema.meta.name.replace(/(\d{4})年(\d{1,2})月/,
        `${startDate.getFullYear()}年${startDate.getMonth() + 1}月`);
    } else if (/第\s*(\d+)\s*期/.test(schema.meta.name)) {
      schema.meta.name = schema.meta.name.replace(/第\s*(\d+)\s*期/,
        (_, n) => `第 ${Number(n) + 1} 期`);
    }
  }

  lastResult = null;
  resultPristine = null;
  manualEdits = {};
  localStorage.removeItem("scheduler-last-result");
  saveDraft();
  toast("已建立下一期，請確認假日與預班後重新排班");
  gotoTab("basic");
}

function exportCSV() {
  if (!lastResult?.assignments?.length) { toast("尚無班表可匯出"); return; }
  const dates = [...new Set(lastResult.assignments.map(a => a.date))].sort();
  const byEmp = {};
  for (const a of lastResult.assignments) (byEmp[a.employeeId] = byEmp[a.employeeId] || {})[a.date] = a.shiftId;
  const rows = [["員工編號", "姓名", ...dates]];
  for (const e of schema.employees) {
    rows.push([e.id, e.name || "", ...dates.map(d => byEmp[e.id]?.[d] || "")]);
  }
  const csv = "﻿" + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = el("a", {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
    download: (schema.meta?.name || "班表") + ".csv",
  });
  a.click();
}

function renderResult(running = null) {
  const root = $("#main");
  root.innerHTML = "";
  if (!schema) { root.append(needTemplate()); return; }

  const editCount = Object.keys(manualEdits).length;
  const n = schema.employees?.length || 0;
  const suggested = n <= 50 ? 30 : n <= 120 ? 60 : n <= 250 ? 90 : 120;
  const current = schema.solver?.timeLimitSeconds ?? 30;
  const controls = el("div", { class: "card" },
    el("div", { class: "row" },
      field("求解時間上限（秒）", numInput(current, v => { schema.solver = schema.solver || {}; schema.solver.timeLimitSeconds = v ?? 30; renderResult(); }, { style: "width:100px", min: 5, max: 120 })),
      current < suggested
        ? el("span", { class: "muted", style: "font-size:12px" },
            `${n} 人規模建議 ${suggested} 秒　`,
            el("a", { class: "user-link", style: "color:var(--accent)", onclick: () => {
              schema.solver = schema.solver || {};
              schema.solver.timeLimitSeconds = suggested;
              saveDraft(); renderResult();
            } }, "套用"))
        : null,
      el("div", { style: "flex:1" }),
      editCount ? el("span", { class: "chip" }, `手動修改 ${editCount} 格`) : null,
      editCount ? el("button", { onclick: applyManualEdits }, "鎖定修改並重排") : null,
      editCount ? el("button", { onclick: revertManualEdits }, "還原修改") : null,
      lastResult?.assignments?.length ? el("button", { onclick: () => window.print() }, "列印") : null,
      lastResult?.assignments?.length ? el("button", { onclick: exportXlsx }, "匯出 Excel") : null,
      lastResult?.assignments?.length ? el("button", { onclick: exportCSV }, "匯出 CSV") : null,
      lastResult?.assignments?.length ? el("button", { onclick: startNextPeriod }, "建立下一期") : null,
      el("button", { class: "primary", onclick: startSolve }, solving ? "計算中" : "開始排班")));
  root.append(controls);

  // 設定健檢：規則引用了不存在的班別之類的錯誤，會讓規則默默失效
  const lintErrors = lintIssues.filter(i => i.level === "error");
  const lintWarns = lintIssues.filter(i => i.level === "warning");
  if (lintErrors.length || lintWarns.length) {
    const card = el("div", { class: "card" },
      el("h2", {}, "設定健檢"),
      el("p", { class: "hint" },
        lintErrors.length
          ? "以下設定會讓對應的規則完全不生效，班表雖然排得出來，但那些規則其實沒有被檢查。"
          : "以下是提醒，不影響排班正確性。"));
    for (const i of [...lintErrors, ...lintWarns]) {
      card.append(el("div", { class: "lint-item" },
        el("span", { class: "lint-tag " + i.level }, i.level === "error" ? "失效" : "提醒"),
        el("span", { class: "who" }, i.where),
        el("span", {}, i.message)));
    }
    root.append(card);
  }

  if (running) {
    const banner = el("div", { class: `status-banner ${running.kind}` });
    if (running.kind === "run") banner.append(el("span", { class: "spinner" }));
    banner.append(running.banner);
    root.append(banner);
    return;
  }
  if (!lastResult) {
    root.append(el("div", { class: "card empty-state" },
      el("div", { class: "big" }, "尚未產生班表"),
      el("div", {}, "完成設定後，按右上角「開始排班」即可產生本期班表。")));
    return;
  }

  const r = lastResult;
  if (r.status === "infeasible") {
    root.append(el("div", { class: "status-banner bad" }, "無法產生班表：規則之間互相衝突"));
    if (r.diagnosis) {
      const card = el("div", { class: "card" }, el("h2", {}, "衝突診斷"),
        el("p", { class: "hint" }, "系統逐一測試各硬性條件後的判斷結果。"));
      for (const s of r.diagnosis.suggestions) card.append(el("p", {}, s));
      for (const cid of r.diagnosis.conflictIds || []) {
        const c = schema.constraints.find(x => x.id === cid);
        if (c) card.append(el("div", { class: "row mt" },
          el("span", { class: "chip" }, BLOCK_INFO[c.block]?.name || c.block),
          el("button", { class: "small", onclick: () => { c.enabled = false; saveDraft(); toast("已停用，請重新排班"); } }, "停用此規則")));
      }
      root.append(card);
    }
    return;
  }
  if (r.status === "error" || r.status === "timeout") {
    root.append(el("div", { class: "status-banner bad" },
      r.status === "timeout" ? "時間內找不到可行解，請提高時間上限或放寬部分規則" : "發生錯誤：" + (r.error || "")));
    return;
  }

  root.append(el("div", { class: "status-banner ok" },
    `排班完成：${r.status === "optimal" ? "最佳解" : "可行解"}，耗時 ${(r.solveSeconds || 0).toFixed(1)} 秒，軟性違規 ${r.softViolations.length} 筆`));

  // ---- 班表 ----
  const dates = [...new Set(r.assignments.map(a => a.date))].sort();
  const byEmp = {};
  for (const a of r.assignments) (byEmp[a.employeeId] = byEmp[a.employeeId] || {})[a.date] = a.shiftId;
  const violCells = new Set(r.softViolations.filter(v => v.employeeId && v.date).map(v => v.employeeId + "|" + v.date));
  const holidaySet = new Set((schema.calendar?.holidays || []).map(h => h.date));

  const thead = el("thead", {}, el("tr", {},
    el("th", { class: "emp" }, "人員"),
    dates.map(d => {
      const dt = new Date(d + "T00:00:00");
      const wd = dt.getDay();
      return el("th", { class: (wd === 0 || wd === 6 || holidaySet.has(d)) ? "weekend" : "" },
        String(dt.getDate()), el("span", { class: "wd" }, WEEKDAY_ZH[wd]));
    })));

  // 每格違規訊息（tooltip 用）
  const violMsg = {};
  for (const v of r.softViolations) {
    if (v.employeeId && v.date) {
      const k = v.employeeId + "|" + v.date;
      violMsg[k] = (violMsg[k] ? violMsg[k] + "；" : "") + (v.message || v.constraintId);
    }
  }
  // 手動微調後的硬性違規（即時檢核）
  const hardCells = new Set();
  for (const v of liveViolations) {
    if (v.employeeId && v.date) {
      const k = v.employeeId + "|" + v.date;
      hardCells.add(k);
      violMsg[k] = "【違規】" + v.message + (violMsg[k] ? "；" + violMsg[k] : "");
    }
  }

  const tbody = el("tbody");
  for (const e of schema.employees) {
    const row = el("tr", {}, el("td", { class: "emp" }, `${e.id} ${e.name || ""}`));
    for (const d of dates) {
      const key = e.id + "|" + d;
      const sid = byEmp[e.id]?.[d] || "";
      const st = shiftStyle(sid);
      const cls = [hardCells.has(key) ? "hard-viol" : violCells.has(key) ? "viol" : "",
                   manualEdits[key] ? "edited" : ""].join(" ").trim();
      const td = el("td", { class: cls, title: violMsg[key] || (sid ? sid + "（點擊修改）" : "") },
        sid ? el("span", { class: "shift-pill", style: `background:${st.bg};color:${st.fg}` }, shortLabel(sid)) : "");
      td.addEventListener("click", () => editCell(td, e.id, d, sid));
      row.append(td);
    }
    tbody.append(row);
  }

  // 每日覆蓋列
  for (const s of workShifts()) {
    const row = el("tr", { class: "summary" }, el("td", { class: "emp" }, `${s.id} 班人數`));
    for (const d of dates) {
      const count = schema.employees.reduce((n, e) => n + (byEmp[e.id]?.[d] === s.id ? 1 : 0), 0);
      const req = requiredFor(s.id, d);
      row.append(el("td", { class: req !== null && count < req ? "short" : "" },
        req !== null ? `${count}/${req}` : String(count)));
    }
    tbody.append(row);
  }

  const legend = el("div", { class: "legend" },
    schema.shifts.map(s => {
      const st = shiftStyle(s.id);
      return el("span", {}, el("span", { class: "shift-pill", style: `background:${st.bg};color:${st.fg}` }, shortLabel(s.id)), s.name || s.id);
    }));

  if (liveViolations.length) {
    const card = el("div", { class: "card" },
      el("div", { class: "status-banner bad", style: "margin:0 0 12px" },
        `手動修改後有 ${liveViolations.length} 項違反硬性規則`),
      el("p", { class: "hint", style: "margin-top:0" },
        "以下是即時檢核結果。可以繼續調整，或按「鎖定修改並重排」讓系統在保留你的改動下重新排出合法班表。"),
      violationList(liveViolations.slice(0, 30)));
    root.append(card);
  }

  root.append(el("div", { class: "card print-keep" },
    el("h2", {}, "本期班表"),
    el("p", { class: "hint" },
      "點擊任一格可直接修改班別，系統會即時檢核並用紅框標出違反硬性規則的格子；"
      + "修改後按「鎖定修改並重排」讓系統在保留你改動的前提下重排其餘班次。"
      + "橘框為軟性違規、虛線框為手動修改（滑鼠停留可見原因）；底部為每日各班實際人數與需求。"),
    legend,
    el("div", { class: "sched-wrap" }, el("table", { class: "sched" }, thead, tbody))));

  // ---- 違規清單 ----
  if (r.softViolations.length) {
    const list = el("div", { class: "viol-list" });
    for (const v of r.softViolations) {
      list.append(el("div", { class: "viol-item" },
        el("span", { class: "cost" }, `-${v.cost}`),
        el("span", { class: "who" }, `${v.employeeId || "全體"}${v.date ? "・" + v.date : ""}`),
        el("span", { class: "muted" }, v.message || v.constraintId)));
    }
    root.append(el("div", { class: "card" }, el("h2", {}, "軟性違規（依扣分排序）"),
      el("p", { class: "hint" }, "這些是為了滿足硬性規則而做的取捨，可調整權重改變優先序。"), list));
  }

  // ---- 統計 ----
  const stBody = el("tbody");
  for (const st of r.stats || []) {
    stBody.append(el("tr", {},
      el("td", {}, st.employeeId),
      el("td", { class: "right" }, st.hours),
      el("td", { class: "right" }, st.overtimeHours),
      el("td", { class: "right" }, st.restDays),
      el("td", { class: "right" }, st.weekendRestDays),
      el("td", {}, el("div", { class: "chips" }, Object.entries(st.shiftCounts).map(([k, n]) => el("span", { class: "chip" }, `${k} × ${n}`))))));
  }
  root.append(el("div", { class: "card" },
    el("h2", {}, "每人統計"),
    el("p", { class: "hint" }, "檢視工時與休假分佈是否公平。"),
    el("table", { class: "editor" },
      el("thead", {}, el("tr", {}, ["人員", "工時", "加班", "休假天數", "週末休", "班別分佈"].map(h => el("th", {}, h)))),
      stBody)));
}

// ============ 共用 ============
function needTemplate() {
  return el("div", { class: "card empty-state" },
    el("div", { class: "big" }, "尚未載入資料"),
    el("div", {}, "請先從「模板」選擇行業模板，或匯入既有設定檔。"),
    el("div", { class: "mt" }, el("button", { class: "primary", onclick: () => gotoTab("start") }, "選擇模板")));
}

const RENDERERS = {
  files: renderFiles, start: renderStart, basic: renderBasic, shifts: renderShifts,
  staff: renderStaff, demands: renderDemands, rules: renderRules, prefill: renderPrefill,
  history: renderHistory, result: () => renderResult(), audit: renderAudit,
};

// ---- 匯出 / 匯入 ----
$("#btn-export").addEventListener("click", () => {
  if (!schema) { toast("尚無資料"); return; }
  const blob = new Blob([JSON.stringify(schema, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: (schema.meta?.name || "schedule") + ".json" });
  a.click();
});
$("#file-import").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    schema = JSON.parse(await f.text());
    lastResult = null;
    resultPristine = null;
    manualEdits = {};
    currentScheduleId = null;
    await createScheduleDoc();
    saveDraft();
    toast("已匯入並建立班表");
    gotoTab("basic");
  } catch (e) { toast("匯入失敗：" + e.message); }
});
$("#btn-solve").addEventListener("click", startSolve);

// ---- 初始化 ----
(async function init() {
  const draft = localStorage.getItem("scheduler-draft");
  if (draft) {
    try { schema = JSON.parse(draft); } catch {}
  }
  const saved = localStorage.getItem("scheduler-last-result");
  if (saved) {
    try { lastResult = JSON.parse(saved); resultPristine = saved; } catch {}
  }
  buildNav();
  try {
    currentUser = await api("/api/auth/me");
    afterLogin();
  } catch {
    // api() 已呼叫 showLogin()
  }
})();
