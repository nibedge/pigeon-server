/**
 * 加密推送工具的测试。App 那边用同一组向量核对（Tests/main.swift）——
 * 发送端和接收端只要有一边对格式的理解不同，消息就是一串解不开的乱码。
 */
import { createDecipheriv, hkdfSync } from "node:crypto";
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

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
