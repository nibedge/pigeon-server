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
 *       --id <同一件事的标识>  --status firing|resolved  --group <分组>  --dry-run（只打印，不发送）
 *
 * 通道加密密钥在 App 的「通道设置 → 端到端加密」里复制。
 * 只用 Node 18+ 自带的模块、不装任何依赖；整个文件就是全部实现，可以逐行审计。
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** 加密的字段：消息内容本身 */
const CONTENT_FIELDS = ["title", "subtitle", "body", "url", "tags"];
/** 不加密的字段：服务端投递时要用（级别、折叠 id、事件状态、分组、铃声） */
const PLAIN_FIELDS = ["level", "id", "status", "group", "sound"];

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

function parseArgs(argv) {
  const [url, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name === "dry-run") opts.dryRun = true;
    else opts[name] = rest[++i];
  }
  return { url, opts };
}

async function main() {
  const { url, opts } = parseArgs(process.argv.slice(2));
  if (!url || !opts.key || !(opts.title || opts.body)) {
    console.error("用法：node pigeon-send.mjs <推送地址> --key <通道加密密钥> --title <标题> --body <正文> [--dry-run]");
    process.exit(2);
  }
  const content = Object.fromEntries(CONTENT_FIELDS.filter((f) => opts[f]).map((f) => [f, opts[f]]));
  const payload = encrypt(content, decodeKey(opts.key));
  for (const f of PLAIN_FIELDS) if (opts[f]) payload[f] = opts[f];

  if (opts.dryRun) {
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
