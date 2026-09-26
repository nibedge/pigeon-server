/**
 * 群组邀请页：认出应用内的浏览器并提示换到 Safari、显示群主、「复制完整邀请链接」的脚本（在假的 DOM 里跑）。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 web-harness.mjs）。
 * 由 npm run test:web 在同一次构建之后运行。
 */
import { createHash } from "node:crypto";
import { inAppBrowser, INVITE_SCRIPT } from "../.test-build/s3web/invite.mjs";
import { call, makeEnv, makeGroup, plain } from "./web-harness.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 邀请页 ──────────────────────────────────────────────────────────

const UA = {
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
  inApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SomeChat/8.0.49 NetType/WIFI Language/zh_CN",
  inAppIpad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SomeWork/7.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};

console.log("\n★ 邀请页：认出应用内的浏览器");
{
  check("iPhone Safari → 不是", !inAppBrowser(UA.safari));
  check("iPhone 上的其他浏览器（带 Safari/）→ 不是", !inAppBrowser(UA.chromeIos));
  check("★ 聊天软件里的网页视图（没有 Safari/）→ 是", inAppBrowser(UA.inApp));
  check("iPad 上的网页视图 → 是", inAppBrowser(UA.inAppIpad));
  check("安卓、Mac、空 UA → 不是", !inAppBrowser(UA.android) && !inAppBrowser(UA.mac) && !inAppBrowser(""));

  const env = makeEnv();
  const g = await makeGroup(env, "值班群");
  const inside = await call(env, "GET", `/i/${g.code}`, { headers: { "user-agent": UA.inApp } });
  check("★ 应用内打开 → 顶部提示「在 Safari 中打开」", inside.status === 200 && plain(inside.text).includes("选「在 Safari 中打开」"), inside.text.slice(0, 200));
  const safari = await call(env, "GET", `/i/${g.code}`, { headers: { "user-agent": UA.safari } });
  check("Safari 打开 → 没有这行提示", safari.status === 200 && !safari.text.includes("在 Safari 中打开"));
  check("★ 显示群主是谁", plain(safari.text).includes("由 老王 创建"));
  check("有「复制完整邀请链接」按钮（没脚本时藏着）", /<button type="button" class="copy" id="copy" hidden>复制完整邀请链接<\/button>/.test(safari.text));
  check("加密群的提醒默认藏着，有密钥时由脚本显示", /<p class="e2e" id="e2e" hidden>/.test(safari.text));
  check("手动加入的说明指向「群组」页的 ＋", plain(safari.text).includes("「群组」右上角的 ＋ →「加入群组」"));
  const csp = safari.headers.get("content-security-policy") ?? "";
  const scripts = [...safari.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
  check("改过的脚本仍按哈希放行", scripts.length === 1 && csp.includes(hash(scripts[0])) && scripts[0] === INVITE_SCRIPT, csp);
  // 名字按 base64 存，免得这条检查本身把名字带进仓库（同 push.test.mjs 的 FORBIDDEN_NAMES）
  const names = ["TWljcm9NZXNzZW5nZXI=", "TGFyaw==", "RmVpc2h1", "RGluZ1RhbGs=", "5b6u5L+h", "6aOe5Lmm", "6ZKJ6ZKJ"]
    .map((b64) => Buffer.from(b64, "base64").toString("utf8").toLowerCase());
  const lowered = inside.text.toLowerCase();
  check("页面上没有别家软件的名字", !names.some((name) => lowered.includes(name)));
}

/** 在假的 DOM 里跑一遍邀请页的脚本 */
function runInviteScript({ hash = "", search = "", clipboard, execCommand = () => false }) {
  const listeners = {};
  const appended = [];
  const els = {
    open: { href: "pigeon://invite?c=ABCD2345" },
    e2e: { hidden: true },
    copied: { textContent: "" },
    copy: { hidden: true, addEventListener: (type, fn) => (listeners[type] = fn) },
  };
  const document = {
    getElementById: (id) => els[id],
    createElement: () => ({ style: {}, value: "", setAttribute() {}, select() {}, setSelectionRange() {} }),
    body: { appendChild: (el) => appended.push(el), removeChild: (el) => appended.splice(appended.indexOf(el), 1) },
    execCommand,
  };
  const location = { hash, search, origin: "https://nfo.im", pathname: "/i/ABCD2345", href: `https://nfo.im/i/ABCD2345${search}${hash}` };
  const navigator = clipboard ? { clipboard } : {};
  new Function("document", "location", "navigator", INVITE_SCRIPT)(document, location, navigator);
  return { els, click: () => listeners.click?.(), appended };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log("\n★ 邀请页脚本：复制完整链接");
{
  const k = "A".repeat(43);
  const written = [];
  const a = runInviteScript({ hash: `#k=${k}`, search: "?from=chat", clipboard: { writeText: async (t) => written.push(t) } });
  check("有脚本就露出复制按钮", a.els.copy.hidden === false);
  check("密钥照旧转交给「用信鸽打开」", a.els.open.href === `pigeon://invite?c=ABCD2345&k=${k}`);
  check("带密钥 → 显示加密群的提醒", a.els.e2e.hidden === false);
  a.click();
  await settle();
  check("★ 复制的是路径 + #k，聊天软件加的参数去掉", written[0] === `https://nfo.im/i/ABCD2345#k=${k}`, written[0]);
  check("复制成功后告诉人下一步去哪粘贴", a.els.copied.textContent.includes("已复制") && a.els.copied.textContent.includes("加入群组"));

  const b = runInviteScript({ clipboard: { writeText: async () => {} } });
  check("没有密钥：不显示加密提醒", b.els.e2e.hidden === true);
  const noKey = [];
  const b2 = runInviteScript({ clipboard: { writeText: async (t) => noKey.push(t) } });
  b2.click();
  await settle();
  check("没有密钥：复制的就是邀请页地址", noKey[0] === "https://nfo.im/i/ABCD2345", noKey[0]);

  let copiedText = null;
  const c = runInviteScript({ hash: `#k=${k}`, execCommand: (cmd) => cmd === "copy" && (copiedText = "ok") === "ok" });
  c.click();
  await settle();
  check("没有剪贴板接口 → 退回老办法复制", copiedText === "ok" && c.els.copied.textContent.includes("已复制") && c.appended.length === 0);

  const d = runInviteScript({
    hash: `#k=${k}`,
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: () => { throw new Error("nope"); },
  });
  d.click();
  await settle();
  check("★ 两种都不行 → 把完整链接摆出来让人手动复制", d.els.copied.textContent.includes(`https://nfo.im/i/ABCD2345#k=${k}`), d.els.copied.textContent);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
