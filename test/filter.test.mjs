/**
 * 群组明文推送的违禁词过滤（src/contentfilter.ts）：规整与比对、KV 里的 config:blocklist 替换词表、
 * 路径式 / JSON / 批量 / webhook 四个推送入口都拦，个人通道和密文不管。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 web-harness.mjs）。
 * 由 npm run test:web 在同一次构建之后运行。
 */
import { contentRejection, DEFAULT_BLOCKLIST, findBlocked, loadBlocklist, normalize } from "../.test-build/s3web/contentfilter.mjs";
import { apns, call, makeEnv, makeGroup } from "./web-harness.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 违禁词过滤 ───────────────────────────────────────────────────────

console.log("\n★ 违禁词：规整与比对");
{
  check("全角、大小写、空格、标点、零宽字符都规整掉", normalize("ＣＨＩＬＤ  Porn") === "childporn" && normalize("裸 * 聊") === "裸聊" && normalize("裸​聊") === "裸聊");
  const words = DEFAULT_BLOCKLIST.map(normalize);
  check("内置词表规整后没有空词", words.length > 0 && words.every((w) => w.length >= 2), words.join(","));
  check("拆字写法照样命中", findBlocked({ body: "今晚 约 - 炮 吗" }, words) === "约炮");
  check("看标题、副标题、正文、markdown", ["title", "subtitle", "body", "markdown"].every((f) => findBlocked({ [f]: "冰毒" }, words) === "冰毒"));
  check("不跨字段拼接（标题末字 + 正文首字不算）", findBlocked({ title: "裸", body: "聊" }, words) === null);
  const everyday = [
    "CPU 95%", "主库连不上", "db-01 无响应", "构建失败：main 分支", "磁盘剩余 3%", "验证码 123456，5 分钟内有效",
    "备份完成", "有人按了门铃", "证书 7 天后到期", "Uptime Kuma 已接通", "服务已恢复", "今晚的数据库备份成功",
  ];
  check("★ 日常告警一条都不误拦", everyday.every((t) => findBlocked({ title: t, body: t }, words) === null), everyday.filter((t) => findBlocked({ body: t }, words)).join("、"));
}

console.log("\n★ 违禁词：词表可以用 config:blocklist 整份替换");
{
  const env = makeEnv();
  check("没配置 → 内置词表", (await loadBlocklist(env)).includes("裸聊"));
  const custom = makeEnv();
  custom.PIGEON_KV.store.set("config:blocklist", JSON.stringify(["自定义 词"]));
  check("配了 → 用配置的（同样规整）", JSON.stringify(await loadBlocklist(custom)) === JSON.stringify(["自定义词"]));
  const off = makeEnv();
  off.PIGEON_KV.store.set("config:blocklist", "[]");
  check("[] → 关掉过滤", (await loadBlocklist(off)).length === 0);
  for (const [label, raw] of [["不是 JSON", "裸聊,约炮"], ["不是字符串数组", "[1,2]"], ["是对象", '{"words":["x"]}']]) {
    const bad = makeEnv();
    bad.PIGEON_KV.store.set("config:blocklist", raw);
    check(`配错了（${label}）→ 退回内置词表，不让过滤悄悄失效`, (await loadBlocklist(bad)).includes("裸聊"));
  }
  const cached = makeEnv();
  const t0 = 1_000_000;
  await loadBlocklist(cached, t0);
  cached.PIGEON_KV.store.set("config:blocklist", JSON.stringify(["新词"]));
  check("一分钟内用缓存", (await loadBlocklist(cached, t0 + 30_000)).includes("裸聊"));
  check("过了一分钟重新读", JSON.stringify(await loadBlocklist(cached, t0 + 61_000)) === JSON.stringify(["新词"]));

  check("只管有成员的群：个人通道不过滤", (await contentRejection(env, { memberIds: [] }, { body: "裸聊" })) === null);
  const why = await contentRejection(env, { memberIds: ["m0000001"] }, { body: "裸聊" });
  check("群里命中 → 拒收理由写明命中的词、指向使用条款", typeof why === "string" && why.includes("「裸聊」") && why.includes("使用条款"), why);
  check("只有密文的群消息不过滤（服务端看不到）", (await contentRejection(env, { memberIds: ["m0000001"] }, { ciphertext: "Y2lwaGVy", iv: "aXY=" })) === null);
}

console.log("\n★ 违禁词：三个推送入口都拦");
{
  const env = makeEnv();
  const g = await makeGroup(env);
  const before = apns.length;
  const path = await call(env, "GET", `/${g.key}/${encodeURIComponent("今晚裸聊")}`);
  check("★ 路径式推送进群 → 400", path.status === 400 && path.json?.message?.includes("「裸聊」"), path.text);
  const post = await call(env, "POST", `/${g.key}`, { body: { title: "广告", body: "真人 荷官 在线" } });
  check("JSON 推送进群 → 400", post.status === 400 && post.json?.message?.includes("「真人荷官」"), post.text);
  const batch = await call(env, "POST", "/push", { body: { device_key: g.key, body: "冰毒" } });
  check("/push 批量接口 → 这个 key 失败，原因写明", batch.status === 400 && batch.json?.data?.[0]?.error?.includes("「冰毒」"), batch.text);
  const hook = await call(env, "POST", `/hook/${g.key}/uptimekuma`, { body: { msg: "摇头丸 特价" } });
  check("webhook 适配器渲染出来的内容 → 400", hook.status === 400 && hook.json?.message?.includes("「摇头丸」"), hook.text);
  check("★ 被拦的一条都没推出去", apns.length === before);

  const clean = await call(env, "GET", `/${g.key}/${encodeURIComponent("有人按了门铃")}`);
  check("正常内容照常推给群主和成员", clean.status === 200 && clean.json?.data?.delivered === 2, clean.text);
  const personal = await call(env, "GET", `/${g.owner.key}/${encodeURIComponent("裸聊")}`);
  check("只有自己的通道不过滤", personal.status === 200, personal.text);
  const sealed = await call(env, "POST", `/${g.key}`, { body: { ciphertext: "Y2lwaGVydGV4dA", iv: "aXZpdml2aXZpdml2" } });
  check("加密的群消息不过滤", sealed.status === 200, sealed.text);

  const custom = makeEnv();
  custom.PIGEON_KV.store.set("config:blocklist", JSON.stringify(["内部代号"]));
  const cg = await makeGroup(custom);
  check("换了词表：新词拦", (await call(custom, "GET", `/${cg.key}/${encodeURIComponent("内部代号泄露")}`)).status === 400);
  check("换了词表：内置的词不再拦", (await call(custom, "GET", `/${cg.key}/${encodeURIComponent("裸聊")}`)).status === 200);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
