/**
 * 适配器渲染测试：真实 webhook payload 进去，人看得懂的通知出来。
 *
 * 这是产品的差异化所在，也是最容易悄悄退化的地方 —— 上游改一次字段名，
 * 通知就会变成 "undefined · undefined"，而推送本身仍然是 200，
 * 不测就只能等用户来报。
 */
import { digest24, getAdapter, readableId } from "../.test-build/adapters.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

/** 有的适配器要算摘要，是异步的；统一 await */
async function render(name, body, headerPairs = {}) {
  const adapter = getAdapter(name);
  if (!adapter) throw new Error(`找不到适配器 ${name}`);
  return await adapter.render(body, new Headers(headerPairs));
}

/** 通知里不该出现 undefined / null / [object Object] */
function isClean(params) {
  const text = [params.title, params.subtitle, params.body].filter(Boolean).join(" ");
  return !/undefined|null|\[object Object\]/.test(text);
}

console.log("\nGitHub");
{
  const failed = await render("github", {
    repository: { full_name: "nfo/server" },
    sender: { login: "wynn" },
    workflow_run: {
      name: "CI", status: "completed", conclusion: "failure",
      run_number: 412, head_branch: "main",
      html_url: "https://github.com/nfo/server/actions/runs/1",
    },
  }, { "x-github-event": "workflow_run" });

  check("CI 失败会推", failed !== null);
  check("标题带上仓库和结论", /CI/.test(failed.title) && /nfo\/server/.test(failed.title), failed?.title);
  check("正文有分支和构建号", /main/.test(failed.body) && /412/.test(failed.body), failed?.body);
  check("失败用 timeSensitive", failed.level === "timeSensitive", failed?.level);
  check("带上跳转链接", Boolean(failed.url));
  check("没有 undefined 漏出来", isClean(failed), JSON.stringify(failed));

  const success = await render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    workflow_run: { name: "CI", status: "completed", conclusion: "success", run_number: 413 },
  }, { "x-github-event": "workflow_run" });
  check("CI 成功不推（不然每次提交都响）", success === null);

  const queued = await render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    workflow_run: { name: "CI", status: "queued" },
  }, { "x-github-event": "workflow_run" });
  check("排队中不推", queued === null);

  check("ping 不推", await render("github", { zen: "hi", repository: { full_name: "a/b" } },
    { "x-github-event": "ping" }) === null);

  const pushed = await render("github", {
    repository: { full_name: "nfo/server" }, pusher: { name: "wynn" },
    sender: { login: "wynn" }, ref: "refs/heads/main",
    commits: [{}, {}, {}], head_commit: { message: "修掉 p8 解析" },
    compare: "https://github.com/nfo/server/compare/a...b",
  }, { "x-github-event": "push" });
  check("push 事件：分支名去掉 refs/heads/", pushed.title.endsWith("main"), pushed?.title);
  check("push 事件：数得出 commit 数", /3 个 commit/.test(pushed.subtitle), pushed?.subtitle);
  check("push 事件干净", isClean(pushed), JSON.stringify(pushed));

  const pr = await render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    action: "opened", pull_request: { number: 7, title: "加适配器", html_url: "https://x" },
  }, { "x-github-event": "pull_request" });
  check("PR opened 会推且编号正确", /#7/.test(pr.title) && /新建/.test(pr.title), pr?.title);
  check("PR 的琐碎动作不推",
    await render("github", { repository: { full_name: "a/b" }, sender: { login: "w" }, action: "labeled",
      pull_request: { number: 7 } }, { "x-github-event": "pull_request" }) === null);

  const unknown = await render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" }, action: "created",
  }, { "x-github-event": "discussion" });
  check("没专门处理的事件也给出可读通知", unknown !== null && isClean(unknown), JSON.stringify(unknown));
}

console.log("\nGrafana");
{
  const firing = await render("grafana", {
    status: "firing",
    alerts: [{
      labels: { alertname: "HighCPU", instance: "api-01", severity: "critical" },
      annotations: { summary: "CPU 使用率 95%，持续 5 分钟" },
      generatorURL: "https://grafana/d/abc",
    }],
  });
  check("触发时标题可读", /HighCPU/.test(firing.title) && /触发/.test(firing.title), firing?.title);
  check("正文取 annotations.summary", /95%/.test(firing.body), firing?.body);
  check("critical 用 timeSensitive", firing.level === "timeSensitive", firing?.level);
  check("id 是定长摘要（没有 groupKey 时退回告警名）", firing.id === `grafana-${await digest24("HighCPU")}`, firing?.id);
  check("干净", isClean(firing), JSON.stringify(firing));

  const resolved = await render("grafana", {
    status: "resolved",
    alerts: [{ labels: { alertname: "HighCPU" }, annotations: {} }],
  });
  check("恢复也推，但降到 passive", resolved.level === "passive", resolved?.level);
  check("恢复与触发 id 相同（能合并成一条）", resolved.id === firing.id);

  const bare = await render("grafana", { status: "firing", alerts: [] });
  check("空 alerts 不崩且仍可读", bare !== null && isClean(bare), JSON.stringify(bare));
}

console.log("\nUptime Kuma");
{
  const down = await render("uptimekuma", {
    heartbeat: { status: "0", msg: "connect ETIMEDOUT" },
    monitor: { name: "nfo.im", url: "https://nfo.im" },
  });
  check("掉线标题可读", /掉线/.test(down.title) && /nfo\.im/.test(down.title), down?.title);
  check("掉线用 timeSensitive", down.level === "timeSensitive");
  check("带上监控地址", down.url === "https://nfo.im");

  const up = await render("uptimekuma", {
    heartbeat: { status: "1", msg: "200 - OK" },
    monitor: { name: "nfo.im" },
  });
  check("恢复用 passive", up.level === "passive");
  check("掉线和恢复能折叠成一条", up.id === down.id, `${up?.id} vs ${down?.id}`);

  const test = await render("uptimekuma", { msg: "Testing" });
  check("测试推送（无 heartbeat）不崩", test !== null && isClean(test), JSON.stringify(test));
}

console.log("\n畸形输入");
{
  for (const name of ["github", "grafana", "uptimekuma"]) {
    for (const [label, body] of [["空对象", {}], ["null", null], ["字符串", "nope"]]) {
      let outcome = "抛异常";
      try {
        const r = await render(name, body, { "x-github-event": "push" });
        outcome = r === null || isClean(r) ? "ok" : `脏输出 ${JSON.stringify(r)}`;
      } catch (err) {
        outcome = `抛异常 ${err.message}`;
      }
      check(`${name} / ${label}`, outcome === "ok", outcome);
    }
  }
}

console.log("\n事件状态（App 靠它算持续了多久）");
{
  const f = await render("grafana", { status: "firing", alerts: [{ labels: { alertname: "HighCPU" } }] });
  const r = await render("grafana", { status: "resolved", alerts: [{ labels: { alertname: "HighCPU" } }] });
  check("Grafana 触发 → firing", f.status === "firing");
  check("Grafana 恢复 → resolved，且与触发同一个 id", r.status === "resolved" && r.id === f.id);
  const d = await render("uptimekuma", { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "官网" } });
  const u = await render("uptimekuma", { heartbeat: { status: 1, msg: "OK" }, monitor: { name: "官网" } });
  check("Uptime Kuma 掉线 → firing", d.status === "firing");
  check("Uptime Kuma 恢复 → resolved，且同一个 id", u.status === "resolved" && u.id === d.id);
  check("测试推送不带状态", (await render("uptimekuma", { msg: "Testing" })).status === undefined);
}

// ── 各家事件的样本：每种都照真实 payload 的形状写一条 ────────────────────

const REPO = { full_name: "nfo/server", html_url: "https://github.com/nfo/server" };
const gh = (event, body) => render("github", { repository: REPO, sender: { login: "wynn" }, ...body }, { "x-github-event": event });
const run = (conclusion) => gh("workflow_run", {
  workflow_run: { name: "CI", status: "completed", conclusion, run_number: 9, head_branch: "main", html_url: "https://x/runs/9" },
});

console.log("\nGitHub：构建结论");
{
  for (const conclusion of ["cancelled", "skipped", "neutral", "stale", "success"]) {
    check(`★ ${conclusion} 不推（并发组自动取消旧构建很常见，不该半夜响）`, (await run(conclusion)) === null);
  }
  for (const [conclusion, text] of [["failure", "失败"], ["timed_out", "超时"], ["startup_failure", "没能启动"]]) {
    const r = await run(conclusion);
    check(`★ ${conclusion} 按失败推：标题写「${text}」，timeSensitive`, r?.title === `CI ${text} · nfo/server` && r.level === "timeSensitive", JSON.stringify(r));
  }
  const approval = await run("action_required");
  check("★ action_required →「需要审批」，普通级别（要人动手，不是故障）", approval?.title === "CI 需要审批 · nfo/server" && approval.level === "active", JSON.stringify(approval));
  const odd = await run("something_new");
  check("没见过的结论照实写出来，但不吵人", odd?.title.includes("something_new") && odd.level === "passive" && isClean(odd), JSON.stringify(odd));
  check("标题里不再出现英文结论", !/failure|timed_out|startup_failure/.test((await run("failure")).title + (await run("timed_out")).title));
  check("结论是原型上的名字也不出错", (await run("constructor"))?.level === "passive");
}

console.log("\nGitHub：PR 与 Issue");
{
  const merged = await gh("pull_request", { action: "closed", pull_request: { number: 12, title: "加重试", merged: true, html_url: "https://x/pull/12" } });
  check("★ 合并的 PR 显示「已合并」（原先报成「已关闭」）", merged?.title === "PR #12 已合并 · nfo/server", merged?.title);
  const closed = await gh("pull_request", { action: "closed", pull_request: { number: 13, title: "不要了", merged: false } });
  check("没合并就关掉的 PR 仍是「已关闭」", closed?.title === "PR #13 已关闭 · nfo/server", closed?.title);
  const issue = await gh("issues", { action: "closed", issue: { number: 5, title: "崩了" } });
  check("Issue 关闭仍是「已关闭」", issue?.title === "Issue #5 已关闭 · nfo/server", issue?.title);
  const reopened = await gh("pull_request", { action: "reopened", pull_request: { number: 13, title: "还是要", merged: false } });
  check("重开照旧", reopened?.title === "PR #13 已重开 · nfo/server", reopened?.title);
}

console.log("\nGitHub：push 的几种样子");
{
  const deleted = await gh("push", { ref: "refs/heads/feature/x", deleted: true, created: false, commits: [], head_commit: null, compare: "https://x/compare/abc...000" });
  check("★ 删分支 →「删除了分支 X」，不是「推送了 0 个 commit」", deleted?.body === "wynn 删除了分支 feature/x" && !/0 个 commit/.test(JSON.stringify(deleted)), JSON.stringify(deleted));
  check("删分支的标题是分支名", deleted?.title === "nfo/server · feature/x", deleted?.title);
  check("删分支安静推", deleted?.level === "passive" && isClean(deleted));

  const tag = await gh("push", { ref: "refs/tags/v1.2.0", created: true, deleted: false, commits: [], head_commit: { message: "发版" }, compare: "https://x/compare/v1.2.0" });
  check("★ 推标签 →「推送了标签 vX」，标题不带 refs/tags/", tag?.body === "wynn 推送了标签 v1.2.0" && tag.title === "nfo/server · v1.2.0", JSON.stringify(tag));
  const untag = await gh("push", { ref: "refs/tags/v1.2.0", deleted: true, commits: [] });
  check("删标签 →「删除了标签 X」", untag?.body === "wynn 删除了标签 v1.2.0", untag?.body);

  const branch = await gh("push", { ref: "refs/heads/hotfix", created: true, commits: [], head_commit: { message: "旧提交" }, compare: "https://x/compare/hotfix" });
  check("从已有提交拉新分支 →「新建了分支 X」", branch?.body === "wynn 新建了分支 hotfix", branch?.body);
}

console.log("\nGitHub：CI 噪声事件不推");
{
  for (const event of ["check_run", "check_suite", "workflow_job", "status", "deployment_status"]) {
    check(`★ ${event} 不推（勾了全部事件时每次 CI 会来几十条）`, (await gh(event, { action: "completed" })) === null);
  }
  const star = await gh("star", { action: "created" });
  check("别的事件照旧给一条可读的通知", star !== null && star.level === "passive" && isClean(star), JSON.stringify(star));
}

console.log("\nUptime Kuma：状态");
{
  const kuma = (status, extra = {}) => render("uptimekuma", {
    heartbeat: { status, msg: extra.msg ?? "" },
    monitor: { id: 17, name: "官网", url: "https://nfo.im" },
    msg: "[官网] 状态变化",
  });
  const pending = await kuma(2, { msg: "timeout, retrying" });
  check("★ 2 = PENDING →「待确认」，passive，不算掉线", pending.title === "⏳ 待确认 · 官网" && pending.level === "passive" && !/掉线/.test(pending.title), JSON.stringify(pending));
  check("待确认不带 firing（还不是一次故障）", pending.status === undefined);
  const maintenance = await kuma(3);
  check("★ 3 = MAINTENANCE →「维护中」，passive，不带 firing", maintenance.title === "🔧 维护中 · 官网" && maintenance.level === "passive" && maintenance.status === undefined, JSON.stringify(maintenance));
  check("维护中没有说明时给一句中文", maintenance.body === "处于维护时段", maintenance.body);
  const down = await kuma(0, { msg: "connect ECONNREFUSED" });
  check("只有 0 是掉线", down.title === "🔴 掉线 · 官网" && down.status === "firing" && down.level === "timeSensitive");
  const weird = await kuma(9);
  check("不认识的状态不报掉线，安静推", !/掉线/.test(weird.title) && weird.level === "passive" && isClean(weird), JSON.stringify(weird));
  check("状态是原型上的名字也不出错", (await kuma("constructor")).level === "passive");

  check("★ id 用 monitor.id：kuma-17", down.id === "kuma-17", down.id);
  const sameName = await render("uptimekuma", { heartbeat: { status: 0 }, monitor: { id: 18, name: "官网" } });
  check("★ 同名的两个监控 id 不同，不会互相覆盖", sameName.id === "kuma-18" && sameName.id !== down.id);
  const longName = "这是一个名字特别特别长的中文监控项目用来测试折叠标识会不会超长";
  const legacy = await render("uptimekuma", { heartbeat: { status: 0 }, monitor: { name: longName } });
  check("没有 monitor.id 时退回名字摘要，长度固定、不超过 64 字节", legacy.id === `kuma-${await digest24(longName)}` && new TextEncoder().encode(legacy.id).length <= 64, legacy.id);
  const legacyUp = await render("uptimekuma", { heartbeat: { status: 1 }, monitor: { name: longName } });
  check("同一个监控的掉线和恢复摘要相同，照样折叠", legacyUp.id === legacy.id);
}

console.log("\nUptime Kuma：没有 heartbeat 的通知");
{
  const cert = await render("uptimekuma", { heartbeat: null, monitor: null, msg: "[官网][https://nfo.im/status] server certificate nfo.im will be expired in 7 days" });
  check("★ 证书到期提醒 →「证书 7 天后到期」", cert?.title === "证书 7 天后到期 · 官网", cert?.title);
  check("★ 7 天以内用 timeSensitive", cert?.level === "timeSensitive");
  check("★ id 是 kuma-cert-{host}，几次提醒折叠成一条", cert?.id === "kuma-cert-nfo.im", cert?.id);
  check("正文是中文，说清楚是哪张证书", cert?.body.includes("nfo.im") && cert.body.includes("7 天") && !/will be expired/.test(cert.body), cert?.body);
  check("带上监控的地址", cert?.url === "https://nfo.im/status");
  check("不是「已接通」", !/已接通/.test(cert?.title ?? ""));

  const later = await render("uptimekuma", { heartbeat: null, monitor: null, msg: "[官网][https://nfo.im] server certificate nfo.im will be expired in 21 days" });
  check("还有 21 天：普通级别", later?.title === "证书 21 天后到期 · 官网" && later.level === "active", JSON.stringify(later));
  check("同一个站点的提醒 id 相同", later?.id === cert?.id);
  const today = await render("uptimekuma", { msg: "[内网][https://intra.example] intermediate CA certificate R3 will be expired in 0 days" });
  check("0 天：今天到期", today?.title === "证书今天到期 · 内网" && today.level === "timeSensitive", today?.title);
  const domain = await render("uptimekuma", { msg: "[官网][https://nfo.im] Domain nfo.im will expire in 5 days" });
  check("★ 域名到期也认：「域名 5 天后到期」，id 是 kuma-domain-{host}", domain?.title === "域名 5 天后到期 · 官网" && domain.id === "kuma-domain-nfo.im", JSON.stringify(domain));
  const longHost = `${"sub".repeat(20)}.example.com`;
  const long = await render("uptimekuma", { msg: `[x][https://${longHost}] server certificate ${longHost} will be expired in 3 days` });
  check("主机名太长时 id 换成摘要，不超过 64 字节", long?.id === await readableId("kuma-cert-", longHost) && new TextEncoder().encode(long.id).length <= 64, long?.id);

  const test = await render("uptimekuma", { heartbeat: null, monitor: null, msg: "我的信鸽 Testing" });
  check("★ 测试文案 →「已接通」", test?.title === "Uptime Kuma 已接通" && test.level === "passive", JSON.stringify(test));
  const other = await render("uptimekuma", { heartbeat: null, monitor: null, msg: "Monitor paused by admin" });
  check("★ 别的没有 heartbeat 的通知不再冒充「已接通」", other !== null && !/已接通/.test(other.title) && other.body === "Monitor paused by admin", JSON.stringify(other));
  check("什么都没有的请求不推", (await render("uptimekuma", { heartbeat: null })) === null);
}

console.log("\nGrafana：分组 id 与状态");
{
  const groupKey = '{}/{__grafana_autogenerated__="true"}/{__grafana_receiver__="pigeon"}:{alertname="磁盘空间不足告警规则在生产环境多台主机上触发"}';
  const alert = (instance, status, fingerprint) => ({
    status, fingerprint,
    labels: { alertname: "磁盘空间不足告警规则在生产环境多台主机上触发", instance },
    annotations: { summary: `${instance} 磁盘剩余 3%` },
  });
  const f = await render("grafana", { status: "firing", groupKey, alerts: [alert("db-01", "firing", "aaa111")] });
  const r = await render("grafana", { status: "resolved", groupKey, alerts: [alert("db-01", "resolved", "aaa111")] });
  check("★ id = grafana- + groupKey 摘要的前 24 位", f.id === `grafana-${await digest24(groupKey)}` && f.id.length === "grafana-".length + 24, f.id);
  check("★ 中文长告警名也不超过 64 字节（原先超了就没法折叠）", new TextEncoder().encode(f.id).length <= 64);
  check("同一组的触发和恢复 id 相同", r.id === f.id && r.status === "resolved");

  const otherGroup = await render("grafana", { status: "firing", groupKey: groupKey.replace("pigeon", "ops"), alerts: [alert("db-02", "firing", "bbb222")] });
  check("★ 按实例分组时各组 id 不同：一台恢复不会把别的主机标成恢复", otherGroup.id !== f.id);
  const noKey = await render("grafana", { status: "firing", alerts: [alert("db-03", "firing", "ccc333")] });
  check("没有 groupKey 时用第一条告警的 fingerprint", noKey.id === `grafana-${await digest24("ccc333")}`, noKey.id);

  for (const odd of ["pending", "", undefined, "constructor"]) {
    const u = await render("grafana", { ...(odd === undefined ? {} : { status: odd }), alerts: [alert("db-01", "firing", "aaa111")] });
    check(`★ 状态 ${JSON.stringify(odd)} 不再当「恢复」：按触发处理并写明状态未知`, u.status === "firing" && /状态未知/.test(u.title) && !/恢复/.test(u.title) && u.level !== "passive", JSON.stringify(u));
  }
  const legacyFiring = await render("grafana", { state: "alerting", ruleName: "HighCPU", message: "CPU 95%", ruleUrl: "https://grafana/r/1" });
  check("旧版告警 state=alerting → 触发", legacyFiring.status === "firing" && legacyFiring.title === "🔴 触发 · HighCPU" && legacyFiring.url === "https://grafana/r/1", JSON.stringify(legacyFiring));
  const legacyOk = await render("grafana", { state: "ok", ruleName: "HighCPU" });
  check("旧版告警 state=ok → 恢复", legacyOk.status === "resolved" && legacyOk.id === legacyFiring.id, JSON.stringify(legacyOk));

  const mixed = await render("grafana", {
    status: "firing", groupKey,
    alerts: [alert("db-01", "firing", "a"), alert("db-02", "firing", "b"), alert("db-03", "resolved", "c")],
  });
  check("★ 一次多条：按各条状态数「2 条触发 · 1 条恢复」，不拿第一条的实例名配整组", mixed.subtitle?.includes("2 条触发") && mixed.subtitle.includes("1 条恢复") && !mixed.subtitle.includes("db-01"), mixed.subtitle);
  const critical = await render("grafana", {
    status: "firing", groupKey,
    alerts: [alert("db-01", "firing", "a"), { ...alert("db-02", "firing", "b"), labels: { alertname: "x", severity: "critical" } }],
  });
  check("组里有一条在触发的 critical 就用 timeSensitive", critical.level === "timeSensitive", critical.level);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
