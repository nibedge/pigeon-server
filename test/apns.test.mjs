/**
 * 验证 APNs provider token 的签发。
 *
 * 为什么值得单独测：本地 wrangler dev 的 workerd 不跟 APNs 谈 HTTP/2，
 * 这一段在本地永远走不通；而签错了 JWT 在线上只会得到一句 403
 * InvalidProviderToken —— 跟「密钥没在 Apple 后台注册」的报错一模一样，
 * 到时候根本分不清是代码问题还是配置问题。所以在这里就地验死。
 *
 *   node --experimental-strip-types 用不了（Workers 类型），
 *   所以先用 esbuild 打包 src/apns.ts 再 import。见 npm run test:apns。
 */
import { generateKeyPairSync } from "node:crypto";
import { pushToDevice } from "../.test-build/apns.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// 一把只在测试里用的 P-256 密钥，形状和 Apple 发的 .p8 一致
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const env = {
  APNS_KEY_P8: privateKey,
  APNS_KEY_ID: "ABC1234DEF",
  APNS_TEAM_ID: "TEAM567890",
  APNS_TOPIC: "im.nfo.pigeon",
};

// 桩掉 fetch，把请求截下来看
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, init };
  return new Response("", { status: 200 });
};

console.log("\nAPNs provider token");

const result = await pushToDevice(
  env,
  { token: "d".repeat(64), env: "production" },
  { aps: { alert: "hi" } },
  { "apns-collapse-id": "abc" },
);

check("推送返回 200", result.status === 200, JSON.stringify(result));
check("打到正确的 APNs 路径", captured?.url === `https://api.push.apple.com/3/device/${"d".repeat(64)}`, captured?.url);

const headers = captured?.init?.headers ?? {};
check("apns-topic 用的是 env 里的值", headers["apns-topic"] === env.APNS_TOPIC);
check("默认 push-type 是 alert", headers["apns-push-type"] === "alert");
check("collapse-id 透传", headers["apns-collapse-id"] === "abc");

const auth = headers["authorization"] ?? "";
check("authorization 是 bearer 开头", auth.startsWith("bearer "));

const jwt = auth.slice("bearer ".length);
const [h64, p64, s64] = jwt.split(".");
check("JWT 是三段", Boolean(h64 && p64 && s64));

const header = JSON.parse(b64urlToBuf(h64).toString());
const claims = JSON.parse(b64urlToBuf(p64).toString());

check("alg = ES256", header.alg === "ES256", JSON.stringify(header));
check("kid = APNS_KEY_ID", header.kid === env.APNS_KEY_ID);
check("iss = APNS_TEAM_ID", claims.iss === env.APNS_TEAM_ID);
check("iat 是当前时间附近的秒级时间戳",
  Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 60, String(claims.iat));

// 最关键的一条：签名必须能用公钥验过。
// WebCrypto 的 ECDSA 输出是 r‖s 裸格式（64 字节），正是 JWS 要的形状；
// 若哪天误用了 DER 编码，Apple 只会回一句无差别的 403，这里能立刻抓到。
const sig = b64urlToBuf(s64);
check("签名是 64 字节的 r‖s", sig.length === 64, `实际 ${sig.length} 字节`);

const pubKey = await crypto.subtle.importKey(
  "spki",
  Buffer.from(
    publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  ),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);
const valid = await crypto.subtle.verify(
  { name: "ECDSA", hash: "SHA-256" },
  pubKey,
  sig,
  new TextEncoder().encode(`${h64}.${p64}`),
);
check("签名能用对应公钥验过", valid);

// p8 会以各种形状进来：真换行、字面量 \n、被 .env 解析器留下的包裹引号
console.log("\np8 解析的容错");
const variants = [
  ["字面量 \\n", privateKey.replace(/\n/g, "\\n")],
  ["带包裹引号", `"${privateKey}"`],
  ["CRLF 换行", privateKey.replace(/\n/g, "\r\n")],
  ["首尾多余空白", `\n\n  ${privateKey}  \n\n`],
];
for (const [i, [label, variant]] of variants.entries()) {
  captured = null;
  // 每个变体换一个 kid：token 缓存是按 kid 命中的，不换就会直接返回上一轮
  // 签好的 JWT，p8 解析根本不会被执行，这几条断言就成了摆设。
  const r = await pushToDevice(
    { ...env, APNS_KEY_P8: variant, APNS_KEY_ID: `KID${i}` },
    { token: "e".repeat(64), env: "production" },
    {},
  );
  check(label, r.status === 200, r.reason);
}

// 反过来：明显不是密钥的东西必须干脆地失败，而不是签出一个废 token
captured = null;
const bad = await pushToDevice(
  { ...env, APNS_KEY_P8: "not a key at all", APNS_KEY_ID: "KIDBAD" },
  { token: "f".repeat(64), env: "production" },
  {},
);
check("垃圾输入被挡下且报错说人话", bad.status === 500 && /P-256 私钥/.test(bad.reason ?? ""), bad.reason);
check("挡下时没有真的发出请求", captured === null);

// 环境路由：拿 sandbox token 打生产端点，只会得到一句 BadDeviceToken ——
// 跟「token 已失效」的报错完全一样，走错了根本看不出来，所以必须测死。
console.log("\nAPNs 环境路由");
for (const [label, apnsEnv, expectHost] of [
  ["production → 生产端点", "production", "api.push.apple.com"],
  ["sandbox → 沙盒端点", "sandbox", "api.sandbox.push.apple.com"],
]) {
  captured = null;
  await pushToDevice(
    { ...env, APNS_KEY_ID: `KIDENV-${apnsEnv}` },
    { token: "a".repeat(64), env: apnsEnv },
    {},
  );
  check(label, captured?.url?.startsWith(`https://${expectHost}/`), captured?.url);
}

captured = null;
const envEcho = await pushToDevice(
  { ...env, APNS_KEY_ID: "KIDECHO" },
  { token: "c".repeat(64), env: "sandbox" },
  {},
);
check("结果里回带环境，便于排查", envEcho.env === "sandbox", JSON.stringify(envEcho));

captured = null;
await pushToDevice(
  { ...env, APNS_HOST: "example.invalid", APNS_KEY_ID: "KIDOVR" },
  { token: "d".repeat(64), env: "sandbox" },
  {},
);
check("APNS_HOST 覆盖优先于环境推断",
  captured?.url?.startsWith("https://example.invalid/"), captured?.url);

console.log(
  failures === 0
    ? "\n全部通过\n"
    : `\n${failures} 项失败\n`,
);
process.exit(failures === 0 ? 0 : 1);
