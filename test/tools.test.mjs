/**
 * 加密推送工具的测试。App 那边用同一组向量核对（Tests/main.swift）——
 * 发送端和接收端只要有一边对格式的理解不同，消息就是一串解不开的乱码。
 */
import { spawnSync } from "node:child_process";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeKey, encrypt } from "../tools/pigeon-send.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

console.log("\n密钥");
const keyText = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const key = decodeKey(keyText);
check("base64url 解出 32 字节", key.length === 32 && key[0] === 0 && key[31] === 31);
check("标准 base64 也认", decodeKey(key.toString("base64")).equals(key));
let threw = false;
try { decodeKey("short"); } catch { threw = true; }
check("长度不对直接拒绝", threw);

console.log("\n加密");
const iv = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
const content = { title: "磁盘满了", body: "剩余 3%", tags: "warning" };
const sealed = encrypt(content, key, iv);
check("iv 原样带出", sealed.iv === iv.toString("base64"));
const raw = Buffer.from(sealed.ciphertext, "base64");
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(raw.subarray(raw.length - 16));
const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
check("往返解密一致", JSON.parse(plain).title === "磁盘满了" && JSON.parse(plain).tags === "warning");
check("★ 密文里看不到明文", !raw.toString("utf8").includes("磁盘"));
check("随机 nonce：同一条内容两次加密结果不同", encrypt(content, key).ciphertext !== encrypt(content, key).ciphertext);
const tampered = Buffer.from(raw); tampered[0] ^= 1;
let rejected = false;
try {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tampered.subarray(tampered.length - 16));
  Buffer.concat([d.update(tampered.subarray(0, tampered.length - 16)), d.final()]);
} catch { rejected = true; }
check("★ 密文被改动一个比特就解不开（GCM 认证）", rejected);

const channelKey = Buffer.from(hkdfSync("sha256", Buffer.alloc(32, 0x42), "pigeon-e2e-v1", "channel:chanTEST01", 32));
console.log(`VECTOR ${JSON.stringify({ ciphertext: sealed.ciphertext, iv: sealed.iv, hkdf: channelKey.toString("hex") })}`);

// 命令行：原先不认识的参数照单全收、发的时候悄悄丢掉 —— --repeat 5 没生效、拼错的 --titel 也不报错
console.log("\n命令行参数");
const tool = fileURLToPath(new URL("../tools/pigeon-send.mjs", import.meta.url));
/** 真的跑一遍这个脚本（--dry-run 不联网），拿退出码和输出 */
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", env: { ...process.env, PIGEON_KEY: "", ...env } });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // 出错时没有 JSON
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
};
const URL_ = "https://nfo.im/KEY";

const typo = cli([URL_, "--key", keyText, "--titel", "磁盘满了", "--dry-run"]);
check("★ 拼错的参数（--titel）→ 退出码 2", typo.code === 2, `${typo.code} ${typo.err}`);
check("★ 报错说出是哪个参数，并猜到想写的是 --title", typo.err.includes("--titel") && typo.err.includes("--title"), typo.err);
check("报错时什么也不输出到 stdout", typo.out === "");

const full = cli([URL_, "--key", keyText, "--title", "磁盘满了", "--body", "剩余 3%", "--repeat", "5", "--isArchive", "0", "--id", "disk-1", "--level", "timeSensitive", "--dry-run"]);
check("正常参数照常跑（退出码 0）", full.code === 0, full.err);
check("★ --repeat 不再被丢掉：明文带出去", full.json?.repeat === "5", full.out);
check("★ --isArchive 明文带出去", full.json?.isArchive === "0", full.out);
check("id、level 照旧明文", full.json?.id === "disk-1" && full.json?.level === "timeSensitive");
check("★ 标题正文仍在密文里，明文里没有", Boolean(full.json?.ciphertext) && !full.out.includes("磁盘") && full.json?.title === undefined);
const opened = (() => {
  const raw = Buffer.from(full.json.ciphertext, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(full.json.iv, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"));
})();
check("解开密文就是标题和正文", opened.title === "磁盘满了" && opened.body === "剩余 3%" && opened.repeat === undefined, JSON.stringify(opened));

check("参数名不分大小写（--isarchive）", cli([URL_, "--key", keyText, "--body", "b", "--isarchive", "0", "--dry-run"]).json?.isArchive === "0");

const image = cli([URL_, "--key", keyText, "--body", "b", "--image", "https://x/y.png", "--dry-run"]);
check("★ 认得但还不支持的（--image）→ 退出码 2 并说明为什么", image.code === 2 && image.err.includes("--image") && image.err.includes("加密"), image.err);
const stray = cli([URL_, "--key", keyText, "--body", "磁盘", "满了", "--dry-run"]);
check("多出来的参数（值里有空格没加引号）→ 退出码 2", stray.code === 2 && stray.err.includes("满了") && stray.err.includes("引号"), stray.err);
const dangling = cli([URL_, "--key", keyText, "--body", "b", "--repeat"]);
check("参数后面少了值 → 退出码 2", dangling.code === 2 && dangling.err.includes("--repeat"), dangling.err);
check("没给正文 → 退出码 2 并打印用法", cli([URL_, "--key", keyText, "--dry-run"]).code === 2);

const viaEnv = cli([URL_, "--body", "b", "--dry-run"], { PIGEON_KEY: keyText });
check("密钥可以放在环境变量 PIGEON_KEY 里", viaEnv.code === 0 && Boolean(viaEnv.json?.ciphertext), viaEnv.err);

const retract = cli([URL_, "--delete", "--id", "disk-1", "--dry-run"]);
check("★ 撤回：只发 id 和 delete，不用密钥、没有密文", retract.code === 0 && JSON.stringify(retract.json) === JSON.stringify({ id: "disk-1", delete: "1" }), retract.out + retract.err);
check("撤回没带 id → 退出码 2", cli([URL_, "--delete", "--dry-run"]).code === 2);
check("撤回还带着内容 → 退出码 2（内容不会被发出去，别让人以为发了）", cli([URL_, "--delete", "--id", "x", "--title", "t", "--dry-run"]).code === 2);
check("--help 打印用法、退出码 0", (() => { const h = cli(["--help"]); return h.code === 0 && h.out.includes("用法"); })());

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
