/**
 * 适配器渲染测试：真实 webhook payload 进去，人看得懂的通知出来。
 *
 * 这是产品的差异化所在，也是最容易悄悄退化的地方 —— 上游改一次字段名，
 * 通知就会变成 "undefined · undefined"，而推送本身仍然是 200，
 * 不测就只能等用户来报。
 */
import { getAdapter } from "../.test-build/adapters.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function render(name, body, headerPairs = {}) {
  const adapter = getAdapter(name);
  if (!adapter) throw new Error(`找不到适配器 ${name}`);
  return adapter.render(body, new Headers(headerPairs));
}

/** 通知里不该出现 undefined / null / [object Object] */
function isClean(params) {
  const text = [params.title, params.subtitle, params.body].filter(Boolean).join(" ");
  return !/undefined|null|\[object Object\]/.test(text);
}

console.log("\nGitHub");
{
  const failed = render("github", {
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

  const success = render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    workflow_run: { name: "CI", status: "completed", conclusion: "success", run_number: 413 },
  }, { "x-github-event": "workflow_run" });
  check("CI 成功不推（不然每次提交都响）", success === null);

  const queued = render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    workflow_run: { name: "CI", status: "queued" },
  }, { "x-github-event": "workflow_run" });
  check("排队中不推", queued === null);

  check("ping 不推", render("github", { zen: "hi", repository: { full_name: "a/b" } },
    { "x-github-event": "ping" }) === null);

  const pushed = render("github", {
    repository: { full_name: "nfo/server" }, pusher: { name: "wynn" },
    sender: { login: "wynn" }, ref: "refs/heads/main",
    commits: [{}, {}, {}], head_commit: { message: "修掉 p8 解析" },
    compare: "https://github.com/nfo/server/compare/a...b",
  }, { "x-github-event": "push" });
  check("push 事件：分支名去掉 refs/heads/", pushed.title.endsWith("main"), pushed?.title);
  check("push 事件：数得出 commit 数", /3 个 commit/.test(pushed.subtitle), pushed?.subtitle);
  check("push 事件干净", isClean(pushed), JSON.stringify(pushed));

  const pr = render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" },
    action: "opened", pull_request: { number: 7, title: "加适配器", html_url: "https://x" },
  }, { "x-github-event": "pull_request" });
  check("PR opened 会推且编号正确", /#7/.test(pr.title) && /新建/.test(pr.title), pr?.title);
  check("PR 的琐碎动作不推",
    render("github", { repository: { full_name: "a/b" }, sender: { login: "w" }, action: "labeled",
      pull_request: { number: 7 } }, { "x-github-event": "pull_request" }) === null);

  const unknown = render("github", {
    repository: { full_name: "nfo/server" }, sender: { login: "wynn" }, action: "created",
  }, { "x-github-event": "discussion" });
  check("没专门处理的事件也给出可读通知", unknown !== null && isClean(unknown), JSON.stringify(unknown));
}

console.log("\nGrafana");
{
  const firing = render("grafana", {
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
  check("触发和恢复用同一个 id 折叠", firing.id === "grafana-HighCPU", firing?.id);
  check("干净", isClean(firing), JSON.stringify(firing));

  const resolved = render("grafana", {
    status: "resolved",
    alerts: [{ labels: { alertname: "HighCPU" }, annotations: {} }],
  });
  check("恢复也推，但降到 passive", resolved.level === "passive", resolved?.level);
  check("恢复与触发 id 相同（能合并成一条）", resolved.id === firing.id);

  const bare = render("grafana", { status: "firing", alerts: [] });
  check("空 alerts 不崩且仍可读", bare !== null && isClean(bare), JSON.stringify(bare));
}

console.log("\nUptime Kuma");
{
  const down = render("uptimekuma", {
    heartbeat: { status: "0", msg: "connect ETIMEDOUT" },
    monitor: { name: "nfo.im", url: "https://nfo.im" },
  });
  check("掉线标题可读", /掉线/.test(down.title) && /nfo\.im/.test(down.title), down?.title);
  check("掉线用 timeSensitive", down.level === "timeSensitive");
  check("带上监控地址", down.url === "https://nfo.im");

  const up = render("uptimekuma", {
    heartbeat: { status: "1", msg: "200 - OK" },
    monitor: { name: "nfo.im" },
  });
  check("恢复用 passive", up.level === "passive");
  check("掉线和恢复能折叠成一条", up.id === down.id, `${up?.id} vs ${down?.id}`);

  const test = render("uptimekuma", { msg: "Testing" });
  check("测试推送（无 heartbeat）不崩", test !== null && isClean(test), JSON.stringify(test));
}

console.log("\n畸形输入");
{
  for (const name of ["github", "grafana", "uptimekuma"]) {
    for (const [label, body] of [["空对象", {}], ["null", null], ["字符串", "nope"]]) {
      let outcome = "抛异常";
      try {
        const r = render(name, body, { "x-github-event": "push" });
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
  const f = render("grafana", { status: "firing", alerts: [{ labels: { alertname: "HighCPU" } }] });
  const r = render("grafana", { status: "resolved", alerts: [{ labels: { alertname: "HighCPU" } }] });
  check("Grafana 触发 → firing", f.status === "firing");
  check("Grafana 恢复 → resolved，且与触发同一个 id", r.status === "resolved" && r.id === f.id);
  const d = render("uptimekuma", { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "官网" } });
  const u = render("uptimekuma", { heartbeat: { status: 1, msg: "OK" }, monitor: { name: "官网" } });
  check("Uptime Kuma 掉线 → firing", d.status === "firing");
  check("Uptime Kuma 恢复 → resolved，且同一个 id", u.status === "resolved" && u.id === d.id);
  check("测试推送不带状态", render("uptimekuma", { msg: "Testing" }).status === undefined);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
