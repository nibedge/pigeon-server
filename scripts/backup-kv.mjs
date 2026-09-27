#!/usr/bin/env node
/**
 * KV 备份与恢复。
 *
 * 和 npm run mod 一样，直接用本机 wrangler 的登录态读写 KV —— 服务端不为此加任何接口，
 * 也就没有一把能把全站数据导出去的钥匙。能备份、能恢复的，只有能部署这个 Worker 的人。
 *
 *   npm run backup                                  导出线上 KV 的每一个键：值、metadata、过期时刻
 *   npm run backup -- --out <目录或 .json.gz 文件>   存到别处（默认 ~/pigeon-backups/，不许放进仓库目录）
 *   npm run backup -- --prefix acct: --prefix chan:   只导出这些前缀（可以叠加）
 *   npm run backup -- --verify <文件>                检查备份：格式、条数、校验和、每一条的形状
 *   npm run backup -- --restore <文件>               演练恢复：只说会写哪些键，什么都不写
 *   npm run backup -- --restore <文件> --apply       真的写回（先问一句；--yes 不问）
 *   以上都可以加 --local：对本地 wrangler dev 的 KV 做（试用、测试）
 *
 * 备份文件是 gzip 压缩的 JSON，权限 600。里面有账号凭据的摘要、设备推送令牌、举报原文、暂存的重复提醒内容 ——
 * 和线上数据一样敏感，所以不许写进仓库目录（仓库是公开的），默认放在家目录下。
 *
 * 恢复只写不删：备份里有的键按备份的值、metadata、过期时刻写回（已存在的同名键被覆盖），备份里没有的键不动；
 * 过期时刻已经过了（或不到一分钟）的跳过。要回到备份那一刻的完整状态，得先自己清空命名空间 —— 这一步脚本不做。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const CWD = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = join(CWD, "node_modules", "wrangler", "bin", "wrangler.js");
const BINDING = ["--binding", "PIGEON_KV"];
const FORMAT = "pigeon-kv-backup";
const VERSION = 1;
/** KV 的硬上限：键名 512 字节、metadata 序列化后 1024 字节、值 25 MiB */
const KEY_MAX_BYTES = 512;
const METADATA_MAX_BYTES = 1024;
const VALUE_MAX_BYTES = 25 * 1024 * 1024;
/**
 * 同时读几个键。每读一个键是一次 wrangler 进程、一次 Cloudflare API 调用，而 API 每人每 5 分钟限 1200 次：
 * 线上开 4 个（约每秒 3 次）不会撞上；本地库没有这个限制
 */
const REMOTE_CONCURRENCY = 4;
const LOCAL_CONCURRENCY = 8;
const MAX_ATTEMPTS = 4;

// ── 参数 ────────────────────────────────────────────────────────────

function usage() {
  return `用法：
  npm run backup [-- --out <目录或文件>] [--prefix <前缀> ...] [--local]
  npm run backup -- --verify <文件>
  npm run backup -- --restore <文件> [--prefix <前缀> ...] [--local] [--apply [--yes]]`;
}

function parseArgs(argv) {
  const opts = { prefixes: [], local: false, apply: false, yes: false, out: null, verify: null, restore: null };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} 后面要跟一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--local":
        opts.local = true;
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--yes":
        opts.yes = true;
        break;
      case "--prefix":
        opts.prefixes.push(value(++i, arg));
        break;
      case "--out":
        opts.out = value(++i, arg);
        break;
      case "--verify":
        opts.verify = value(++i, arg);
        break;
      case "--restore":
        opts.restore = value(++i, arg);
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        // 拼错的参数直接报错：悄悄忽略的话，「--aply」会让人以为已经恢复了
        throw new UsageError(`不认识的参数：${arg}`);
    }
  }
  if (opts.verify && opts.restore) throw new UsageError("--verify 和 --restore 一次只能用一个");
  if (opts.apply && !opts.restore) throw new UsageError("--apply 只和 --restore 一起用");
  if (opts.out && (opts.verify || opts.restore)) throw new UsageError("--out 只在导出时用");
  return opts;
}

class UsageError extends Error {}

// ── wrangler ────────────────────────────────────────────────────────

/**
 * 跑一次 wrangler，stdout 原样收成字节（值可能不是文字）。直接用 node 跑仓库里的 wrangler，省掉 npx 每次的查找。
 * 不上报用量统计：一次备份要起上千个进程，每个都去报一次没有意义
 */
function wrangler(args, extraEnv = {}) {
  const [cmd, cmdArgs] = existsSync(WRANGLER) ? [process.execPath, [WRANGLER, ...args]] : ["npx", ["wrangler", ...args]];
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: CWD,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

function lastLines(text, n = 4) {
  return text.trim().split("\n").slice(-n).join("\n");
}

/**
 * 读线上还是本地。wrangler 3 的 kv 命令默认连线上，4 起默认连本地、必须显式 --remote ——
 * 不按版本区分，哪天升级了 wrangler，备份就会悄悄变成备份一个空的本地库（和 moderation.mjs 同一个坑）
 */
async function targetFlags(local) {
  if (local) return ["--local"];
  const version = await wrangler(["--version"]);
  const major = Number((version.stdout.toString("utf8").match(/(\d+)\.\d+\.\d+/) ?? [])[1] ?? 3);
  return major >= 4 ? ["--remote"] : [];
}

/** wrangler kv key list 的输出前面夹着横幅（比如「检测到代理」），从第一个行首的 [ 截出 JSON */
function parseKeyList(text) {
  const start = text.search(/^\[/m);
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 列出键（带 metadata 和过期时刻）。给了前缀就逐个前缀列，重叠的只算一次 */
async function listKeys(target, prefixes) {
  const byName = new Map();
  for (const prefix of prefixes.length ? prefixes : [""]) {
    const args = ["kv", "key", "list", ...BINDING, ...target, ...(prefix ? ["--prefix", prefix] : [])];
    let listed = null;
    let failure = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !listed; attempt++) {
      const r = await wrangler(args);
      if (r.code === 0) listed = parseKeyList(r.stdout.toString("utf8"));
      else failure = lastLines(r.stderr || r.stdout.toString("utf8"));
      if (!listed && attempt < MAX_ATTEMPTS) await sleep(3_000 * attempt);
    }
    if (!listed) throw new Error(`列不出${prefix ? `「${prefix}」开头的` : ""}键：${failure || "wrangler 的输出解析不了"}`);
    for (const key of listed) {
      if (key && typeof key.name === "string") byName.set(key.name, key);
    }
  }
  return byName;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 值的字节 → 备份里的形状：是 UTF-8 文字就原样存文字（本服务的值都是），否则存 base64 */
function encodeValue(bytes) {
  try {
    return { value: strictUtf8.decode(bytes) };
  } catch {
    return { value: bytes.toString("base64"), base64: true };
  }
}

/**
 * 读一个键的值。WRANGLER_LOG=warn 压掉 stdout 里的横幅，剩下的就是值的原始字节。
 * 列出之后、读到之前过期或被删了的，返回 null（线上会报 key not found）。
 * 本地库查不到时 wrangler 只打一句「Value not found」，而这一句也被压掉了 —— 读到空值得再问一次，才分得清是空还是没有
 */
async function readValue(target, name, local) {
  const args = ["kv", "key", "get", name, ...BINDING, ...target];
  for (let attempt = 1; ; attempt++) {
    const r = await wrangler(args, { WRANGLER_LOG: "warn" });
    if (r.code === 0) {
      if (r.stdout.length === 0 && local) {
        const again = await wrangler(args);
        if (/Value not found/.test(again.stdout.toString("utf8"))) return null;
      }
      return encodeValue(r.stdout);
    }
    if (/key not found|10009/i.test(r.stderr)) return null;
    if (attempt >= MAX_ATTEMPTS) throw new Error(`读不出「${name}」：${lastLines(r.stderr)}`);
    // 撞上 API 限流就多等一会儿；别的错（网络抖动、登录令牌正被别的进程换新）稍等再试
    await sleep(/429|rate limit|too many/i.test(r.stderr) ? 20_000 : 3_000 * attempt);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 最多 limit 个一起跑。一个出错，别的做完手上这个就停：备份不全就不写文件，没必要再读下去 */
async function eachLimited(items, limit, work) {
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        await work(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(lanes);
}

// ── 备份文件 ────────────────────────────────────────────────────────

function digest(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** wrangler.toml 里 PIGEON_KV 的命名空间 id。记进备份，恢复到别的命名空间时提醒一句 */
function namespaceId() {
  try {
    const toml = readFileSync(join(CWD, "wrangler.toml"), "utf8");
    for (const block of toml.split("[[kv_namespaces]]").slice(1)) {
      const body = block.split(/^\[/m)[0];
      if (/binding\s*=\s*"PIGEON_KV"/.test(body)) return (body.match(/^\s*id\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
    }
  } catch {
    // 读不到就不记
  }
  return null;
}

/**
 * 命令行上给的路径按敲命令时所在的目录解析。npm run 会先切到仓库根目录再跑脚本，
 * 原来的目录在 INIT_CWD 里 —— 不按它来，「--verify ./备份.json.gz」就会去仓库里找
 */
function userPath(path) {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** path 在不在仓库目录里（含子目录） */
function insideRepo(path) {
  const rel = relative(CWD, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stamp(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function fmt(ms) {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 输出路径：--out 给的是 .json.gz 就是文件，否则是目录；默认 $PIGEON_BACKUP_DIR 或 ~/pigeon-backups */
function outputPath(out, startedAt, local) {
  const name = `pigeon-kv-${stamp(startedAt)}${local ? "-local" : ""}.json.gz`;
  if (out && out.endsWith(".json.gz")) return userPath(out);
  return join(userPath(out ?? process.env.PIGEON_BACKUP_DIR ?? join(homedir(), "pigeon-backups")), name);
}

function loadBackup(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (err) {
    throw new Error(`读不了 ${file}：${err.code === "ENOENT" ? "文件不存在" : err.message}`);
  }
  let text;
  try {
    text = gunzipSync(raw).toString("utf8");
  } catch {
    throw new Error(`${basename(file)} 不是 gzip 文件（或者已经损坏）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${basename(file)} 解压后不是合法的 JSON（文件可能被截断了）`);
  }
}

/** 键名的前缀：第一个冒号及之前的部分，汇总时按它分组 */
function prefixOf(key) {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i + 1);
}

/** 逐项检查一份备份，返回错误列表（空 = 没问题） */
function checkBackup(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object" || doc.format !== FORMAT) return ["不是信鸽的 KV 备份文件（format 不对）"];
  if (doc.version !== VERSION) {
    return [typeof doc.version === "number" && doc.version > VERSION
      ? `这是更新版本的备份格式（v${doc.version}），请先把脚本更新到最新`
      : `不认识的备份格式版本：${doc.version}`];
  }
  if (!Array.isArray(doc.entries)) return ["缺少 entries"];
  if (doc.count !== doc.entries.length) errors.push(`条数对不上：文件头写 ${doc.count}，实际 ${doc.entries.length}`);
  if (doc.sha256 !== digest(doc.entries)) errors.push("校验和对不上：内容在导出之后被改过，或者文件损坏了");
  const seen = new Set();
  doc.entries.forEach((entry, i) => {
    const where = `第 ${i + 1} 条`;
    if (!entry || typeof entry !== "object") return errors.push(`${where}不是对象`);
    const { key, value, base64, metadata, expiration } = entry;
    if (typeof key !== "string" || key.length === 0) return errors.push(`${where}没有键名`);
    if (Buffer.byteLength(key) > KEY_MAX_BYTES) errors.push(`「${key.slice(0, 40)}…」键名超过 ${KEY_MAX_BYTES} 字节`);
    if (seen.has(key)) errors.push(`「${key}」出现了不止一次`);
    seen.add(key);
    if (typeof value !== "string") errors.push(`「${key}」的值不是字符串`);
    else if (base64 !== undefined && base64 !== true) errors.push(`「${key}」的 base64 标记不对`);
    else if (base64 && Buffer.from(value, "base64").toString("base64") !== value) errors.push(`「${key}」的值不是合法的 base64`);
    else if ((base64 ? Buffer.from(value, "base64").length : Buffer.byteLength(value)) > VALUE_MAX_BYTES) errors.push(`「${key}」的值超过 25 MiB`);
    if (metadata !== undefined && Buffer.byteLength(JSON.stringify(metadata) ?? "") > METADATA_MAX_BYTES) {
      errors.push(`「${key}」的 metadata 超过 ${METADATA_MAX_BYTES} 字节`);
    }
    if (expiration !== undefined && !(Number.isInteger(expiration) && expiration > 0)) errors.push(`「${key}」的过期时刻不对`);
  });
  return errors;
}

/** 按前缀汇总条数，给人看 */
function summarize(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(prefixOf(e.key), (counts.get(prefixOf(e.key)) ?? 0) + 1);
  const width = Math.max(0, ...[...counts.keys()].map((k) => k.length));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([prefix, n]) => `  ${prefix.padEnd(width)}  ${n}`)
    .join("\n");
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** 恢复时写不回去的：KV 要求过期时刻至少在 60 秒之后 */
const expiredBy = (entry, now) => entry.expiration !== undefined && entry.expiration < now + 60;

// ── 三件事 ──────────────────────────────────────────────────────────

async function exportKV(opts) {
  const startedAt = Date.now();
  const path = outputPath(opts.out, startedAt, opts.local);
  if (insideRepo(path)) {
    throw new UsageError(`备份里有账号凭据的摘要、设备令牌和举报原文，不能放进仓库目录（仓库是公开的）：${path}`);
  }
  if (existsSync(path)) throw new UsageError(`${path} 已经存在，不覆盖`);

  const target = await targetFlags(opts.local);
  const where = opts.local ? "本地 KV" : "线上 KV";
  console.log(`从${where}列出${opts.prefixes.length ? ` ${opts.prefixes.join(" ")} 开头的` : "全部"}键…`);
  const listed = await listKeys(target, opts.prefixes);
  const names = [...listed.keys()].sort();
  const concurrency = opts.local ? LOCAL_CONCURRENCY : REMOTE_CONCURRENCY;
  console.log(`共 ${names.length} 个键，逐个读取${names.length > 200 ? `（每秒约 ${concurrency - 1} 个，要一会儿）` : ""}`);

  const values = new Map();
  let done = 0;
  const vanished = [];
  await eachLimited(names, concurrency, async (name) => {
    const read = await readValue(target, name, opts.local);
    if (read === null) vanished.push(name);
    else values.set(name, read);
    done += 1;
    if (done % 100 === 0) console.log(`  已读 ${done}/${names.length}`);
  });

  const entries = names
    .filter((name) => values.has(name))
    .map((name) => {
      const listedKey = listed.get(name);
      return {
        key: name,
        ...values.get(name),
        ...(listedKey.metadata !== undefined && listedKey.metadata !== null ? { metadata: listedKey.metadata } : {}),
        ...(typeof listedKey.expiration === "number" ? { expiration: listedKey.expiration } : {}),
      };
    });
  const doc = {
    format: FORMAT,
    version: VERSION,
    created_at: new Date(startedAt).toISOString(),
    created_at_ms: startedAt,
    finished_at_ms: Date.now(),
    source: { binding: "PIGEON_KV", namespace_id: namespaceId(), target: opts.local ? "local" : "remote", prefixes: opts.prefixes },
    count: entries.length,
    sha256: digest(entries),
    entries,
  };

  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  // wx：不覆盖已有的文件；600：只有自己读得了
  writeFileSync(path, gzipSync(JSON.stringify(doc)), { mode: 0o600, flag: "wx" });
  console.log(`\n已导出 ${entries.length} 个键 → ${path}（${(statSync(path).size / 1024).toFixed(1)} KB）`);
  if (vanished.length) console.log(`另有 ${vanished.length} 个键在列出之后、读到之前过期或被删了，没有收进来`);
  console.log(summarize(entries));
  console.log(`\n检查：npm run backup -- --verify ${path}`);
}

function verify(file) {
  const doc = loadBackup(file);
  const errors = checkBackup(doc);
  if (errors.length) {
    console.error(`✗ ${basename(file)} 有问题：`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    if (errors.length > 20) console.error(`  ……还有 ${errors.length - 20} 条`);
    process.exitCode = 1;
    return;
  }
  const now = nowSeconds();
  const expired = doc.entries.filter((e) => expiredBy(e, now)).length;
  const source = doc.source?.target === "local" ? "本地 KV" : "线上 KV";
  console.log(`✓ ${basename(file)}：校验和一致，${doc.count} 个键的形状都对`);
  console.log(`导出于 ${fmt(doc.created_at_ms)} · 来源：${source}${doc.source?.namespace_id ? `（命名空间 ${doc.source.namespace_id}）` : ""}${doc.source?.prefixes?.length ? ` · 只含 ${doc.source.prefixes.join(" ")}` : ""}`);
  console.log(summarize(doc.entries));
  if (expired) console.log(`其中 ${expired} 个到现在已经过期，恢复时会跳过`);
}

async function restore(file, opts) {
  const doc = loadBackup(file);
  const errors = checkBackup(doc);
  if (errors.length) {
    console.error(`✗ ${basename(file)} 没通过检查，不恢复：`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  const chosen = opts.prefixes.length
    ? doc.entries.filter((e) => opts.prefixes.some((p) => e.key.startsWith(p)))
    : doc.entries;
  const now = nowSeconds();
  const writable = chosen.filter((e) => !expiredBy(e, now));
  const skipped = chosen.length - writable.length;

  const target = await targetFlags(opts.local);
  const where = opts.local ? "本地 KV" : "线上 KV";
  const existing = await listKeys(target, opts.prefixes);
  const inBackup = new Set(chosen.map((e) => e.key));
  const overwrite = writable.filter((e) => existing.has(e.key)).length;
  const untouched = [...existing.keys()].filter((k) => !inBackup.has(k)).length;

  const here = namespaceId();
  console.log(`备份：${basename(file)}，导出于 ${fmt(doc.created_at_ms)}`);
  if (doc.source?.namespace_id && here && doc.source.namespace_id !== here) {
    console.log(`注意：备份来自命名空间 ${doc.source.namespace_id}，现在的 wrangler.toml 指向 ${here}`);
  }
  console.log(`写到${where}：${writable.length} 个键（新建 ${writable.length - overwrite} 个、覆盖 ${overwrite} 个已有的）`);
  if (writable.length) console.log(summarize(writable));
  if (skipped) console.log(`跳过 ${skipped} 个已经过期（或不到一分钟就过期）的键`);
  if (untouched) console.log(`${where}里另有 ${untouched} 个键不在备份里，不会动它们`);

  if (!opts.apply) {
    console.log("\n这是演练，什么都没写。确认无误后加 --apply 真的写回");
    return;
  }
  if (writable.length === 0) {
    console.log("\n没有要写的键");
    return;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new UsageError("不是在终端里运行，没法当面确认。确定要写回的话加 --yes");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\n要把 ${writable.length} 个键写回${where}，已有的同名键会被覆盖。输入 yes 继续：`)).trim();
    rl.close();
    if (answer !== "yes") {
      console.log("没有写");
      return;
    }
  }

  // 写一份 wrangler kv bulk put 认的文件，放在只有自己能读的临时目录里，用完即删 —— 它和备份一样敏感
  const dir = mkdtempSync(join(tmpdir(), "pigeon-restore-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  try {
    const bulk = join(dir, "bulk.json");
    writeFileSync(
      bulk,
      JSON.stringify(
        writable.map((e) => ({
          key: e.key,
          value: e.value,
          ...(e.base64 ? { base64: true } : {}),
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
          ...(e.expiration !== undefined ? { expiration: e.expiration } : {}),
        })),
      ),
      { mode: 0o600 },
    );
    const r = await wrangler(["kv", "bulk", "put", bulk, ...BINDING, ...target]);
    if (r.code !== 0) throw new Error(`写回失败：${lastLines(r.stderr || r.stdout.toString("utf8"))}`);
  } finally {
    cleanup();
  }
  console.log(`\n已写回 ${writable.length} 个键到${where}`);
}

// ── 入口 ────────────────────────────────────────────────────────────

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.verify) verify(userPath(opts.verify));
  else if (opts.restore) await restore(userPath(opts.restore), opts);
  else await exportKV(opts);
} catch (err) {
  console.error(err instanceof UsageError ? `${err.message}\n\n${usage()}` : `✗ ${err.message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
