import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);

// ---- 试验规则常量 ----
const TEMP_RANGE = [15, 30];   // 试磨环境温度 ℃
const HUM_RANGE = [40, 75];    // 试磨环境湿度 %RH
const MIN_VALID_RECORDS = 3;   // 结题所需最少有效记录数
const GRADES = ["优", "良", "合格", "不合格"];

const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        { "at": "2026-06-11", "step": "试磨", "note": "宣纸20滴水，出墨快，评分86", "score": 86 }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": []
    }
  ],
  "groups": []
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];

// ---- 错误类型：携带 HTTP 状态码与中文提示 ----
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const badRequest = (msg) => new HttpError(400, "validation_error", msg);
const conflict = (code, msg) => new HttpError(409, code, msg);
const forbidden = (code, msg) => new HttpError(403, code, msg);

// ---- 持久化：读整库；写库先写临时文件再改名，保证不落半条数据 ----
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.groups ||= [];
  return db;
}
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// ---- 互斥锁：所有写操作串行执行；fn 抛错则不落盘，等于整体回滚 ----
let lockChain = Promise.resolve();
function withLock(fn) {
  const result = lockChain.then(() => fn());
  lockChain = result.then(() => {}, () => {});
  return result;
}
async function mutate(fn) {
  return withLock(async () => {
    const db = await loadDb();
    const out = await fn(db);   // 先校验后修改；抛错即放弃，不写文件
    await saveDb(db);
    return out;
  });
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + randomUUID().slice(0, 8); }
function now() { return new Date().toISOString(); }

// ---- 试炼组领域逻辑 ----
function findGroup(db, id) {
  const g = db.groups.find(x => x.id === id);
  if (!g) throw new HttpError(404, "group_not_found", "试炼组不存在");
  return g;
}
// 环境超差 / 重复记录 判定，返回失效原因列表（空数组 = 有效）
function recordIssues(rec, existing) {
  const issues = [];
  if (rec.temperature < TEMP_RANGE[0] || rec.temperature > TEMP_RANGE[1]) {
    issues.push(`环境超差：温度${rec.temperature}℃不在${TEMP_RANGE[0]}–${TEMP_RANGE[1]}℃范围`);
  }
  if (rec.humidity < HUM_RANGE[0] || rec.humidity > HUM_RANGE[1]) {
    issues.push(`环境超差：湿度${rec.humidity}%RH不在${HUM_RANGE[0]}–${HUM_RANGE[1]}%RH范围`);
  }
  const dup = existing.find(r =>
    r.operator === rec.operator && r.paper === rec.paper &&
    r.water === rec.water && r.temperature === rec.temperature &&
    r.humidity === rec.humidity && r.score === rec.score);
  if (dup) issues.push(`重复记录：与记录${dup.id}内容完全相同`);
  return issues;
}
function groupOperators(g) {
  return [...new Set(g.records.map(r => r.operator))];
}
function groupStatus(g) {
  if (g.conclusion) return "effective";
  if (g.pending) return "review";
  return "testing";
}
// 复核人不得参与试磨，也不得与提交人/修改人为同一人
function assertReviewer(g, reviewer, conflictWith) {
  if (!reviewer || !String(reviewer).trim()) throw badRequest("复核人不能为空");
  if (groupOperators(g).includes(reviewer)) {
    throw forbidden("reviewer_participated", `复核人「${reviewer}」参与过本组试磨，不能复核`);
  }
  if (conflictWith && reviewer === conflictWith) {
    throw forbidden("reviewer_conflict", "复核人不能与提交人/修改人为同一人");
  }
}
function amendmentDiff(g) {
  if (!g.amendment || !g.conclusion) return null;
  return {
    baseVersion: g.conclusion.version,
    text: { from: g.conclusion.text, to: g.amendment.text },
    grade: { from: g.conclusion.grade, to: g.amendment.grade },
    reason: g.amendment.reason,
    modifiedBy: g.amendment.modifiedBy,
    at: g.amendment.at
  };
}
// 判断一条记录是否属于「结论生效后新增」：
// 新版结论存有生效时记录数快照 recordCount，直接按下标比较；
// 旧版数据没有快照，按生效时间 effectiveAt 重建边界——生效时及之前的记录不算新增。
// 纯读取推导，不改写旧结论、历史记录或状态，重启后结果一致。
function isPostConclusion(g, rec, index) {
  const c = g.conclusion;
  if (!c) return false;
  if (Number.isInteger(c.recordCount)) return index >= c.recordCount;
  return Boolean(rec.at && c.effectiveAt && rec.at > c.effectiveAt);
}
function groupSummary(g) {
  const validCount = g.records.filter(r => r.valid).length;
  const invalidCount = g.records.length - validCount;
  const lastDecision = [...g.history].reverse().find(h => ["submit", "approve", "reject"].includes(h.type));
  // 需补测：生效前的失效记录不提示；生效（含旧结论按生效时间重建的边界）后新增失效记录才提示
  const newInvalid = g.records.some((r, i) => !r.valid && isPostConclusion(g, r, i));
  const needRetest = g.conclusion
    ? newInvalid
    : invalidCount > 0 || Boolean(lastDecision && lastDecision.type === "reject");
  return {
    id: g.id,
    inkCode: g.inkCode,
    title: g.title,
    status: groupStatus(g),
    validCount,
    invalidCount,
    totalCount: g.records.length,
    version: g.conclusion ? g.conclusion.version : null,
    amendmentPending: Boolean(g.amendment),
    needRetest
  };
}
function groupDetail(g) {
  const valid = g.records.filter(r => r.valid);
  const issues = [...new Set(g.records.filter(r => !r.valid).flatMap(r => r.issues))];
  return {
    ...groupSummary(g),
    createdAt: g.createdAt,
    records: g.records,
    issues,
    operators: groupOperators(g),
    pending: g.pending,
    conclusion: g.conclusion,
    amendment: g.amendment,
    amendmentDiff: amendmentDiff(g),
    versions: g.versions,
    history: g.history
  };
}

function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭重复试验结论台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#2f6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:18px 22px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; align-items:center; position:sticky; top:0; z-index:5; }
    h1 { margin:0; font-size:22px; } h2 { margin:0 0 10px; font-size:17px; } h3 { margin:16px 0 8px; font-size:15px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:18px; padding:18px 22px; max-width:1280px; margin:0 auto; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:8px; padding:10px; font:inherit; background:#fff; min-height:42px; } textarea { min-height:64px; }
    button { border:0; border-radius:8px; background:var(--accent); color:#fff; padding:11px 14px; min-height:44px; font-weight:700; font-size:15px; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.5; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:8px; margin-bottom:12px; } .stat strong { display:block; font-size:22px; } .stat span { font-size:12px; color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px; } .card { display:grid; gap:6px; cursor:pointer; } .card.active { outline:2px solid var(--accent); }
    .meta { color:var(--muted); font-size:13px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; background:#fff; }
    .pill.bad { border-color:var(--warn); color:var(--warn); } .pill.good { border-color:var(--ok); color:var(--ok); }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; } .row.between { justify-content:space-between; }
    .rec { border:1px solid var(--line); border-radius:8px; padding:10px; display:grid; gap:4px; } .rec.invalid { border-color:var(--warn); background:#fbf3f1; }
    .recs { display:grid; gap:8px; } .issue { color:var(--warn); font-size:13px; }
    table { width:100%; border-collapse:collapse; font-size:14px; } th,td { border:1px solid var(--line); padding:8px; text-align:left; vertical-align:top; } th { background:#f6f8f4; }
    .diff-old { background:#fbf3f1; } .diff-new { background:#f0f7ee; }
    .banner { border:1px solid var(--warn); background:#fbf3f1; color:var(--warn); border-radius:8px; padding:10px; font-weight:700; margin:8px 0; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#20241f; color:#fff; padding:12px 18px; border-radius:8px; max-width:92vw; display:none; z-index:9; }
    #toast.err { background:var(--warn); }
    .hist { max-height:180px; overflow:auto; } .hist div { border-top:1px dashed var(--line); padding:5px 0; font-size:13px; }
    details { margin-top:8px; } summary { cursor:pointer; color:var(--muted); }
    @media (max-width:900px){ header{padding:14px} main{grid-template-columns:1fr;padding:12px} h1{font-size:19px} }
  </style>
</head>
<body>
  <header><div><h1>墨锭重复试验结论台</h1><div class="meta">试磨登记 → 满${MIN_VALID_RECORDS}条有效记录结题 → 复核生效 → 修正留痕</div></div><button id="reload" class="secondary">刷新</button></header>
  <main>
    <section>
      <form id="groupForm"><h2>新建试炼组</h2>
        <label>选择墨锭</label><select name="inkCode" id="inkSelect" required></select>
        <label>试炼目标</label><input name="title" placeholder="如：日常书写适用性验证" required>
        <label>创建人</label><input name="createdBy" placeholder="姓名">
        <button>创建试炼组</button>
      </form>
      <form id="itemForm" style="margin-top:12px"><h2>墨锭建档</h2><div id="itemFields"></div><button class="secondary">保存墨锭</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><h2>试炼组</h2><div class="grid" id="groups"></div></div>
      <div id="detail" style="margin-top:14px"></div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    var MIN_VALID = ${MIN_VALID_RECORDS};
    var TEMP_RANGE = ${JSON.stringify(TEMP_RANGE)}, HUM_RANGE = ${JSON.stringify(HUM_RANGE)};
    var GRADES = ${JSON.stringify(GRADES)};
    var itemFields = ${JSON.stringify(fields)};
    var STATUS_LABEL = { testing:'试磨中', review:'待复核', effective:'已生效' };
    var groups = [], items = [], detail = null, selectedId = null;
    var recordToken = null;

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmt(t) { return t ? new Date(t).toLocaleString('zh-CN', { hour12:false }) : ''; }
    function toast(msg, isErr) {
      var el = document.querySelector('#toast');
      el.textContent = msg; el.className = isErr ? 'err' : ''; el.style.display = 'block';
      clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = 'none'; }, 3200);
    }
    async function api(path, options) {
      var res = await fetch(path, options && options.body ? Object.assign({}, options, { headers:{ 'Content-Type':'application/json' } }) : options);
      var data = await res.json();
      if (!res.ok) { var e = new Error(data.message || data.error || '请求失败'); e.status = res.status; e.data = data; throw e; }
      return data;
    }
    async function run(fn) { try { await fn(); } catch (e) { toast(e.message, true); } }

    async function load() {
      items = await api('/api/items');
      groups = await api('/api/groups');
      renderStats(); renderGroups(); renderItemForm(); fillInkSelect();
      if (selectedId) await loadDetail(selectedId);
    }
    async function loadDetail(id) {
      detail = await api('/api/groups/' + id);
      selectedId = id;
      recordToken = crypto.randomUUID();
      renderDetail();
      renderGroups();
    }

    function renderStats() {
      var s = { total: groups.length, testing: 0, review: 0, effective: 0, retest: 0 };
      groups.forEach(g => { s[g.status] += 1; if (g.needRetest) s.retest += 1; });
      document.querySelector('#stats').innerHTML =
        [['试炼组', s.total], ['试磨中', s.testing], ['待复核', s.review], ['已生效', s.effective], ['需补测', s.retest]]
        .map(p => '<div class="stat"><span>' + p[0] + '</span><strong>' + p[1] + '</strong></div>').join('');
    }
    function renderGroups() {
      document.querySelector('#groups').innerHTML = groups.map(g => {
        var badges = '';
        if (g.amendmentPending) badges += ' <span class="pill bad">修正复核中</span>';
        if (g.needRetest) badges += ' <span class="pill bad">需补测</span>';
        return '<article class="card' + (g.id === selectedId ? ' active' : '') + '" onclick="openGroup(\\'' + g.id + '\\')">' +
          '<div class="row between"><b>' + esc(g.title) + '</b><span class="pill">' + STATUS_LABEL[g.status] + '</span></div>' +
          '<div class="meta">墨锭 ' + esc(g.inkCode) + '</div>' +
          '<div>有效记录 <b class="' + (g.validCount >= MIN_VALID ? 'ok' : '') + '">' + g.validCount + '</b> / 共 ' + g.totalCount + ' 条' +
          (g.invalidCount ? ' · <span class="warn">失效 ' + g.invalidCount + '</span>' : '') + '</div>' +
          '<div class="meta">' + (g.version ? '结论版本 <b>v' + g.version + '</b>' : '尚未结题') + badges + '</div>' +
        '</article>';
      }).join('') || '<div class="meta">暂无试炼组，请先创建。</div>';
    }
    function renderItemForm() {
      document.querySelector('#itemFields').innerHTML = itemFields.map(f =>
        '<label>' + f[1] + '</label><input name="' + f[0] + '" type="' + f[2] + '"' + (f[0] === 'code' ? ' required' : '') + '>').join('');
    }
    function fillInkSelect() {
      document.querySelector('#inkSelect').innerHTML = items.map(i =>
        '<option value="' + esc(i.code || i.id) + '">' + esc(i.code || i.id) + ' · ' + esc(i.smokeSource || '') + '</option>').join('');
    }

    function recHtml(r) {
      return '<div class="rec' + (r.valid ? '' : ' invalid') + '">' +
        '<div class="row between"><b>' + esc(r.operator) + '</b><span class="pill ' + (r.valid ? 'good' : 'bad') + '">' + (r.valid ? '有效' : '失效') + '</span></div>' +
        '<div class="meta">' + esc(r.paper) + ' · 水量' + r.water + '滴 · ' + r.temperature + '℃ · ' + r.humidity + '%RH · 评分 <b>' + r.score + '</b></div>' +
        (r.issues && r.issues.length ? r.issues.map(i => '<div class="issue">⚠ ' + esc(i) + '</div>').join('') : '') +
        '<div class="meta">' + esc(r.id) + ' · ' + fmt(r.at) + '</div></div>';
    }
    function gradeOptions(cur) {
      return '<option value="">（不评级）</option>' + GRADES.map(g => '<option' + (g === cur ? ' selected' : '') + '>' + g + '</option>').join('');
    }

    function renderDetail() {
      var g = detail, el = document.querySelector('#detail');
      if (!g) { el.innerHTML = ''; return; }
      var h = '<div class="panel">';
      h += '<div class="row between"><h2>' + esc(g.title) + ' <span class="pill">' + STATUS_LABEL[g.status] + '</span></h2><button class="secondary" onclick="closeDetail()">收起</button></div>';
      h += '<div class="meta">墨锭 ' + esc(g.inkCode) + ' · 有效 <b>' + g.validCount + '</b>/' + g.totalCount + ' 条 · 操作人：' + (g.operators.map(esc).join('、') || '暂无') + '</div>';
      if (g.issues.length) h += '<div style="margin-top:6px">' + g.issues.map(i => '<span class="pill bad">⚠ ' + esc(i) + '</span>').join(' ') + '</div>';
      if (g.needRetest) h += '<div class="banner">' + (g.conclusion ? '生效后新增失效记录，请安排补测。' : '存在失效记录或结论被驳回，请补测后重新结题。') + '</div>';

      h += '<h3>试磨记录（' + g.totalCount + '）</h3><div class="recs">' + (g.records.map(recHtml).join('') || '<div class="meta">暂无记录</div>') + '</div>';

      h += '<h3>登记试磨</h3><form id="recForm"><div class="row">' +
        '<div style="flex:1;min-width:120px"><label>操作人</label><input name="operator" required></div>' +
        '<div style="flex:1;min-width:120px"><label>纸样</label><input name="paper" placeholder="宣纸/棉连纸" required></div></div><div class="row">' +
        '<div style="flex:1;min-width:100px"><label>水量(滴)</label><input name="water" type="number" inputmode="decimal" step="any" required></div>' +
        '<div style="flex:1;min-width:100px"><label>温度(℃)</label><input name="temperature" type="number" inputmode="decimal" step="any" required></div>' +
        '<div style="flex:1;min-width:100px"><label>湿度(%RH)</label><input name="humidity" type="number" inputmode="decimal" step="any" required></div>' +
        '<div style="flex:1;min-width:100px"><label>评分</label><input name="score" type="number" inputmode="decimal" step="any" min="0" max="100" required></div></div>' +
        '<div class="meta">环境合格范围：温度 ' + TEMP_RANGE[0] + '–' + TEMP_RANGE[1] + '℃，湿度 ' + HUM_RANGE[0] + '–' + HUM_RANGE[1] + '%RH；超差或重复登记将判为失效，不计入结论。</div>' +
        '<button style="margin-top:8px">提交登记</button></form>';

      if (g.status === 'testing') {
        h += '<h3>结题</h3>';
        if (g.validCount >= MIN_VALID) {
          h += '<form id="conclForm"><label>结论文本</label><textarea name="text" placeholder="综合有效记录得出的结论" required></textarea>' +
            '<label>评级</label><select name="grade">' + gradeOptions('') + '</select>' +
            '<label>提交人</label><input name="submittedBy" required><button>提交结题复核</button></form>';
        } else {
          h += '<div class="meta">有效记录 ' + g.validCount + '/' + MIN_VALID + ' 条，不足 ' + MIN_VALID + ' 条不能结题，请继续试磨或补测。</div>';
        }
      }
      if (g.pending) {
        var p = g.pending;
        h += '<h3>结题复核</h3><div class="rec"><div class="meta">提交人 ' + esc(p.submittedBy) + ' · ' + fmt(p.at) + ' · 基于 ' + p.validCount + ' 条有效记录，均分 ' + p.avgScore + '</div>' +
          '<div>' + esc(p.text) + '</div>' + (p.grade ? '<span class="pill">评级：' + esc(p.grade) + '</span>' : '') + '</div>' +
          '<form id="reviewForm"><label>复核人（不得为试磨操作人）</label><input name="reviewer" required>' +
          '<label>驳回原因（驳回时必填）</label><input name="reason" placeholder="退回补测的原因">' +
          '<div class="row"><button type="submit" data-decision="approve">复核通过</button><button type="submit" class="danger" data-decision="reject">驳回补测</button></div></form>';
      }
      if (g.conclusion) {
        var c = g.conclusion;
        h += '<h3>生效结论 · v' + c.version + '</h3><div class="rec"><div>' + esc(c.text) + '</div>' +
          '<div class="meta">' + (c.grade ? '评级 ' + esc(c.grade) + ' · ' : '') + '均分 ' + c.avgScore + ' · 复核人 ' + esc(c.review.reviewer) + ' · 生效于 ' + fmt(c.effectiveAt) + '</div>' +
          (c.amendedBy ? '<div class="meta">由 ' + esc(c.amendedBy) + ' 修正（' + esc(c.amendReason || '') + '），替代 v' + c.supersedes + '</div>' : '') + '</div>';
        if (!g.amendment) {
          h += '<details><summary>发起修正（生效结论只能经修正变更，复核通过前查询仍返回 v' + c.version + '）</summary>' +
            '<form id="amendForm"><label>修正后结论文本</label><textarea name="text" required>' + esc(c.text) + '</textarea>' +
            '<label>修正后评级</label><select name="grade">' + gradeOptions(c.grade) + '</select>' +
            '<label>修正原因（必填）</label><input name="reason" required>' +
            '<label>修改人</label><input name="modifiedBy" required><button>提交修正复核</button></form></details>';
        }
      }
      if (g.amendment && g.amendmentDiff) {
        var d = g.amendmentDiff;
        h += '<h3>修正复核 · 基于 v' + d.baseVersion + '</h3>' +
          '<table><tr><th>项目</th><th>当前生效（v' + d.baseVersion + '）</th><th>修正后</th></tr>' +
          '<tr><td>结论文本</td><td class="diff-old">' + esc(d.text.from) + '</td><td class="diff-new">' + esc(d.text.to) + '</td></tr>' +
          '<tr><td>评级</td><td class="diff-old">' + esc(d.grade.from || '（无）') + '</td><td class="diff-new">' + esc(d.grade.to || '（无）') + '</td></tr></table>' +
          '<div class="meta" style="margin:6px 0">修改人 ' + esc(d.modifiedBy) + ' · ' + fmt(d.at) + ' · 原因：' + esc(d.reason) + '</div>' +
          '<form id="amendReviewForm"><label>复核人（不得为试磨操作人或修改人）</label><input name="reviewer" required>' +
          '<label>驳回原因（驳回时必填）</label><input name="reason">' +
          '<div class="row"><button type="submit" data-decision="approve">通过并整体切换</button><button type="submit" class="danger" data-decision="reject">驳回修正</button></div></form>';
      }
      if (g.versions.length) {
        h += '<h3>版本历史</h3>' + g.versions.map(v =>
          '<div class="rec"><div class="row between"><b>v' + v.version + '</b><span class="meta">' + fmt(v.effectiveAt) + '</span></div>' +
          '<div>' + esc(v.text) + '</div><div class="meta">' + (v.grade ? '评级 ' + esc(v.grade) + ' · ' : '') + '均分 ' + v.avgScore +
          (v.amendedBy ? ' · 修正人 ' + esc(v.amendedBy) + '（' + esc(v.amendReason || '') + '）' : '') + '</div></div>').join('');
      }
      h += '<h3>操作日志</h3><div class="hist">' + g.history.slice().reverse().map(x =>
        '<div><span class="meta">' + fmt(x.at) + ' · ' + esc(x.by || '') + '</span> ' + esc(x.note || x.type) + (x.reason ? '（' + esc(x.reason) + '）' : '') + '</div>').join('') + '</div>';
      h += '</div>';
      el.innerHTML = h;
      bindDetailForms();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.closeDetail = function () { selectedId = null; detail = null; document.querySelector('#detail').innerHTML = ''; renderGroups(); };
    // 注意：不要命名为 loadDetail，否则会覆盖同名顶层函数并在包装内自递归导致栈溢出
    window.openGroup = function (id) { run(() => loadDetail(id)); };

    function bindDetailForms() {
      var recForm = document.querySelector('#recForm');
      if (recForm) recForm.onsubmit = e => { e.preventDefault();
        var btn = recForm.querySelector('button');
        btn.disabled = true;   // 提交期间防重复点击，渲染完成或出错后恢复
        run(async () => {
          var fd = new FormData(recForm);
          var payload = { operator: fd.get('operator').trim(), paper: fd.get('paper').trim(),
            water: Number(fd.get('water')), temperature: Number(fd.get('temperature')),
            humidity: Number(fd.get('humidity')), score: Number(fd.get('score')), clientToken: recordToken };
          var out = await api('/api/groups/' + selectedId + '/records', { method: 'POST', body: JSON.stringify(payload) });
          recordToken = crypto.randomUUID();
          if (out.record.valid) toast('登记成功，记录有效'); else toast('记录失效：' + out.record.issues.join('；') + '，请补测', true);
          await load(); await loadDetail(selectedId);
        }).finally(() => { btn.disabled = false; });
      };
      var conclForm = document.querySelector('#conclForm');
      if (conclForm) conclForm.onsubmit = e => { e.preventDefault(); run(async () => {
        var fd = new FormData(conclForm);
        await api('/api/groups/' + selectedId + '/conclusion', { method: 'POST', body: JSON.stringify({ text: fd.get('text').trim(), grade: fd.get('grade'), submittedBy: fd.get('submittedBy').trim() }) });
        toast('已提交结题复核'); await load(); await loadDetail(selectedId);
      }); };
      var reviewForm = document.querySelector('#reviewForm');
      if (reviewForm) reviewForm.onsubmit = e => { e.preventDefault(); run(async () => {
        var fd = new FormData(reviewForm);
        var decision = e.submitter ? e.submitter.dataset.decision : 'approve';
        await api('/api/groups/' + selectedId + '/review', { method: 'POST', body: JSON.stringify({ reviewer: fd.get('reviewer').trim(), decision: decision, reason: fd.get('reason').trim() }) });
        toast(decision === 'approve' ? '结论已生效' : '已驳回，退回补测'); await load(); await loadDetail(selectedId);
      }); };
      var amendForm = document.querySelector('#amendForm');
      if (amendForm) amendForm.onsubmit = e => { e.preventDefault(); run(async () => {
        var fd = new FormData(amendForm);
        await api('/api/groups/' + selectedId + '/amendments', { method: 'POST', body: JSON.stringify({ text: fd.get('text').trim(), grade: fd.get('grade'), reason: fd.get('reason').trim(), modifiedBy: fd.get('modifiedBy').trim() }) });
        toast('修正已提交复核，生效前查询仍返回旧版'); await load(); await loadDetail(selectedId);
      }); };
      var amendReviewForm = document.querySelector('#amendReviewForm');
      if (amendReviewForm) amendReviewForm.onsubmit = e => { e.preventDefault(); run(async () => {
        var fd = new FormData(amendReviewForm);
        var decision = e.submitter ? e.submitter.dataset.decision : 'approve';
        await api('/api/groups/' + selectedId + '/amendments/review', { method: 'POST', body: JSON.stringify({ reviewer: fd.get('reviewer').trim(), decision: decision, reason: fd.get('reason').trim() }) });
        toast(decision === 'approve' ? '修正已生效并整体切换' : '修正已驳回'); await load(); await loadDetail(selectedId);
      }); };
    }

    document.querySelector('#groupForm').onsubmit = e => { e.preventDefault(); run(async () => {
      var fd = new FormData(e.target);
      await api('/api/groups', { method: 'POST', body: JSON.stringify({ inkCode: fd.get('inkCode'), title: fd.get('title').trim(), createdBy: fd.get('createdBy').trim() }) });
      e.target.reset(); toast('试炼组已创建'); await load();
    }); };
    document.querySelector('#itemForm').onsubmit = e => { e.preventDefault(); run(async () => {
      await api('/api/items', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
      e.target.reset(); toast('墨锭已建档'); await load();
    }); };
    document.querySelector('#reload').onclick = () => run(load);
    run(load);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") return html(res, page());

    // ---- 墨锭档案（保留原有能力） ----
    if (req.method === "GET" && p === "/api/items") return send(res, 200, (await loadDb()).items.map(summarize));
    if (req.method === "POST" && p === "/api/items") {
      const input = await body(req);
      const item = await mutate(db => {
        const it = { id: "IS-" + Date.now(), ...input, logs: [{ at: now(), step: "建档", note: "创建墨锭" }] };
        db.items.unshift(it);
        return it;
      });
      return send(res, 201, item);
    }
    const patch = p.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      const item = await mutate(db => {
        const it = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!it) throw new HttpError(404, "item_not_found", "墨锭不存在");
        Object.assign(it, input);
        it.logs ||= [];
        it.logs.push({ at: now(), step: "状态", note: "更新为" + it.status });
        return it;
      });
      return send(res, 200, item);
    }
    const log = p.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const item = await mutate(db => {
        const it = db.items.find(x => x.id === log[1] || x.code === log[1]);
        if (!it) throw new HttpError(404, "item_not_found", "墨锭不存在");
        it.logs ||= [];
        it.logs.push({ at: now(), step: input.step || "记录", note: input.note || "" });
        return it;
      });
      return send(res, 201, item);
    }

    // ---- 试炼组 ----
    if (req.method === "GET" && p === "/api/groups") {
      return send(res, 200, (await loadDb()).groups.map(groupSummary));
    }
    if (req.method === "POST" && p === "/api/groups") {
      const input = await body(req);
      const group = await mutate(db => {
        const inkCode = String(input.inkCode || "").trim();
        const title = String(input.title || "").trim();
        if (!inkCode) throw badRequest("必须选择墨锭");
        if (!title) throw badRequest("试炼目标不能为空");
        if (!db.items.some(i => i.code === inkCode || i.id === inkCode)) throw badRequest(`墨锭 ${inkCode} 不存在`);
        const g = {
          id: newId("G"), inkCode, title, createdAt: now(),
          records: [], pending: null, conclusion: null, amendment: null,
          versions: [], history: [{ type: "create", at: now(), by: input.createdBy || "", note: `创建试炼组「${title}」` }]
        };
        db.groups.push(g);
        return g;
      });
      return send(res, 201, groupDetail(group));
    }
    const gDetail = p.match(/^\/api\/groups\/([^/]+)$/);
    if (gDetail && req.method === "GET") {
      const db = await loadDb();
      return send(res, 200, groupDetail(findGroup(db, gDetail[1])));
    }

    // 试磨登记：环境超差/重复记录判失效；clientToken 幂等，并发补测只成功一次
    const gRec = p.match(/^\/api\/groups\/([^/]+)\/records$/);
    if (gRec && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const g = findGroup(db, gRec[1]);
        const token = input.clientToken ? String(input.clientToken) : null;
        if (token) {
          const seen = g.records.find(r => r.clientToken === token);
          if (seen) return { record: seen, deduplicated: true, group: groupDetail(g) };
        }
        const rec = {
          id: newId("R"), at: now(),
          operator: String(input.operator || "").trim(),
          paper: String(input.paper || "").trim(),
          water: Number(input.water),
          temperature: Number(input.temperature),
          humidity: Number(input.humidity),
          score: Number(input.score),
          clientToken: token
        };
        if (!rec.operator) throw badRequest("操作人不能为空");
        if (!rec.paper) throw badRequest("纸样不能为空");
        for (const [k, label] of [["water", "水量"], ["temperature", "温度"], ["humidity", "湿度"], ["score", "评分"]]) {
          if (!Number.isFinite(rec[k])) throw badRequest(`${label}必须是数字`);
        }
        if (rec.score < 0 || rec.score > 100) throw badRequest("评分须在 0–100 之间");
        rec.issues = recordIssues(rec, g.records);
        rec.valid = rec.issues.length === 0;
        g.records.push(rec);
        g.history.push({
          type: "record", at: rec.at, by: rec.operator,
          note: rec.valid ? `登记试磨，评分${rec.score}` : `登记失效：${rec.issues.join("；")}，需补测`
        });
        return { record: rec, deduplicated: false, needRetest: !rec.valid, group: groupDetail(g) };
      });
      return send(res, out.deduplicated ? 200 : 201, out);
    }

    // 提交结题复核：需 ≥3 条有效记录；已生效结论只能走修正
    const gConcl = p.match(/^\/api\/groups\/([^/]+)\/conclusion$/);
    if (gConcl && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const g = findGroup(db, gConcl[1]);
        if (g.conclusion) throw conflict("already_effective", "结论已生效，只能通过修正变更");
        if (g.pending) throw conflict("conclusion_pending", "已有待复核的结题申请");
        const valid = g.records.filter(r => r.valid);
        if (valid.length < MIN_VALID_RECORDS) {
          throw new HttpError(422, "insufficient_valid_records", `有效记录${valid.length}条，不足${MIN_VALID_RECORDS}条，请补测后再结题`);
        }
        const text = String(input.text || "").trim();
        const submittedBy = String(input.submittedBy || "").trim();
        if (!text) throw badRequest("结论文本不能为空");
        if (!submittedBy) throw badRequest("提交人不能为空");
        const avgScore = Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length * 10) / 10;
        g.pending = {
          text, grade: String(input.grade || ""), avgScore,
          validCount: valid.length, recordIds: valid.map(r => r.id),
          submittedBy, at: now()
        };
        g.history.push({ type: "submit", at: now(), by: submittedBy, note: `提交结题复核（${valid.length}条有效记录，均分${avgScore}）` });
        return groupDetail(g);
      });
      return send(res, 201, out);
    }

    // 复核结题：复核人不得参与试磨；驳回必须写明原因并退回补测
    const gReview = p.match(/^\/api\/groups\/([^/]+)\/review$/);
    if (gReview && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const g = findGroup(db, gReview[1]);
        if (!g.pending) throw conflict("no_pending_conclusion", "当前没有待复核的结题申请");
        const reviewer = String(input.reviewer || "").trim();
        assertReviewer(g, reviewer, g.pending.submittedBy);
        const decision = String(input.decision || "");
        if (decision === "approve") {
          const version = (g.versions.length ? g.versions[g.versions.length - 1].version : 0) + 1;
          // recordCount 作为需补测基线：生效前的失效记录不再触发提示
          const concluded = { ...g.pending, version, effectiveAt: now(), review: { reviewer, at: now() }, recordCount: g.records.length };
          g.versions.push(concluded);
          g.conclusion = concluded;
          g.pending = null;
          g.history.push({ type: "approve", at: now(), by: reviewer, note: `复核通过，结论v${version}生效` });
        } else if (decision === "reject") {
          const reason = String(input.reason || "").trim();
          if (!reason) throw badRequest("驳回必须写明原因");
          g.history.push({ type: "reject", at: now(), by: reviewer, reason, note: "驳回结题申请，退回补测", snapshot: g.pending });
          g.pending = null;
        } else {
          throw badRequest("decision 必须是 approve 或 reject");
        }
        return groupDetail(g);
      });
      return send(res, 200, out);
    }

    // 发起修正：仅生效结论可修正；保留旧值、修改人、时间、原因
    const gAmend = p.match(/^\/api\/groups\/([^/]+)\/amendments$/);
    if (gAmend && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const g = findGroup(db, gAmend[1]);
        if (!g.conclusion) throw conflict("not_effective", "结论尚未生效，无需修正");
        if (g.amendment) throw conflict("amendment_pending", "已有待复核的修正");
        const text = String(input.text || "").trim();
        const reason = String(input.reason || "").trim();
        const modifiedBy = String(input.modifiedBy || "").trim();
        if (!text) throw badRequest("修正后结论文本不能为空");
        if (!reason) throw badRequest("修正必须写明原因");
        if (!modifiedBy) throw badRequest("修改人不能为空");
        g.amendment = { text, grade: String(input.grade || ""), reason, modifiedBy, at: now(), baseVersion: g.conclusion.version };
        g.history.push({ type: "amend_submit", at: now(), by: modifiedBy, reason, note: `发起对v${g.conclusion.version}的修正` });
        return groupDetail(g);
      });
      return send(res, 201, out);
    }

    // 复核修正：通过则整体切换为新版本；驳回保留旧版
    const gAmendReview = p.match(/^\/api\/groups\/([^/]+)\/amendments\/review$/);
    if (gAmendReview && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const g = findGroup(db, gAmendReview[1]);
        if (!g.amendment) throw conflict("no_pending_amendment", "当前没有待复核的修正");
        const reviewer = String(input.reviewer || "").trim();
        assertReviewer(g, reviewer, g.amendment.modifiedBy);
        const decision = String(input.decision || "");
        if (decision === "approve") {
          const old = g.conclusion;
          const next = {
            ...old,
            text: g.amendment.text, grade: g.amendment.grade,
            version: old.version + 1, effectiveAt: now(),
            review: { reviewer, at: now() },
            amendedBy: g.amendment.modifiedBy, amendReason: g.amendment.reason,
            supersedes: old.version,
            recordCount: g.records.length   // 新版本生效，重置需补测基线
          };
          g.versions.push(next);   // 旧版本保留在 versions 中，可溯源
          g.conclusion = next;     // 整体切换
          g.amendment = null;
          g.history.push({ type: "amend_approve", at: now(), by: reviewer, note: `修正复核通过，整体切换为v${next.version}` });
        } else if (decision === "reject") {
          const reason = String(input.reason || "").trim();
          if (!reason) throw badRequest("驳回必须写明原因");
          g.history.push({ type: "amend_reject", at: now(), by: reviewer, reason, note: "驳回修正，维持原结论", snapshot: g.amendment });
          g.amendment = null;
        } else {
          throw badRequest("decision 必须是 approve 或 reject");
        }
        return groupDetail(g);
      });
      return send(res, 200, out);
    }

    if (req.method === "GET" && p === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, { items: computeStats(db.items), groups: db.groups.map(groupSummary) });
    }
    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    if (error instanceof HttpError) {
      send(res, error.status, { error: error.code, message: error.message });
    } else {
      send(res, 500, { error: "internal_error", message: error.message });
    }
  }
});
server.listen(port, () => console.log("墨锭重复试验结论台 listening on http://localhost:" + port));
