// 浏览器端到端验证：桌面 + 手机视口实际走通 打开详情/登记/结题/复核/修正
// 运行：PW_PATH=/tmp/pwtest/node_modules/playwright-core/index.js node browser-test.mjs
// （本地装有 playwright-core 时可直接 node browser-test.mjs）
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const pw = await import(process.env.PW_PATH || "playwright-core");
const chromium = pw.chromium || pw.default.chromium;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3041;
const BASE = `http://localhost:${PORT}`;
const dbFile = join(mkdtempSync(join(tmpdir(), "ink-e2e-")), "e2e-db.json");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const server = spawn("node", [join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile }, stdio: "inherit"
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BASE + "/api/items"); break; }
  catch { await new Promise(r => setTimeout(r, 150)); }
}

const browser = await chromium.launch();
const pageErrors = new Map();
function watch(page, tag) {
  page.on("pageerror", e => pageErrors.get(tag).push(String(e)));
}

// 登记一条试磨记录，并等待详情区渲染到第 n 条（提交后表单会重渲染，必须等渲染完成再进行下一步）
async function fillRecord(page, n, { operator, paper = "宣纸", water = 20, temperature = 22, humidity = 55, score = 85 }) {
  await page.waitForSelector("#recForm");
  await page.fill('#recForm input[name=operator]', operator);
  await page.fill('#recForm input[name=paper]', paper);
  await page.fill('#recForm input[name=water]', String(water));
  await page.fill('#recForm input[name=temperature]', String(temperature));
  await page.fill('#recForm input[name=humidity]', String(humidity));
  await page.fill('#recForm input[name=score]', String(score));
  await page.click('#recForm button');
  await page.waitForSelector('text=试磨记录（' + n + '）');
}

try {
  // ---------- 桌面流程 ----------
  console.log("== 桌面视口 1280x800 ==");
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dp = await desktop.newPage();
  pageErrors.set("desktop", []); watch(dp, "desktop");
  await dp.goto(BASE, { waitUntil: "networkidle" });

  await dp.selectOption("#inkSelect", { index: 0 });
  await dp.fill('#groupForm input[name=title]', "桌面流程组");
  await dp.fill('#groupForm input[name=createdBy]', "测试员");
  await dp.click("#groupForm button");
  await dp.waitForSelector(".card");
  check("桌面：创建试炼组出现卡片", await dp.locator(".card").count() === 1);

  await dp.click(".card");
  await dp.waitForSelector("#detail .panel");
  const detailText = await dp.textContent("#detail");
  check("桌面：点击卡片打开详情（无栈溢出，详情非空）", detailText.includes("登记试磨") && detailText.includes("试磨记录"));

  await fillRecord(dp, 1, { operator: "张三", score: 80 });
  await fillRecord(dp, 2, { operator: "李四", score: 85 });
  await fillRecord(dp, 3, { operator: "王五", score: 90 });
  await dp.waitForSelector("#conclForm");
  check("桌面：3 条有效记录后出现结题表单", true);

  await dp.fill('#conclForm textarea[name=text]', "出墨稳定，适合日常书写");
  await dp.selectOption('#conclForm select[name=grade]', "优");
  await dp.fill('#conclForm input[name=submittedBy]', "张三");
  await dp.click("#conclForm button");
  await dp.waitForSelector("#reviewForm");
  check("桌面：结题提交后进入待复核", (await dp.textContent("#detail")).includes("结题复核"));

  await dp.fill('#reviewForm input[name=reviewer]', "赵六");
  await dp.click('#reviewForm button[data-decision=approve]');
  await dp.waitForSelector("text=生效结论 · v1");
  check("桌面：复核通过结论 v1 生效", true);

  await dp.click("#detail details summary");
  await dp.fill('#amendForm textarea[name=text]', "复测后定为良");
  await dp.selectOption('#amendForm select[name=grade]', "良");
  await dp.fill('#amendForm input[name=reason]', "补充环境记录后重新评估");
  await dp.fill('#amendForm input[name=modifiedBy]', "周八");
  await dp.click("#amendForm button");
  await dp.waitForSelector("#amendReviewForm");
  const diffHtml = await dp.textContent("#detail");
  check("桌面：修正复核期间显示差异且仍生效 v1",
    diffHtml.includes("出墨稳定，适合日常书写") && diffHtml.includes("复测后定为良") && diffHtml.includes("生效结论 · v1"));

  await dp.fill('#amendReviewForm input[name=reviewer]', "吴十");
  await dp.click('#amendReviewForm button[data-decision=approve]');
  await dp.waitForSelector("text=生效结论 · v2");
  check("桌面：修正复核通过整体切换 v2", (await dp.textContent("#detail")).includes("复测后定为良"));
  check("桌面：版本历史保留 v1", await dp.locator("#detail .rec", { hasText: "v1" }).count() >= 1);

  // ---------- 手机流程 ----------
  console.log("== 手机视口 390x844 ==");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
  });
  const mp = await mobile.newPage();
  pageErrors.set("mobile", []); watch(mp, "mobile");
  await mp.goto(BASE, { waitUntil: "networkidle" });

  await mp.click('.card:has-text("桌面流程组")');
  await mp.waitForSelector("#detail .panel");
  check("手机：点击卡片打开桌面组详情", (await mp.textContent("#detail")).includes("生效结论 · v2"));
  await mp.click("#detail button.secondary");

  await mp.selectOption("#inkSelect", { index: 1 });
  await mp.fill('#groupForm input[name=title]', "手机流程组");
  await mp.click("#groupForm button");
  await mp.waitForSelector('.card:has-text("手机流程组")');
  await mp.click('.card:has-text("手机流程组")');
  await mp.waitForSelector("#recForm");
  check("手机：新建组并打开详情", true);

  await fillRecord(mp, 1, { operator: "张三", temperature: 40, score: 70 });   // 环境超差 → 失效
  check("手机：超差登记弹出失效提示", (await mp.textContent("#toast")).includes("失效"));
  await fillRecord(mp, 2, { operator: "李四", score: 82 });
  await fillRecord(mp, 3, { operator: "王五", score: 86 });
  await fillRecord(mp, 4, { operator: "孙九", score: 88 });
  check("手机：卡片显示需补测", await mp.locator('.card:has-text("手机流程组") .pill.bad', { hasText: "需补测" }).count() === 1);

  await mp.fill('#conclForm textarea[name=text]', "手机端结题");
  await mp.fill('#conclForm input[name=submittedBy]', "李四");
  await mp.click("#conclForm button");
  await mp.waitForSelector("#reviewForm");
  await mp.fill('#reviewForm input[name=reviewer]', "赵六");
  await mp.fill('#reviewForm input[name=reason]', "湿度记录缺失");
  await mp.click('#reviewForm button[data-decision=reject]');
  await mp.waitForSelector("#conclForm");
  check("手机：驳回后退回补测（回到可结题状态且有横幅）",
    await mp.locator(".banner").count() === 1 && (await mp.textContent(".banner")).includes("补测"));

  await fillRecord(mp, 5, { operator: "钱七", score: 84 });
  await mp.fill('#conclForm textarea[name=text]', "补测后重新结题");
  await mp.fill('#conclForm input[name=submittedBy]', "李四");
  await mp.click("#conclForm button");
  await mp.waitForSelector("#reviewForm");
  await mp.fill('#reviewForm input[name=reviewer]', "赵六");
  await mp.click('#reviewForm button[data-decision=approve]');
  await mp.waitForSelector("text=生效结论 · v1");
  check("手机：补测后重新结题并复核生效", true);
  check("手机：生效后卡片需补测徽标消失", await mp.locator('.card:has-text("手机流程组") .pill.bad', { hasText: "需补测" }).count() === 0);

  // ---------- 页面错误汇总 ----------
  for (const [tag, errs] of pageErrors) {
    check(`${tag === "desktop" ? "桌面" : "手机"}：全程无页面脚本错误`, errs.length === 0, errs.join(" | "));
  }
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
