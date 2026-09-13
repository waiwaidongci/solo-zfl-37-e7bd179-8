// 验证脚本：成功 / 冲突 / 回滚 / 越权 / 重启
// 运行：node verify.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const dbFile = join(mkdtempSync(join(tmpdir(), "ink-verify-")), "test-db.json");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}
const rec = (operator, score, over = {}) => ({
  operator, paper: "宣纸", water: 20, temperature: 22, humidity: 55, score, ...over
});

let child;
async function startServer() {
  child = spawn("node", [join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile },
    stdio: "inherit"
  });
  for (let i = 0; i < 50; i++) {
    try { await api("GET", "/api/items"); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error("server did not start");
}
async function stopServer() {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise(r => child.once("exit", r));
  child = null;
}

console.log("== 启动服务 ==");
await startServer();

// ---------- A. 成功流程 + 环境超差/重复失效 ----------
console.log("\n== A. 成功流程（登记→结题→复核→生效） ==");
let r = await api("POST", "/api/items", { code: "IS-T1", smokeSource: "松烟", status: "待试磨" });
check("墨锭建档", r.status === 201);
r = await api("POST", "/api/groups", { inkCode: "IS-T1", title: "适用性验证", createdBy: "组长" });
check("创建试炼组", r.status === 201);
const G1 = r.data.id;

r = await api("POST", "/api/groups", { inkCode: "IS-NONE", title: "x" });
check("未知墨锭建组被拒绝", r.status === 400);

for (const [op, score] of [["张三", 80], ["李四", 85], ["王五", 90]]) {
  r = await api("POST", `/api/groups/${G1}/records`, rec(op, score));
  check(`有效登记 ${op}`, r.status === 201 && r.data.record.valid === true);
}
r = await api("POST", `/api/groups/${G1}/records`, rec("赵六", 70, { temperature: 40 }));
check("温度超差判失效并提示补测", r.data.record.valid === false && r.data.record.issues.some(i => i.includes("环境超差")) && r.data.needRetest === true);
r = await api("POST", `/api/groups/${G1}/records`, rec("张三", 80));
check("完全相同的重复记录判失效", r.data.record.valid === false && r.data.record.issues.some(i => i.includes("重复记录")));
r = await api("GET", `/api/groups/${G1}`);
check("有效数=3，总数=5，异常原因已汇总", r.data.validCount === 3 && r.data.totalCount === 5 && r.data.issues.length >= 2);

r = await api("POST", `/api/groups/${G1}/conclusion`, { text: "出墨稳定，适合日常书写", grade: "优", submittedBy: "张三" });
check("提交结题复核", r.status === 201 && r.data.pending.avgScore === 85);
r = await api("POST", `/api/groups/${G1}/conclusion`, { text: "重复提交", submittedBy: "张三" });
check("重复结题被拒(409)", r.status === 409);
r = await api("POST", `/api/groups/${G1}/review`, { reviewer: "李四", decision: "approve" });
check("越权复核被拒：复核人参与过试磨(403)", r.status === 403 && r.data.error === "reviewer_participated");
r = await api("POST", `/api/groups/${G1}/review`, { reviewer: "张三", decision: "approve" });
check("越权复核被拒：复核人=提交人(403)", r.status === 403);
r = await api("POST", `/api/groups/${G1}/review`, { reviewer: "周八", decision: "approve" });
check("复核通过，结论生效", r.status === 200 && r.data.conclusion.version === 1);

// ---------- B. 并发补测：同一 clientToken 只成功一次 ----------
console.log("\n== B. 并发补测幂等 ==");
const token = "token-" + Date.now();
const results = await Promise.all(Array.from({ length: 5 }, () =>
  api("POST", `/api/groups/${G1}/records`, { ...rec("孙九", 88), clientToken: token })));
r = await api("GET", `/api/groups/${G1}`);
const withToken = r.data.records.filter(x => x.clientToken === token);
check("5 个并发相同 token 请求全部返回成功", results.every(x => x.status === 200 || x.status === 201));
check("只落了一条记录", withToken.length === 1, `实际 ${withToken.length} 条`);

// ---------- C. 重复复核并发：只成功一次 ----------
console.log("\n== C. 重复复核冲突 ==");
r = await api("POST", "/api/groups", { inkCode: "IS-T1", title: "第二组" });
const G2 = r.data.id;
for (const [op, score] of [["张三", 82], ["李四", 84], ["王五", 86]]) {
  await api("POST", `/api/groups/${G2}/records`, rec(op, score));
}
await api("POST", `/api/groups/${G2}/conclusion`, { text: "墨色层次好", grade: "良", submittedBy: "李四" });
const reviews = await Promise.all([
  api("POST", `/api/groups/${G2}/review`, { reviewer: "赵六", decision: "approve" }),
  api("POST", `/api/groups/${G2}/review`, { reviewer: "钱七", decision: "approve" })
]);
const okCount = reviews.filter(x => x.status === 200).length;
const conflictCount = reviews.filter(x => x.status === 409).length;
check("并发复核仅一次成功、其余 409", okCount === 1 && conflictCount === 1, JSON.stringify(reviews.map(x => x.status)));
r = await api("GET", `/api/groups/${G2}`);
check("结论只生效一次(v1)", r.data.conclusion.version === 1 && r.data.versions.length === 1);

// ---------- D. 越权修正 + 修正流程 ----------
console.log("\n== D. 越权修正与修正流程 ==");
r = await api("POST", `/api/groups/${G1}/conclusion`, { text: "想直接改结论", submittedBy: "张三" });
check("越权修正被拒：生效结论不能直接改(409)", r.status === 409 && r.data.error === "already_effective");
r = await api("POST", `/api/groups/${G1}/amendments`, { text: "改为良", modifiedBy: "周八" });
check("修正缺原因被拒(400)", r.status === 400);
r = await api("POST", `/api/groups/${G1}/amendments`, { text: "复测后定为良", grade: "良", reason: "补充环境记录后重新评估", modifiedBy: "周八" });
check("发起修正", r.status === 201);
r = await api("POST", `/api/groups/${G1}/amendments`, { text: "再修", reason: "x", modifiedBy: "周八" });
check("重复修正被拒(409)", r.status === 409);
r = await api("GET", `/api/groups/${G1}`);
check("修正期间查询仍返回旧版 v1", r.data.conclusion.version === 1 && r.data.conclusion.text === "出墨稳定，适合日常书写");
check("差异可见：旧→新", r.data.amendmentDiff.text.to === "复测后定为良" && r.data.amendmentDiff.baseVersion === 1);
r = await api("POST", `/api/groups/${G1}/amendments/review`, { reviewer: "周八", decision: "approve" });
check("越权复核被拒：复核人=修改人(403)", r.status === 403);
r = await api("POST", `/api/groups/${G1}/amendments/review`, { reviewer: "张三", decision: "approve" });
check("越权复核被拒：复核人参与过试磨(403)", r.status === 403);
r = await api("POST", `/api/groups/${G1}/amendments/review`, { reviewer: "吴十", decision: "approve" });
check("修正复核通过，整体切换 v2", r.status === 200 && r.data.conclusion.version === 2 && r.data.conclusion.text === "复测后定为良");
r = await api("GET", `/api/groups/${G1}`);
check("旧值保留：v1 在版本历史中", r.data.versions.length === 2 && r.data.versions[0].text === "出墨稳定，适合日常书写");
check("修正留痕：修改人/原因在案", r.data.conclusion.amendedBy === "周八" && Boolean(r.data.conclusion.amendReason));

// ---------- E. 驳回退回补测 + 回滚（失败不落半条数据） ----------
console.log("\n== E. 驳回补测与回滚 ==");
r = await api("POST", "/api/groups", { inkCode: "IS-T1", title: "第三组" });
const G3 = r.data.id;
await api("POST", `/api/groups/${G3}/records`, rec("张三", 81));
await api("POST", `/api/groups/${G3}/records`, rec("李四", 83));
r = await api("POST", `/api/groups/${G3}/conclusion`, { text: "提前结题", submittedBy: "张三" });
check("有效记录不足 3 条不能结题(422)", r.status === 422 && r.data.error === "insufficient_valid_records");
await api("POST", `/api/groups/${G3}/records`, rec("王五", 85));
await api("POST", `/api/groups/${G3}/conclusion`, { text: "可以结题", submittedBy: "张三" });
r = await api("POST", `/api/groups/${G3}/review`, { reviewer: "赵六", decision: "reject" });
check("驳回缺原因被拒(400)", r.status === 400);
r = await api("POST", `/api/groups/${G3}/review`, { reviewer: "赵六", decision: "reject", reason: "湿度记录缺失" });
check("驳回写明原因，退回补测", r.status === 200 && r.data.pending === null && r.data.needRetest === true);

const before = readFileSync(dbFile, "utf8");
await api("POST", `/api/groups/${G3}/review`, { reviewer: "赵六", decision: "approve" });          // 409 无待复核
await api("POST", `/api/groups/${G3}/records`, { operator: "", paper: "宣纸", water: 1, temperature: 2, humidity: 3, score: 4 }); // 400
await api("POST", `/api/groups/${G3}/amendments`, { text: "x", reason: "x", modifiedBy: "y" });    // 409 未生效
await api("POST", `/api/groups/${G1}/review`, { reviewer: "赵六", decision: "approve" });          // 409
await api("POST", `/api/groups/${G1}/amendments/review`, { reviewer: "赵六", decision: "approve" }); // 409
const after = readFileSync(dbFile, "utf8");
check("失败请求不落半条数据（库文件字节不变）", before === after);

await api("POST", `/api/groups/${G3}/records`, rec("孙九", 87));
r = await api("POST", `/api/groups/${G3}/conclusion`, { text: "补测后重新结题", grade: "良", submittedBy: "李四" });
check("补测后可重新结题", r.status === 201);
r = await api("POST", `/api/groups/${G3}/review`, { reviewer: "赵六", decision: "approve" });
check("再次复核通过生效", r.status === 200 && r.data.conclusion.version === 1);

// ---------- F. 重启后数据完好 ----------
console.log("\n== F. 重启 ==");
await stopServer();
await startServer();
r = await api("GET", `/api/groups/${G1}`);
check("重启后 G1 修正版 v2 仍在", r.data.conclusion.version === 2 && r.data.records.length === 6);
r = await api("GET", `/api/groups/${G3}`);
check("重启后 G3 结论生效、驳回历史在案", r.data.conclusion.version === 1 && r.data.history.some(h => h.type === "reject"));
r = await api("GET", "/api/groups");
check("重启后组列表完整", r.data.length === 3);

await stopServer();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
