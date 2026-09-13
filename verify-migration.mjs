// 旧版数据结构迁移验证：旧结论无 recordCount，按生效时间重建补测判断边界
// 运行：node verify-migration.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3198;
const BASE = `http://localhost:${PORT}`;
const dbFile = join(mkdtempSync(join(tmpdir(), "ink-migrate-")), "old-db.json");

// 旧版数据结构：conclusion 没有 recordCount 字段；R-old4 是生效前的失效记录
const oldDb = {
  items: [{ code: "IS-OLD", smokeSource: "老松烟", status: "已试磨", logs: [] }],
  groups: [{
    id: "G-old00001",
    inkCode: "IS-OLD",
    title: "旧版结论组",
    createdAt: "2026-08-01T09:00:00.000Z",
    records: [
      { id: "R-old1", at: "2026-08-01T10:00:00.000Z", operator: "张三", paper: "宣纸", water: 20, temperature: 22, humidity: 55, score: 80, valid: true, issues: [], clientToken: null },
      { id: "R-old2", at: "2026-08-01T10:05:00.000Z", operator: "李四", paper: "宣纸", water: 20, temperature: 22, humidity: 55, score: 85, valid: true, issues: [], clientToken: null },
      { id: "R-old3", at: "2026-08-01T10:10:00.000Z", operator: "王五", paper: "棉连纸", water: 18, temperature: 23, humidity: 58, score: 90, valid: true, issues: [], clientToken: null },
      { id: "R-old4", at: "2026-08-01T11:00:00.000Z", operator: "赵六", paper: "宣纸", water: 20, temperature: 40, humidity: 55, score: 70, valid: false, issues: ["环境超差：温度40℃不在15–30℃范围"], clientToken: null }
    ],
    pending: null,
    conclusion: {
      text: "出墨稳定，适合日常书写", grade: "优", avgScore: 85, validCount: 3,
      recordIds: ["R-old1", "R-old2", "R-old3"],
      submittedBy: "张三", at: "2026-08-02T09:00:00.000Z",
      version: 1, effectiveAt: "2026-08-02T10:00:00.000Z",
      review: { reviewer: "周八", at: "2026-08-02T10:00:00.000Z" }
    },
    amendment: null,
    versions: [{
      text: "出墨稳定，适合日常书写", grade: "优", avgScore: 85, validCount: 3,
      recordIds: ["R-old1", "R-old2", "R-old3"],
      submittedBy: "张三", at: "2026-08-02T09:00:00.000Z",
      version: 1, effectiveAt: "2026-08-02T10:00:00.000Z",
      review: { reviewer: "周八", at: "2026-08-02T10:00:00.000Z" }
    }],
    history: [
      { type: "create", at: "2026-08-01T09:00:00.000Z", by: "组长", note: "创建试炼组「旧版结论组》" },
      { type: "approve", at: "2026-08-02T10:00:00.000Z", by: "周八", note: "复核通过，结论v1生效" }
    ]
  }]
};
writeFileSync(dbFile, JSON.stringify(oldDb, null, 2));
const conclusionSnapshot = JSON.stringify(oldDb.groups[0].conclusion);
const versionsSnapshot = JSON.stringify(oldDb.groups[0].versions);

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

let child;
async function startServer() {
  child = spawn("node", [join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile }, stdio: "inherit"
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

console.log("== 用旧版数据结构启动 ==");
await startServer();

let r = await api("GET", "/api/groups");
check("旧组加载：结论 v1 生效中", r.data[0].version === 1 && r.data[0].status === "effective");
check("生效前的失效记录不触发补测提示", r.data[0].needRetest === false && r.data[0].invalidCount === 1);

r = await api("POST", "/api/groups/G-old00001/records", {
  operator: "孙九", paper: "宣纸", water: 20, temperature: 45, humidity: 55, score: 66
});
check("升级后追加超差记录判失效", r.status === 201 && r.data.record.valid === false);
r = await api("GET", "/api/groups");
check("新增失效记录触发需补测提示", r.data[0].needRetest === true);

r = await api("POST", "/api/groups/G-old00001/records", {
  operator: "张三", paper: "宣纸", water: 20, temperature: 22, humidity: 55, score: 80
});
check("追加重复记录判失效", r.status === 201 && r.data.record.issues.some(i => i.includes("重复记录")));
r = await api("GET", "/api/groups/G-old00001");
check("提示保持（两条新增失效）", r.data.needRetest === true && r.data.records.length === 6);

const onDisk = JSON.parse(readFileSync(dbFile, "utf8"));
check("旧结论未被改写（无 recordCount 回填、内容不变）",
  JSON.stringify(onDisk.groups[0].conclusion) === conclusionSnapshot &&
  !("recordCount" in onDisk.groups[0].conclusion));
check("版本历史未被改写", JSON.stringify(onDisk.groups[0].versions) === versionsSnapshot);
check("历史记录只增不改（原有 2 条保留）",
  onDisk.groups[0].history.length === 4 &&
  onDisk.groups[0].history[0].type === "create" && onDisk.groups[0].history[1].type === "approve");

console.log("\n== 重启后判断一致 ==");
await stopServer();
await startServer();
r = await api("GET", "/api/groups");
check("重启后需补测提示仍为是", r.data[0].needRetest === true);
r = await api("GET", "/api/groups/G-old00001");
check("重启后结论与记录完整", r.data.conclusion.version === 1 && r.data.records.length === 6);

await stopServer();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
