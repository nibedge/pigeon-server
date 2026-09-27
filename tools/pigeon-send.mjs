#!/usr/bin/env node
/**
 * pigeon-send —— 把一条消息端到端加密后推给信鸽。
 *
 * 标题、正文、链接、标签在这台机器上就加密好了（AES-256-GCM），信鸽服务器和 Apple
 * 只经手密文，只有装着这个通道密钥的手机能解开。
 *
 *   node pigeon-send.mjs <推送地址> --key <通道加密密钥> --title "磁盘满了" --body "剩余 3%"
 *
 * 可选：--subtitle  --url  --tags warning,prod  --level passive|active|timeSensitive|critical
 *       --id <同一件事的标识>  --status firing|resolved  --group <分组>  --sound <铃声>
 *       --repeat <分钟>（每隔几分钟再响一次，直到有人处理）  --isArchive 0（不存进 App 历史）
 *       --live 1（带 --id 和 --status firing 时，在接收者的锁屏和灵动岛上开一个实时活动）
 *       --dry-run（只打印，不发送）
 * 撤回：node pigeon-send.mjs <推送地址> --delete --id <原消息的 id>（只发 id，用不着密钥）
 *
 * 通道加密密钥在 App 的「通道设置 → 端到端加密」里复制；也可以放在环境变量 PIGEON_KEY 里，
 * 免得留在 shell 历史中。拼错或不认识的参数直接报错（退出码 2），不会悄悄丢掉。
 * 只用 Node 18+ 自带的模块、不装任何依赖；整个文件就是全部实现，可以逐行审计。
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** 加密的字段：消息内容本身 */
const CONTENT_FIELDS = ["title", "subtitle", "body", "url", "tags"];
/** 不加密的字段：服务端投递时要用（级别、折叠 id、事件状态、分组、铃声、重复提醒、是否存进历史、实时活动） */
const PLAIN_FIELDS = ["level", "id", "status", "group", "sound", "repeat", "isArchive", "live"];
/** 不带值的开关 */
const SWITCHES = ["delete", "dry-run", "help"];
/** 服务端认得、但加密消息还不支持的：它们也是内容，得和标题正文一起加密，App 那边还没接上 */
const UNSUPPORTED = ["image", "icon", "copy", "autoCopy", "markdown"];

const VALUE_FLAGS = ["key", ...CONTENT_FIELDS, ...PLAIN_FIELDS];
/** 参数名不分大小写：--isarchive 和 --isArchive 一样 */
const CANONICAL = new Map([...VALUE_FLAGS, ...SWITCHES, ...UNSUPPORTED].map((name) => [name.toLowerCase(), name]));

const USAGE = [
  "用法：node pigeon-send.mjs <推送地址> --key <通道加密密钥> --title <标题> --body <正文> [--dry-run]",
  "可选：--subtitle --url --tags --level --id --status --group --sound --repeat <分钟> --isArchive 0 --live 1",
  "撤回：node pigeon-send.mjs <推送地址> --delete --id <原消息的 id>",
].join("\n");

/** 命令行用错了：说清楚哪里错，以退出码 2 结束 */
export class UsageError extends Error {}

/** 两个参数名差几个字母（编辑距离），用来猜「是不是想写 --title」 */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function unknownFlag(name) {
  const guess = [...VALUE_FLAGS, ...SWITCHES]
    .map((known) => [known, distance(name.toLowerCase(), known.toLowerCase())])
    .sort((x, y) => x[1] - y[1])[0];
  const hint = guess && guess[1] <= 2 ? `，是不是想写 --${guess[0]}？` : "";
  return new UsageError(`不认识的参数 --${name}${hint}\n${USAGE}`);
}

/**
 * 解析命令行。原先不认识的参数照单全收、发的时候悄悄丢掉：--repeat 5 没有生效、
 * 拼错的 --titel 也不报错，发送方以为设上了重复提醒，结果只响一次
 */
export function parseArgs(argv) {
  const opts = {};
  let url;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (url === undefined) {
        url = arg;
        continue;
      }
      throw new UsageError(`多出来的参数「${arg}」：值里有空格时请加引号\n${USAGE}`);
    }
    const raw = arg.slice(2);
    const name = CANONICAL.get(raw.toLowerCase());
    if (!name) throw unknownFlag(raw);
    if (UNSUPPORTED.includes(name)) {
      throw new UsageError(`--${name} 暂不支持：它也是消息内容，得和标题正文一起加密，App 这边还没接上`);
    }
    if (SWITCHES.includes(name)) {
      opts[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} 后面少了值\n${USAGE}`);
    opts[name] = value;
    i++;
  }
  return { url, opts };
}

/** App 里复制的是 base64url；标准 base64 也认 */
export function decodeKey(text) {
  const b64 = String(text).trim().replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
  if (key.length !== 32) throw new Error("密钥应为 32 字节 —— 请从 App 的「端到端加密」里原样复制");
  return key;
}

/** ciphertext = base64(密文‖16 字节认证标签)，iv = base64(12 字节随机 nonce) */
export function encrypt(content, key, iv = randomBytes(12)) {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(content), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext: sealed.toString("base64"), iv: iv.toString("base64") };
}

/**
 * 要发出去的 JSON。撤回只带 id 和 delete：没有内容要加密，服务端对只收加密的通道也放行撤回。
 * keyText 缺省时读环境变量 PIGEON_KEY
 */
export function buildPayload(opts, keyText = opts.key ?? process.env.PIGEON_KEY) {
  if (opts.delete) {
    if (!opts.id) throw new UsageError(`撤回要带上原消息的 id：--delete --id <id>\n${USAGE}`);
    const extra = CONTENT_FIELDS.filter((f) => opts[f]);
    if (extra.length) throw new UsageError(`撤回不用带内容，去掉 ${extra.map((f) => `--${f}`).join(" ")}`);
    return { id: opts.id, delete: "1" };
  }
  if (!keyText || !(opts.title || opts.body)) throw new UsageError(USAGE);
  const content = Object.fromEntries(CONTENT_FIELDS.filter((f) => opts[f]).map((f) => [f, opts[f]]));
  const payload = encrypt(content, decodeKey(keyText));
  for (const f of PLAIN_FIELDS) if (opts[f]) payload[f] = opts[f];
  return payload;
}

async function main() {
  let url;
  let payload;
  let dryRun = false;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.opts.help) {
      console.log(USAGE);
      return;
    }
    if (!parsed.url) throw new UsageError(USAGE);
    url = parsed.url;
    dryRun = Boolean(parsed.opts["dry-run"]);
    payload = buildPayload(parsed.opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(res.status, await res.text());
  if (!res.ok) process.exit(1);
}

// 被 import（比如测试）时不执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
