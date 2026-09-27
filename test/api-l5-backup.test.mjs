/**
 * KV 备份脚本（scripts/backup-kv.mjs）的端到端测试：对本地 wrangler dev 用的那份 KV 导出、检查、演练恢复、真的恢复，
 * 恢复之后经 API 看数据真的回来了。
 *
 *   BASE=http://localhost:8799 node test/api-l5-backup.test.mjs
 *
 * 只按前缀导出这个文件自己建的几个键：本地库里攒着历次测试留下的上千个键，和这里要看的无关。
 * 最后一节演练灾难恢复：备份写进一个全新的本地库目录（--persist-to），整库再导一遍和原备份逐条比，
 * 再用这个目录起第二个 wrangler dev，拿原来的账号凭据调接口 —— 数据真的回来了、服务真的用得起来。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const BASE = process.env.BASE || "http://localhost:8799";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "pigeon-backup-test-"));

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

async function call(method, path, { body, secret } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null))?.data };
}

/** 跑备份脚本。stdin 给空：不是终端，--apply 不带 --yes 时应当拒绝。INIT_CWD 模拟 npm run 时敲命令的目录 */
function backup(args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/backup-kv.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input: "",
    env: { ...process.env, INIT_CWD: TMP },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function kv(args) {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "kv", "key", ...args, "--binding", "PIGEON_KV", "--local"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_LOG: "warn", WRANGLER_SEND_METRICS: "false" },
  });
  return r.stdout;
}

/** 让系统挑一个空闲端口 */
function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** 用给定的本地库目录起一个 wrangler dev，等它说 Ready。返回地址和收摊用的 stop */
async function startDev(persistTo) {
  const port = await freePort();
  const inspector = await freePort();
  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--port", String(port), "--inspector-port", String(inspector),
      "--persist-to", persistTo, "--var", "APNS_KEY_P8:"],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once("exit", done);
    child.kill();
  });
  for (let i = 0; i < 120 && !log.includes("Ready on http"); i++) await new Promise((r) => setTimeout(r, 500));
  return { base: log.includes("Ready on http") ? `http://localhost:${port}` : null, log: () => log, stop };
}

const digest = (entries) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const readDoc = (file) => JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
const writeDoc = (file, doc) => writeFileSync(file, gzipSync(JSON.stringify(doc)));

const run = Date.now().toString(36);
const created = await call("POST", "/account", {
  body: { device_token: `bk${run}`.repeat(64).slice(0, 64), environment: "sandbox", device_name: "备份测试机" },
});
const A = { id: created.data?.account_id, secret: created.data?.secret, channel: created.data?.channels?.[0] };
const prefixes = ["--prefix", `acct:${A.id}`, "--prefix", `chan:${A.channel?.id}`, "--prefix", `ch:${A.channel?.key}`];

console.log("\n导出");
let file;
{
  const r = backup(["--local", ...prefixes, "--out", TMP]);
  check("★ 导出成功", r.code === 0 && r.out.includes("已导出 3 个键"), r.out);
  file = readdirSync(TMP).filter((n) => n.endsWith(".json.gz")).map((n) => join(TMP, n))[0];
  check("文件名带时刻、标明来自本地库", file && /pigeon-kv-\d{8}-\d{6}-local\.json\.gz$/.test(file), String(file));
  check("★ 只有自己读得了（600）", file && (statSync(file).mode & 0o777) === 0o600, file && (statSync(file).mode & 0o777).toString(8));
  const doc = file ? readDoc(file) : {};
  check("★ 格式、版本、条数、校验和", doc.format === "pigeon-kv-backup" && doc.version === 1 && doc.count === 3 && doc.sha256 === digest(doc.entries ?? []), JSON.stringify({ ...doc, entries: undefined }));
  check("记下来源和命名空间", doc.source?.target === "local" && typeof doc.source?.namespace_id === "string" && doc.source?.prefixes?.length === 3);
  const account = doc.entries?.find((e) => e.key === `acct:${A.id}`);
  check("★ 值原样导出", account && JSON.parse(account.value).id === A.id && !account.base64, JSON.stringify(account));
  check("按键名排好", JSON.stringify(doc.entries?.map((e) => e.key)) === JSON.stringify(doc.entries?.map((e) => e.key).sort()));

  const again = backup(["--local", ...prefixes, "--out", file]);
  check("同名文件已经存在 → 不覆盖", again.code === 2 && again.out.includes("不覆盖"), again.out);
  const inside = backup(["--local", ...prefixes, "--out", ROOT]);
  check("★ 不许放进仓库目录", inside.code === 2 && inside.out.includes("不能放进仓库目录"), inside.out);
  const typo = backup(["--local", "--aply"]);
  check("拼错的参数直接报错", typo.code === 2 && typo.out.includes("不认识的参数"), typo.out);
}

console.log("\n检查备份");
{
  const ok = backup(["--verify", file]);
  check("★ 完好的备份 → 通过", ok.code === 0 && ok.out.includes("校验和一致") && ok.out.includes("3 个键"), ok.out);
  const relative = backup(["--verify", file.split("/").at(-1)]);
  check("相对路径按敲命令的目录解析（npm run 会切到仓库根目录）", relative.code === 0, relative.out);

  const doc = readDoc(file);
  const tampered = join(TMP, "tampered.json.gz");
  writeDoc(tampered, { ...doc, entries: doc.entries.map((e, i) => (i === 0 ? { ...e, value: `${e.value} ` } : e)) });
  const bad = backup(["--verify", tampered]);
  check("★ 内容被改过 → 校验和对不上", bad.code === 1 && bad.out.includes("校验和对不上"), bad.out);
  writeDoc(tampered, { ...doc, count: 5 });
  check("条数对不上", backup(["--verify", tampered]).out.includes("条数对不上"));
  const dup = [...doc.entries, doc.entries[0]];
  writeDoc(tampered, { ...doc, entries: dup, count: dup.length, sha256: digest(dup) });
  check("同一个键出现两次", backup(["--verify", tampered]).out.includes("出现了不止一次"));
  writeDoc(tampered, { ...doc, version: 2 });
  check("更新版本的格式 → 请先更新脚本", backup(["--verify", tampered]).out.includes("更新版本"));
  writeDoc(tampered, { hello: 1 });
  check("不是备份文件", backup(["--verify", tampered]).out.includes("不是信鸽的 KV 备份文件"));
  writeFileSync(tampered, "not gzip");
  check("不是 gzip", backup(["--verify", tampered]).out.includes("不是 gzip"));
}

console.log("\n恢复");
{
  const dry = backup(["--restore", file, "--local", ...prefixes]);
  check("★ 默认只是演练：说清会覆盖几个、什么都不写", dry.code === 0 && dry.out.includes("覆盖 3 个已有的") && dry.out.includes("这是演练"), dry.out);

  // 通道记录丢了：账号里就看不到这个通道
  kv(["delete", `chan:${A.channel.id}`]);
  const lost = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("删掉通道记录之后，账号里看不到它", lost.data?.channels?.length === 0, JSON.stringify(lost.data?.channels));
  const dry2 = backup(["--restore", file, "--local", ...prefixes]);
  check("★ 演练：新建 1 个、覆盖 2 个", dry2.out.includes("新建 1 个、覆盖 2 个已有的"), dry2.out);
  const noTty = backup(["--restore", file, "--local", ...prefixes, "--apply"]);
  check("★ 不在终端里、没带 --yes → 拒绝，什么都不写", noTty.code === 2 && noTty.out.includes("--yes") && kv(["get", `chan:${A.channel.id}`]) === "", noTty.out);
  const applied = backup(["--restore", file, "--local", ...prefixes, "--apply", "--yes"]);
  check("★ --apply --yes → 写回", applied.code === 0 && applied.out.includes("已写回 3 个键"), applied.out);
  const back = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("★ 恢复之后，通道又回到账号里（名字、key 都对）", back.data?.channels?.[0]?.id === A.channel.id && back.data?.channels?.[0]?.key === A.channel.key && back.data?.channels?.[0]?.name === A.channel.name, JSON.stringify(back.data?.channels));
  check("恢复用的临时文件已删", !readdirSync(tmpdir()).some((n) => n.startsWith("pigeon-restore-")));

  // metadata、过期时刻原样写回；已经过期的跳过
  const now = Math.floor(Date.now() / 1000);
  const entries = [
    { key: `l5bk:${run}:live`, value: "{\"at\":1}", metadata: { nextAt: 42 }, expiration: now + 3600 },
    { key: `l5bk:${run}:old`, value: "stale", expiration: now - 10 },
  ];
  const crafted = join(TMP, "crafted.json.gz");
  writeDoc(crafted, { format: "pigeon-kv-backup", version: 1, created_at_ms: Date.now(), source: { target: "local" }, count: 2, sha256: digest(entries), entries });
  const r = backup(["--restore", crafted, "--local", "--prefix", `l5bk:${run}`, "--apply", "--yes"]);
  check("★ 已经过期的跳过", r.code === 0 && r.out.includes("跳过 1 个") && r.out.includes("已写回 1 个键"), r.out);
  check("写回的值对", kv(["get", `l5bk:${run}:live`]) === "{\"at\":1}");
  check("过期的没写", kv(["get", `l5bk:${run}:old`]) === "");
  const out2 = join(TMP, "again.json.gz");
  const exported = backup(["--local", "--prefix", `l5bk:${run}`, "--out", out2]);
  const live = exported.code === 0 ? readDoc(out2).entries.find((e) => e.key === `l5bk:${run}:live`) : null;
  check("★ metadata 和过期时刻原样写回、再导出也一样", JSON.stringify(live?.metadata) === "{\"nextAt\":42}" && live?.expiration === now + 3600, JSON.stringify(live));
  kv(["delete", `l5bk:${run}:live`]);
}

console.log("\n灾难恢复演练：写进一份全新的本地库，再用它起服务");
{
  const fresh = join(TMP, "fresh-state");
  const missing = backup(["--persist-to", fresh, "--out", TMP]);
  check("导出一个不存在的本地库目录 → 报错（多半是路径敲错了，不导出一个空备份）", missing.code === 2 && missing.out.includes("本地库目录不存在"), missing.out);
  check("--persist-to 不能和 --verify 一起用", backup(["--verify", file, "--persist-to", fresh]).code === 2);

  const r = backup(["--restore", file, "--persist-to", fresh, "--apply", "--yes"]);
  check("★ 写进全新的目录：新建 3 个、覆盖 0 个", r.code === 0 && r.out.includes("新建 3 个、覆盖 0 个") && r.out.includes("已写回 3 个键"), r.out);
  check("说清楚写到了哪个目录", r.out.includes(fresh));

  const again = join(TMP, "fresh-export.json.gz");
  const exported = backup(["--persist-to", fresh, "--out", again]);
  const original = readDoc(file);
  const copy = exported.code === 0 ? readDoc(again) : {};
  check("★ 整库导出（不带前缀）：和原备份逐条相同，校验和一致", copy.count === 3 && copy.sha256 === original.sha256, exported.out);
  check("★ 仓库里给测试用的那份本地库没被碰：通道记录还是原来那份", kv(["get", `chan:${A.channel.id}`]) !== "" && JSON.parse(kv(["get", `chan:${A.channel.id}`])).id === A.channel.id);

  const dev = await startDev(fresh);
  check("用恢复出来的目录起得来 wrangler dev", dev.base !== null, dev.log().split("\n").slice(-8).join("\n"));
  if (dev.base) {
    const res = await fetch(`${dev.base}/account/${A.id}`, { headers: { authorization: `Bearer ${A.secret}` } });
    const view = (await res.json().catch(() => null))?.data;
    check("★ 原来的账号凭据照样认，通道、推送地址都在", res.status === 200 && view?.channels?.[0]?.id === A.channel.id && view?.channels?.[0]?.key === A.channel.key, `${res.status} ${JSON.stringify(view?.channels)}`);
    const wrong = await fetch(`${dev.base}/account/${A.id}`, { headers: { authorization: "Bearer not-the-secret" } });
    check("凭据不对照样 401（恢复的是摘要，不是把门打开）", wrong.status === 401, String(wrong.status));
    const other = await fetch(`${dev.base}/account/${created.data?.account_id}x`, { headers: { authorization: `Bearer ${A.secret}` } });
    check("备份里没有的账号：不存在", other.status === 401 || other.status === 404, String(other.status));
  }
  await dev.stop();
}

console.log("\n本地库过了一千个键");
{
  // 本地的 wrangler kv key list 只回第一页（1000 个）：脚本得自己翻页，否则备份悄悄少一截、检查照样通过
  const big = join(TMP, "big-state");
  const n = 1005;
  const entries = Array.from({ length: n }, (_, i) => ({ key: `l5big:${String(i).padStart(4, "0")}`, value: String(i) }));
  const seed = join(TMP, "big-seed.json.gz");
  writeDoc(seed, { format: "pigeon-kv-backup", version: 1, created_at_ms: Date.now(), source: { target: "local" }, count: n, sha256: digest(entries), entries });
  const put = backup(["--restore", seed, "--persist-to", big, "--apply", "--yes"]);
  check(`写进 ${n} 个键`, put.code === 0 && put.out.includes(`已写回 ${n} 个键`), put.out);
  const out = join(TMP, "big.json.gz");
  const exported = backup(["--persist-to", big, "--out", out]);
  const doc = exported.code === 0 ? readDoc(out) : {};
  check(`★ 导出 ${n} 个，一个不少`, doc.count === n && doc.entries?.at(-1)?.key === `l5big:${String(n - 1).padStart(4, "0")}`, exported.out.split("\n").slice(0, 4).join(" | "));
  check("★ 和写进去的逐条相同", doc.sha256 === digest(entries));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
