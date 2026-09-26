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
import { explainFailure, explainFailures, pushToDevice } from "../.test-build/apns.mjs";

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


// 失败说给发送方听：原先 APNs 的状态码和英文 reason 原样甩回去，
// 403 InvalidProviderToken 会被读成「我的 key 没权限」，分不清该改请求还是等服务端修
console.log("\n失败翻成中文");
const r = (status, reason) => ({ deviceToken: "t", env: "production", status, reason });
const dead = explainFailure(r(410, "Unregistered"));
check("★ 设备失效 → 410，说明之后不再推给它（不说「已清理」：令牌还在账号记录里）", dead.status === 410 && dead.message.includes("不再推给它") && !dead.message.includes("清理"), dead.message);
check("原始 reason 留着，对照 Apple 文档用", dead.reason === "Unregistered" && dead.message.includes("Unregistered"));
check("BadDeviceToken 也算失效 → 410", explainFailure(r(400, "BadDeviceToken")).status === 410);
const config = explainFailure(r(403, "InvalidProviderToken"));
check("★ 密钥配置问题 → 502，明说不是发送方的错", config.status === 502 && config.message.includes("不是你的请求出错") && config.message.includes("InvalidProviderToken"), config.message);
check("App 标识对不上也是配置问题 → 502", explainFailure(r(400, "BadTopic")).status === 502);
check("签不出 token（本服务的问题）→ 502", explainFailure(bad).status === 502 && explainFailure(bad).message.includes("推送配置"), explainFailure(bad).message);
const down = explainFailure(r(503, "ServiceUnavailable"));
check("★ Apple 那边 5xx → 502，请稍后再试", down.status === 502 && down.message.includes("稍后再试"), down.message);
check("连不上 Apple → 502", explainFailure(r(502, "连接 APNs 失败: timeout")).status === 502);
check("内容太长 → 413", explainFailure(r(413, "PayloadTooLarge")).status === 413);
check("发得太频繁 → 429", explainFailure(r(429, "TooManyRequests")).status === 429);
check("其他 4xx 不怪发送方 → 502", explainFailure(r(400, "BadCollapseId")).status === 502);
check("说明都是中文开头", [dead, config, down].every((e) => e.message.startsWith("推送失败：")));
check(
  "★ 失效和别的失败混在一起：报别的（失效的已经清理掉了）",
  explainFailures([r(410, "Unregistered"), r(403, "InvalidProviderToken")]).status === 502,
);
check("全是失效才报失效", explainFailures([r(410, "Unregistered"), r(400, "BadDeviceToken")]).status === 410);
check("送到的那台不算失败", explainFailures([r(200), r(503, "ServiceUnavailable")]).reason === "ServiceUnavailable");

// 瞬时失败重试一次：原先一次 503 就算失败，心跳失联这种只推一次的告警就此丢了
console.log("\n瞬时失败重试一次");
{
  /** 按顺序回这些响应；Error 表示连不上。calls 记下每次请求的 authorization 和到达时刻 */
  let script = [];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ auth: init.headers.authorization, at: Date.now(), body: init.body });
    const next = script.shift() ?? [200];
    if (next instanceof Error) throw next;
    const [status, reason] = next;
    return new Response(reason ? JSON.stringify({ reason }) : "", { status });
  };
  const retryEnv = { ...env, APNS_KEY_ID: "KIDRETRY" };
  const device = { token: "b".repeat(64), env: "production" };
  const run = async (steps) => {
    script = [...steps];
    calls.length = 0;
    const started = Date.now();
    const result = await pushToDevice(retryEnv, device, { aps: { alert: "重试" } }, {});
    return { result, calls: [...calls], ms: Date.now() - started };
  };

  const blip = await run([[503, "ServiceUnavailable"], [200]]);
  check("★ 503 之后再试一次，送到了", blip.result.status === 200 && blip.calls.length === 2, JSON.stringify(blip));
  check("中间等了一小会儿（300 毫秒起）", blip.calls[1].at - blip.calls[0].at >= 290, `${blip.calls[1].at - blip.calls[0].at}ms`);
  check("两次发的是同一份内容", blip.calls[0].body === blip.calls[1].body);

  const down = await run([[503, "ServiceUnavailable"], [500, "InternalServerError"]]);
  check("★ 连着两次 5xx：只重试一次，报第二次的失败", down.result.status === 500 && down.result.reason === "InternalServerError" && down.calls.length === 2, JSON.stringify(down.result));
  check("总时长控制在两秒以内", down.ms < 2000, `${down.ms}ms`);

  const net = await run([new Error("socket hang up"), [200]]);
  check("★ 连不上 Apple 也重试一次", net.result.status === 200 && net.calls.length === 2, JSON.stringify(net.result));
  const netDown = await run([new Error("timeout"), new Error("timeout")]);
  check("两次都连不上 → 502 连接失败", netDown.result.status === 502 && netDown.result.reason.startsWith("连接 APNs 失败"), JSON.stringify(netDown.result));

  const busy = await run([[429, "TooManyRequests"], [200]]);
  check("发往这台设备太频繁（429 TooManyRequests）也再试一次", busy.result.status === 200 && busy.calls.length === 2);

  for (const [status, reason, why] of [
    [410, "Unregistered", "设备失效"],
    [400, "BadDeviceToken", "token 坏了"],
    [403, "InvalidProviderToken", "密钥配置错了"],
    [413, "PayloadTooLarge", "内容太长"],
    [400, "BadCollapseId", "请求本身有问题"],
  ]) {
    const once = await run([[status, reason], [200]]);
    check(`${why}（${status} ${reason}）不重试：再发一遍结果一样`, once.result.status === status && once.calls.length === 1, JSON.stringify(once));
  }

  // token 过期：换一个新签的立刻再试
  await run([[200]]);
  const cachedAuth = calls[0].auth;
  const expired = await run([[403, "ExpiredProviderToken"], [200]]);
  check("★ token 过期 → 丢掉缓存、换新 token 立刻再试", expired.result.status === 200 && expired.calls.length === 2 && expired.calls[0].auth === cachedAuth && expired.calls[1].auth !== cachedAuth, JSON.stringify(expired.result));
  check("过期重试不必等", expired.calls[1].at - expired.calls[0].at < 250, `${expired.calls[1].at - expired.calls[0].at}ms`);

  // Apple 嫌 token 换得太勤：不当场换新的再试（那正是它抱怨的事），但下一条推送重新签
  const renewed = expired.calls[1].auth;
  const tooMany = await run([[429, "TooManyProviderTokenUpdates"], [200]]);
  check("★ TooManyProviderTokenUpdates 不当场重试", tooMany.result.status === 429 && tooMany.calls.length === 1, JSON.stringify(tooMany));
  const after = await run([[200]]);
  check("★ 下一条推送换了新签的 token", after.calls[0].auth !== renewed && after.calls[0].auth !== undefined);
  const again = await run([[200]]);
  check("新 token 照常缓存，不是每条都签", again.calls[0].auth === after.calls[0].auth);

  await run([[403, "InvalidProviderToken"]]);
  const keep = await run([[200]]);
  check("密钥配置问题不丢缓存（重签也没用）", keep.calls[0].auth === after.calls[0].auth);
}

// 签名单飞：冷启动时一次群发同时推几十台，原先每台各签一个（ECDSA 带随机数，各不相同）
console.log("\n签名单飞");
{
  const subtle = globalThis.crypto.subtle;
  const realSign = subtle.sign.bind(subtle);
  let signs = 0;
  subtle.sign = (...args) => {
    signs++;
    return realSign(...args);
  };
  const auths = [];
  globalThis.fetch = async (url, init) => {
    auths.push(init.headers.authorization);
    return new Response("", { status: 200 });
  };
  const coldEnv = { ...env, APNS_KEY_ID: "KIDCOLD" };
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      pushToDevice(coldEnv, { token: String(i).padStart(64, "0"), env: "production" }, { aps: {} })),
  );
  check("20 台都送到", results.every((r) => r.status === 200));
  check("★ 20 台同时推，只签了一次", signs === 1, `签了 ${signs} 次`);
  check("★ 用的是同一个 token", new Set(auths).size === 1, `${new Set(auths).size} 个不同的 token`);

  // 签失败不留痕迹：同一个 kid 换上对的密钥，下一次照常签
  signs = 0;
  const brokenEnv = { ...env, APNS_KEY_ID: "KIDFLAKY", APNS_KEY_P8: "not a key at all" };
  const broken = await Promise.all([1, 2, 3].map(() =>
    pushToDevice(brokenEnv, { token: "9".repeat(64), env: "production" }, { aps: {} })));
  check("签不出来：同时在等的几条都拿到同一个错误", broken.every((r) => r.status === 500 && r.reason.includes("P-256")), JSON.stringify(broken[0]));
  const fixed = await pushToDevice({ ...brokenEnv, APNS_KEY_P8: privateKey }, { token: "9".repeat(64), env: "production" }, { aps: {} });
  check("★ 失败不被缓存：修好密钥后照常签发", fixed.status === 200 && signs === 1, JSON.stringify(fixed));
  subtle.sign = realSign;
}

console.log(
  failures === 0
    ? "\n全部通过\n"
    : `\n${failures} 项失败\n`,
);
process.exit(failures === 0 ? 0 : 1);
