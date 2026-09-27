/**
 * 接入面：命令包装器 tools/pigeon.sh —— 下发内容和源码逐字节一致；send、run 发出去的请求；/bin/sh 与 dash 都跑一遍。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, check, finish, makeEnv } from "./l1-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 命令包装器 ───────────────────────────────────────────────────────

console.log("\n★ 命令包装器 tools/pigeon.sh");
{
  const env = makeEnv();
  const served = await call(env, "GET", "/tools/pigeon.sh");
  check("★ /tools/pigeon.sh 下发的内容和仓库里的源码逐字节一致", served.status === 200 && served.text === readFileSync(join(ROOT, "tools/pigeon.sh"), "utf8"));
  check("按纯文字下发（浏览器里点开就能读）", (served.headers.get("content-type") ?? "").startsWith("text/plain"));

  // 一个本地服务收下包装器发来的请求，看它发了什么
  const got = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ method: req.method, url: req.url, auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) });
    const fail = req.headers.authorization === "Bearer wrongKey0000";
    res.writeHead(fail ? 404 : 200, { "content-type": "application/json" });
    res.end(fail ? '{"code":404,"message":"这个 key 不存在。先在 App 里注册，或检查有没有拼错"}' : '{"code":200,"message":"success"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  let home = "";
  const run = (shell, args, env = {}, input) =>
    new Promise((resolve) => {
      const child = spawn(shell, [join(ROOT, "tools/pigeon.sh"), ...args], {
        env: { PATH: process.env.PATH, HOME: home, PIGEON_SERVER: serverUrl, PIGEON_KEY: "testKey_123456", ...env },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });

  // CI（Linux）上的 /bin/sh 就是 dash；本机有 dash 的也用它跑一遍，确认没用到 bash 才有的写法
  const shells = ["/bin/sh", ...(existsSync("/bin/dash") && !process.env.PIGEON_SKIP_DASH ? ["/bin/dash"] : [])];
  for (const shell of shells) {
    console.log(`  （${shell}）`);
    // 每种 shell 一个干净的家目录：前一轮写下的 ~/.config/pigeon/key 不该影响这一轮
    home = mkdtempSync(join(tmpdir(), "pigeon-home-"));
    let r = await run(shell, ["send", '标题 "引号" \\ 反斜杠', "正文\n第二行"]);
    let last = got.at(-1);
    check("★ send：POST 到根路径，key 在 Authorization 里（不在地址里）", r.code === 0 && last?.method === "POST" && last.url === "/" && last.auth === "Bearer testKey_123456", `${r.code} ${r.err} ${JSON.stringify(last)}`);
    check("★ 引号、反斜杠、换行原样送到", last?.form.title === '标题 "引号" \\ 反斜杠' && last.form.body === "正文\n第二行", JSON.stringify(last?.form));
    r = await run(shell, ["send", "只有正文"]);
    check("send 一个参数：它是正文", got.at(-1)?.form.body === "只有正文" && got.at(-1)?.form.title === undefined);
    r = await run(shell, ["send", "磁盘", "-"], {}, "Filesystem  Use%\n/dev/disk1  93%\n");
    check("正文写 -：从标准输入读", got.at(-1)?.form.body === "Filesystem  Use%\n/dev/disk1  93%", JSON.stringify(got.at(-1)?.form));
    r = await run(shell, ["send", "--level", "timeSensitive", "--id", "d1", "--repeat", "5", "--url", "https://x.example", "t", "b"]);
    last = got.at(-1);
    check("选项照带：level、id、repeat、url", last?.form.level === "timeSensitive" && last.form.id === "d1" && last.form.repeat === "5" && last.form.url === "https://x.example", JSON.stringify(last?.form));

    r = await run(shell, ["run", "--id", "job1", "--", "sh", "-c", "echo one; echo two >&2; printf '\\033[31mred\\033[0m\\n'; exit 3"]);
    last = got.at(-1);
    check("★ run：命令的输出照常显示，退出码原样传出（3）", r.code === 3 && r.out.includes("one") && r.out.includes("two"), `${r.code} ${r.out}`);
    check("★ run 失败：标题「❌ 失败 · 命令」、时效性、带 id 时 status=firing", last?.form.title?.startsWith("❌ 失败 · sh -c") && last.form.level === "timeSensitive" && last.form.status === "firing" && last.form.id === "job1", JSON.stringify(last?.form));
    check("★ run 失败：正文有退出码、用时、最后几行（去掉颜色）", /^退出码 3 · 用时 \d+ 秒 · /.test(last?.form.body ?? "") && last.form.body.endsWith("最后 5 行：\none\ntwo\nred"), JSON.stringify(last?.form.body));
    r = await run(shell, ["run", "--id", "job1", "--title", "夜间备份", "--", "true"]);
    last = got.at(-1);
    check("★ run 成功：「✅ 成功」、带 id 时 status=resolved（停下上次失败的提醒）", r.code === 0 && last?.form.title === "✅ 成功 · 夜间备份" && last.form.status === "resolved" && last.form.level === undefined, JSON.stringify(last?.form));
    r = await run(shell, ["run", "--quiet", "--", "true"]);
    check("--quiet：成功的静默送达", got.at(-1)?.form.level === "passive");
    const seq = Array.from({ length: 8 }, (_, i) => `echo line${i + 1}`).join("; ");
    r = await run(shell, ["run", "--", "sh", "-c", seq]);
    check("只带最后 5 行", got.at(-1)?.form.body.endsWith("最后 5 行：\nline4\nline5\nline6\nline7\nline8"), JSON.stringify(got.at(-1)?.form.body));

    const count = got.length;
    r = await run(shell, ["send", "x"], { PIGEON_KEY: "A".repeat(43) });
    check("★ PIGEON_KEY 是 43 位的通道加密密钥：拒绝，什么也不发", r.code === 2 && r.err.includes("加密密钥") && got.length === count, `${r.code} ${r.err}`);
    r = await run(shell, ["send", "x"], { PIGEON_KEY: "" });
    check("没有 key：说清楚去哪里设，退出码 2", r.code === 2 && r.err.includes("~/.config/pigeon/key"), r.err);
    mkdirSync(join(home, ".config/pigeon"), { recursive: true });
    writeFileSync(join(home, ".config/pigeon/key"), "fileKey_654321\n");
    r = await run(shell, ["send", "从文件读 key"], { PIGEON_KEY: "" });
    check("★ key 从 ~/.config/pigeon/key 读", r.code === 0 && got.at(-1)?.auth === "Bearer fileKey_654321", `${r.err} ${JSON.stringify(got.at(-1))}`);
    r = await run(shell, ["send", "整个地址"], { PIGEON_KEY: `${serverUrl}/urlKey_111111` });
    check("PIGEON_KEY 写整个推送地址也行", r.code === 0 && got.at(-1)?.url === "/urlKey_111111" && got.at(-1)?.auth === undefined, JSON.stringify(got.at(-1)));
    r = await run(shell, ["send", "x"], { PIGEON_KEY: "wrongKey0000" });
    check("★ 推送失败：打印服务器给的中文原因，退出码 1", r.code === 1 && r.err.includes("HTTP 404") && r.err.includes("key 不存在"), r.err);
    r = await run(shell, ["run", "--", "sh", "-c", "exit 4"], { PIGEON_KEY: "wrongKey0000" });
    check("run 时通知推不出去：仍然传出命令的退出码", r.code === 4 && r.err.includes("通知没推出去"), `${r.code} ${r.err}`);
    r = await run(shell, ["send", "--titel", "x"]);
    check("不认识的选项 → 退出码 2", r.code === 2 && r.err.includes("--titel"), r.err);
    r = await run(shell, ["send", "a", "b", "c"]);
    check("send 参数太多（值里有空格没加引号）→ 退出码 2", r.code === 2 && r.err.includes("引号"), r.err);
    r = await run(shell, ["--help"]);
    check("--help 打印用法、退出码 0", r.code === 0 && r.out.includes("用法"));
    r = await run(shell, ["run"]);
    check("run 后面没有命令 → 退出码 2", r.code === 2);
  }
  server.close();
}

finish();
