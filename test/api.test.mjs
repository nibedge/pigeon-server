/**
 * 账号 / 通道 / 群组 API 的端到端测试。
 *
 * 打的是真跑起来的 Worker（默认本地 wrangler dev），因为这一层的价值全在
 * 路由、鉴权和 KV 读写的接缝上 —— 把它们 mock 掉就等于什么都没测。
 *
 *   BASE=http://localhost:8799 node test/api.test.mjs
 *
 * APNs 那一段在本地必然失败（workerd 不跟 Apple 谈 HTTP/2），所以断言只到
 * 「路由正确、鉴权正确、数据落对地方、推给了几台设备」为止，不断言投递成功。
 */
const BASE = process.env.BASE || "http://localhost:8799";

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
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 某些路径回的不是 JSON，交给断言去判断 */
  }
  return { status: res.status, json };
}

const fakeToken = (seed) => seed.repeat(64).slice(0, 64);

async function newAccount(seed, deviceName) {
  const r = await call("POST", "/account", {
    body: { device_token: fakeToken(seed), environment: "sandbox", device_name: deviceName },
  });
  const data = r.json?.data ?? {};
  return { status: r.status, raw: r.json, data, id: data.account_id, secret: data.secret };
}

// ── 建账号 ──────────────────────────────────────────────────────────
console.log("\n建账号");
const A = await newAccount("a", "测试 iPhone");
check("返回 200", A.status === 200, JSON.stringify(A.raw));
check("给了 account_id", typeof A.id === "string" && A.id.length >= 6, A.id);
check("给了 secret", typeof A.secret === "string" && A.secret.length >= 40);
check("自带一个默认通道", A.data.channels?.length === 1, JSON.stringify(A.data.channels));
const dflt = A.data.channels?.[0] ?? {};
check("★ 通道的公开 id 与推送 key 是两个值", typeof dflt.id === "string" && typeof dflt.key === "string" && dflt.id !== dflt.key);
check("自己是 owner", dflt.role === "owner");
check("人数 1", dflt.member_count === 1);
check("登记了第一台设备", A.data.devices?.length === 1);
check("设备名回带", A.data.devices?.[0]?.name === "测试 iPhone");
check("环境记成了 sandbox", A.data.devices?.[0]?.environment === "sandbox");
const rawCreate = JSON.stringify(A.raw);
check("响应里没有 secretHash", !rawCreate.includes("secretHash"));
check("响应里没有完整 device token", !rawCreate.includes(fakeToken("a")));

console.log("\n入参校验");
check("没有 device_token → 400", (await call("POST", "/account", { body: {} })).status === 400);
check(
  "device_token 含非法字符 → 400",
  (await call("POST", "/account", { body: { device_token: "not-a-token!" } })).status === 400,
);

console.log("\n鉴权");
check("不带 bearer → 401", (await call("GET", `/account/${A.id}`)).status === 401);
check("错的 secret → 401", (await call("GET", `/account/${A.id}`, { secret: "wrong-secret-value" })).status === 401);
check("对的 secret → 200", (await call("GET", `/account/${A.id}`, { secret: A.secret })).status === 200);
const ghost = await call("GET", "/account/doesnotexist000000", { secret: A.secret });
check("不存在的账号回 401 而不是 404（不泄漏 id 是否存在）", ghost.status === 401, String(ghost.status));

console.log("\n显示名");
const named = await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { name: "  张三  " } });
check("设显示名 → 200", named.status === 200, JSON.stringify(named.json));
check("首尾空白去掉", named.json?.data?.name === "张三", named.json?.data?.name);
const long = await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { name: "名".repeat(40) } });
check("超长截到 20 字", long.json?.data?.name?.length === 20, String(long.json?.data?.name?.length));
const cleared = await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { name: "" } });
check("传空串 = 清掉", cleared.json?.data?.name === undefined);
await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { name: "张三" } });

// ── 通道管理（按公开 id 寻址） ──────────────────────────────────────
console.log("\n通道管理");
const added = await call("POST", `/account/${A.id}/channels`, {
  secret: A.secret,
  body: { name: "生产监控", icon: "server.rack" },
});
check("新建通道 → 200", added.status === 200, JSON.stringify(added.json));
const monitorId = added.json?.data?.channel?.id;
const monitorKey = added.json?.data?.channel?.key;
check("新通道有独立的 key", typeof monitorKey === "string" && monitorKey !== dflt.key);

const renamed = await call("PATCH", `/account/${A.id}/channels/${monitorId}`, {
  secret: A.secret,
  body: { name: "生产告警", defaults: { level: "timeSensitive", sound: "alarm", bogus: "x" } },
});
check("按 id 改名 + 设默认值 → 200", renamed.status === 200, JSON.stringify(renamed.json));
const monitor = renamed.json?.data?.channels?.find((c) => c.id === monitorId);
check("名字改掉了", monitor?.name === "生产告警", monitor?.name);
check("默认值存下来了", monitor?.defaults?.level === "timeSensitive", JSON.stringify(monitor?.defaults));
check("不认识的默认参数被丢掉", monitor?.defaults?.bogus === undefined, JSON.stringify(monitor?.defaults));
check(
  "拿 key 当 id 用 → 404",
  (await call("PATCH", `/account/${A.id}/channels/${monitorKey}`, { secret: A.secret, body: { name: "x" } })).status === 404,
);
check(
  "错的 secret → 401",
  (await call("PATCH", `/account/${A.id}/channels/${monitorId}`, { secret: "wrong", body: { name: "x" } })).status === 401,
);
check(
  "改不存在的通道 → 404",
  (await call("PATCH", `/account/${A.id}/channels/nosuchid1234`, { secret: A.secret, body: { name: "x" } })).status === 404,
);

// ── 换设备：这套架构存在的理由 ──────────────────────────────────────
console.log("\n换设备后 key 依然有效");
const joinedDevice = await call("POST", `/account/${A.id}/devices`, {
  secret: A.secret,
  body: { device_token: fakeToken("b"), environment: "sandbox", device_name: "新 iPhone" },
});
check("第二台设备加入 → 200", joinedDevice.status === 200);
check("账号下有两台设备", joinedDevice.json?.data?.devices?.length === 2);

// App 手里只有 12 位前缀，完整 token 从不回给客户端 —— 必须能按前缀删
const removedDevice = await call("DELETE", `/account/${A.id}/devices/${fakeToken("a").slice(0, 12)}`, { secret: A.secret });
check("★ 按 12 位前缀移除设备 → 200（原先永远 404）", removedDevice.status === 200, JSON.stringify(removedDevice.json));
check(
  "只剩新 iPhone",
  removedDevice.json?.data?.devices?.length === 1 && removedDevice.json?.data?.devices?.[0]?.name === "新 iPhone",
);
check("太短的前缀不认 → 404", (await call("DELETE", `/account/${A.id}/devices/bbbb`, { secret: A.secret })).status === 404);

const afterSwap = await call("GET", `/account/${A.id}`, { secret: A.secret });
const keysNow = afterSwap.json?.data?.channels?.map((c) => c.key) ?? [];
check("★ 换完设备，两个通道 key 一个没变", keysNow.includes(dflt.key) && keysNow.includes(monitorKey), JSON.stringify(keysNow));
const pushAfterSwap = await call("GET", `/${monitorKey}/test`);
check("★ 旧 URL 仍然指向这个账号（不是 404）", pushAfterSwap.status !== 404, `status=${pushAfterSwap.status}`);

// ── 群组 ────────────────────────────────────────────────────────────
console.log("\n★ 群组：邀请与加入");
const B = await newAccount("c", "B 的 iPhone");
check("第二个账号 → 200", B.status === 200);

const inv = await call("POST", `/account/${A.id}/channels/${monitorId}/invites`, { secret: A.secret });
check("创建者生成邀请 → 200", inv.status === 200, JSON.stringify(inv.json));
const code = inv.json?.data?.code ?? "";
check("邀请码 8 位", code.length === 8, code);
// 主机取自请求本身：线上是 https://nfo.im，本地 wrangler dev 会按 routes 报成 http://nfo.im
check("给了可分享的网页链接", /^https?:\/\/[^/]+\/i\/[A-Z0-9]{8}$/.test(inv.json?.data?.link ?? "") && inv.json.data.link.endsWith(`/i/${code}`), inv.json?.data?.link);
check("也给了 App 深链", inv.json?.data?.app_link === `pigeon://invite?c=${code}`);

const preview = await call("GET", `/account/${B.id}/invites/${code}`, { secret: B.secret });
check("加入前能预览群名", preview.status === 200 && preview.json?.data?.channel?.name === "生产告警", JSON.stringify(preview.json));
check("预览里有人数", preview.json?.data?.channel?.member_count === 1);
check("还没加入 → role 为空", preview.json?.data?.role === null);
check("★ 预览里没有推送 key", !JSON.stringify(preview.json).includes(monitorKey));

const join = await call("POST", `/account/${B.id}/invites/${code}`, { secret: B.secret });
check("凭邀请码加入 → 200", join.status === 200, JSON.stringify(join.json));
check("结果是 joined", join.json?.data?.result === "joined");
const bView = join.json?.data?.channels?.find((c) => c.id === monitorId);
check("成员的列表里有这个群", Boolean(bView));
check("成员的身份是 member", bView?.role === "member");
check("★ 成员拿不到推送 key", bView !== undefined && !("key" in bView), JSON.stringify(bView));
check("★ 整个响应里都没有 key", !JSON.stringify(join.json).includes(monitorKey));
check("人数变成 2", bView?.member_count === 2);
check(
  "小写邀请码也认，重复加入 → already",
  (await call("POST", `/account/${B.id}/invites/${code.toLowerCase()}`, { secret: B.secret })).json?.data?.result === "already",
);
check(
  "创建者用自己的邀请 → owner",
  (await call("POST", `/account/${A.id}/invites/${code}`, { secret: A.secret })).json?.data?.result === "owner",
);
check("乱写的邀请码 → 404", (await call("POST", `/account/${B.id}/invites/ZZZZ2222`, { secret: B.secret })).status === 404);
check(
  "照着落地页的分组写法（带连字符、小写）也能预览",
  (await call("GET", `/account/${B.id}/invites/${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`, { secret: B.secret })).status === 200,
);

console.log("\n★ 只有创建者能管理");
const asB = (method, path, body) => call(method, path, { secret: B.secret, body });
check("成员改名 → 403", (await asB("PATCH", `/account/${B.id}/channels/${monitorId}`, { name: "被篡改" })).status === 403);
check("成员改策略 → 403", (await asB("PATCH", `/account/${B.id}/channels/${monitorId}`, { policy: null })).status === 403);
check("成员生成邀请 → 403", (await asB("POST", `/account/${B.id}/channels/${monitorId}/invites`)).status === 403);
check("成员看成员名单 → 403", (await asB("GET", `/account/${B.id}/channels/${monitorId}/members`)).status === 403);
check("成员换 key → 403", (await asB("POST", `/account/${B.id}/channels/${monitorId}/key`)).status === 403);
check("成员踢人 → 403", (await asB("DELETE", `/account/${B.id}/channels/${monitorId}/members/${A.id}`)).status === 403);
check(
  "碰不属于自己的通道 → 404（不泄漏它存在）",
  (await asB("PATCH", `/account/${B.id}/channels/${dflt.id}`, { name: "x" })).status === 404,
);
check("拿自己的 secret 冒充别人的账号 → 401", (await call("GET", `/account/${A.id}`, { secret: B.secret })).status === 401);
const stillNamed = await call("GET", `/account/${A.id}`, { secret: A.secret });
check("篡改没有生效", stillNamed.json?.data?.channels?.find((c) => c.id === monitorId)?.name === "生产告警");

const members = await call("GET", `/account/${A.id}/channels/${monitorId}/members`, { secret: A.secret });
const memberList = members.json?.data?.members ?? [];
check("创建者看成员名单 → 200", members.status === 200);
check("名单里是 B", memberList.length === 1 && memberList[0].account_id === B.id, JSON.stringify(memberList));
check("没设显示名就用设备名", memberList[0]?.name === "B 的 iPhone", memberList[0]?.name);

console.log("\n★ 推送扇出到每个人");
const groupPush = await call("GET", `/${monitorKey}/磁盘满了`);
check("群组推送打到了两台设备（A 的新 iPhone + B 的 iPhone）", groupPush.json?.data?.devices === 2, JSON.stringify(groupPush.json));

console.log("\n★ 认领");
await call("PATCH", `/account/${B.id}`, { secret: B.secret, body: { name: "李四" } });
const mid = `msg-${Date.now()}`;
const ack1 = await call("POST", `/account/${B.id}/channels/${monitorId}/ack`, {
  secret: B.secret,
  body: { message_id: mid, title: "磁盘满了" },
});
check("成员认领 → 200", ack1.status === 200, JSON.stringify(ack1.json));
check("是第一个", ack1.json?.data?.first === true);
check("记的是显示名", ack1.json?.data?.acked_by === "李四", ack1.json?.data?.acked_by);
const ack2 = await call("POST", `/account/${A.id}/channels/${monitorId}/ack`, { secret: A.secret, body: { message_id: mid } });
check(
  "★ 后来者 → 不是第一个，并被告知是谁在处理",
  ack2.json?.data?.first === false && ack2.json?.data?.acked_by === "李四" && ack2.json?.data?.mine === false,
  JSON.stringify(ack2.json),
);
const ack3 = await call("POST", `/account/${B.id}/channels/${monitorId}/ack`, { secret: B.secret, body: { message_id: mid } });
check("自己重复点 → mine", ack3.json?.data?.first === false && ack3.json?.data?.mine === true);
check(
  "认领别人的通道 → 404",
  (await asB("POST", `/account/${B.id}/channels/${dflt.id}/ack`, { message_id: mid })).status === 404,
);
check("没有 message_id → 400", (await asB("POST", `/account/${B.id}/channels/${monitorId}/ack`, {})).status === 400);
check(
  "message_id 超长 → 400",
  (await asB("POST", `/account/${B.id}/channels/${monitorId}/ack`, { message_id: "x".repeat(65) })).status === 400,
);

console.log("\n邀请落地页");
const page = await fetch(`${BASE}/i/${code}`);
const pageText = await page.text();
check("有效邀请 → 200", page.status === 200, String(page.status));
check("页面上有群名", pageText.includes("生产告警"));
check("有打开 App 的深链", pageText.includes(`pigeon://invite?c=${code}`));
check("★ 页面上没有推送 key", !pageText.includes(monitorKey));
check("不让搜索引擎收录", pageText.includes("noindex"));
check("落地页把 # 后面的密钥转交给 App（服务器看不到这一段）", pageText.includes("location.hash"));
check("不缓存（邀请会过期、人数会变）", (page.headers.get("cache-control") ?? "").includes("no-store"));
const lower = await fetch(`${BASE}/i/${code.toLowerCase()}`);
check("小写链接也能打开，深链里用规范写法", lower.status === 200 && (await lower.text()).includes(`c=${code}`));
const dead = await fetch(`${BASE}/i/ZZZZ2222`);
check("无效邀请 → 404 页面", dead.status === 404 && (await dead.text()).includes("邀请已失效"));

const evil = await call("POST", `/account/${A.id}/channels`, {
  secret: A.secret,
  body: { name: "<script>alert(1)</script>" },
});
const evilId = evil.json?.data?.channel?.id;
const evilCode = (await call("POST", `/account/${A.id}/channels/${evilId}/invites`, { secret: A.secret })).json?.data?.code;
const evilPage = await (await fetch(`${BASE}/i/${evilCode}`)).text();
check(
  "★ 通道名里的 HTML 被转义（防存储型 XSS）",
  !evilPage.includes("<script>alert(1)</script>") && evilPage.includes("&lt;script&gt;"),
);
await call("DELETE", `/account/${A.id}/channels/${evilId}`, { secret: A.secret });

console.log("\n退出、移除、换 key");
const left = await asB("DELETE", `/account/${B.id}/channels/${monitorId}`);
check("成员删除 = 退出 → 200", left.status === 200 && left.json?.data?.left === true, JSON.stringify(left.json));
check("退出后列表里没了", !left.json?.data?.channels?.some((c) => c.id === monitorId));
const ownerView = await call("GET", `/account/${A.id}`, { secret: A.secret });
check(
  "★ 成员退出不影响通道本身",
  ownerView.json?.data?.channels?.some((c) => c.id === monitorId && c.member_count === 1),
);

await asB("POST", `/account/${B.id}/invites/${code}`);
const kicked = await call("DELETE", `/account/${A.id}/channels/${monitorId}/members/${B.id}`, { secret: A.secret });
check("创建者移除成员 → 200", kicked.status === 200, JSON.stringify(kicked.json));
const bAfterKick = await call("GET", `/account/${B.id}`, { secret: B.secret });
check("被移除的人列表里没了", !bAfterKick.json?.data?.channels?.some((c) => c.id === monitorId));

const rotated = await call("POST", `/account/${A.id}/channels/${monitorId}/key`, { secret: A.secret });
const newKey = rotated.json?.data?.key;
check("换 key → 200 且给了新 key", rotated.status === 200 && typeof newKey === "string" && newKey !== monitorKey);
check("★ 旧地址立即失效 → 404", (await call("GET", `/${monitorKey}/test`)).status === 404);
check("新地址可用（非 404）", (await call("GET", `/${newKey}/test`)).status !== 404);

console.log("\n删通道");
await asB("POST", `/account/${B.id}/invites/${code}`); // 先让 B 回到群里，看删除时成员是否一起清掉
const del = await call("DELETE", `/account/${A.id}/channels/${monitorId}`, { secret: A.secret });
check("创建者删掉群 → 200", del.status === 200 && del.json?.data?.deleted === true, JSON.stringify(del.json));
check("被删的 key 立刻失效 → 404", (await call("GET", `/${newKey}/test`)).status === 404);
const bAfterDelete = await call("GET", `/account/${B.id}`, { secret: B.secret });
check("★ 成员那边也一起没了", !bAfterDelete.json?.data?.channels?.some((c) => c.id === monitorId));
check("邀请跟着失效", (await asB("POST", `/account/${B.id}/invites/${code}`)).status === 404);
check(
  "最后一个自己创建的通道删不掉",
  (await call("DELETE", `/account/${A.id}/channels/${dflt.id}`, { secret: A.secret })).status === 400,
);

console.log("\n★ 个人偏好（置顶、免打扰、分组）");
const P = await newAccount("p", "偏好测试机");
const pCh = (await call("POST", `/account/${P.id}/channels`, { secret: P.secret, body: { name: "项目 A" } })).json?.data?.channel ?? {};
const prefsRes = await call("PATCH", `/account/${P.id}`, {
  secret: P.secret,
  body: {
    prefs: {
      pins: [pCh.id, "ghostchannel01"],
      mutes: { [pCh.id]: 0 },
      folders: [{ id: "fold0001", name: "工作" }],
      folderOf: { [pCh.id]: "fold0001" },
    },
  },
});
const pv = prefsRes.json?.data?.prefs ?? {};
check("偏好存下来了", prefsRes.status === 200 && pv.pins?.[0] === pCh.id && pv.mutes?.[pCh.id] === 0 && pv.folderOf?.[pCh.id] === "fold0001", JSON.stringify(pv));
check("不属于自己的通道被丢掉", !pv.pins?.includes("ghostchannel01"));
check(
  "★ 免打扰的人照样收到（降成静默）—— 推送仍然打到设备",
  (await call("GET", `/${pCh.key}/静默测试`)).json?.data?.devices === 1,
);

console.log("\n★ 端到端加密");
const fp = "0123456789abcdef";
check("设置主密钥指纹", (await call("PATCH", `/account/${P.id}`, { secret: P.secret, body: { e2e_fingerprint: fp } })).json?.data?.e2e_fingerprint === fp);
check(
  "★ 指纹不能改成别的（换主密钥会让其他设备全部解不开）→ 409",
  (await call("PATCH", `/account/${P.id}`, { secret: P.secret, body: { e2e_fingerprint: "fedcba9876543210" } })).status === 409,
);
check("指纹格式不对 → 400", (await call("PATCH", `/account/${P.id}`, { secret: P.secret, body: { e2e_fingerprint: "xyz" } })).status === 400);
const reset = await call("DELETE", `/account/${P.id}/e2e`, { secret: P.secret });
check("重置加密：指纹清掉", reset.status === 200 && reset.json?.data?.e2e_fingerprint === undefined, JSON.stringify(reset.json?.data?.e2e_fingerprint));
check(
  "重置之后才能换成新的指纹",
  (await call("PATCH", `/account/${P.id}`, { secret: P.secret, body: { e2e_fingerprint: "fedcba9876543210" } })).json?.data?.e2e_fingerprint === "fedcba9876543210",
);
check("别人的 secret 重置不了 → 401", (await call("DELETE", `/account/${P.id}/e2e`, { secret: "wrong" })).status === 401);
const putKey = await call("PUT", `/account/${P.id}/keys/${pCh.id}`, { secret: P.secret, body: { wrapped: "A".repeat(32) } });
check("替设备保管包裹后的群密钥", putKey.status === 200 && putKey.json?.data?.wrapped_keys?.[pCh.id] === "A".repeat(32), JSON.stringify(putKey.json));
check(
  "不属于自己的通道 → 404",
  (await call("PUT", `/account/${P.id}/keys/nosuchchannel1`, { secret: P.secret, body: { wrapped: "A".repeat(32) } })).status === 404,
);
check("密文格式不对 → 400", (await call("PUT", `/account/${P.id}/keys/${pCh.id}`, { secret: P.secret, body: { wrapped: "<script>" } })).status === 400);
check(
  "删掉保管的密钥",
  !(pCh.id in ((await call("DELETE", `/account/${P.id}/keys/${pCh.id}`, { secret: P.secret })).json?.data?.wrapped_keys ?? {})),
);
const strict = await call("PATCH", `/account/${P.id}/channels/${pCh.id}`, { secret: P.secret, body: { policy: { e2eOnly: true } } });
check("打开「只接受加密消息」", strict.json?.data?.channels?.find((c) => c.id === pCh.id)?.policy?.e2eOnly === true);
check("★ 明文推送被拒 → 400", (await call("GET", `/${pCh.key}/明文`)).status === 400);
check("★ 第三方 webhook 也被拒（它们没法加密）→ 400", (await call("POST", `/hook/${pCh.key}/github`, { body: { zen: "x" } })).status === 400);
const encPush = await call("POST", `/${pCh.key}`, { body: { ciphertext: "Y2lwaGVydGV4dA", iv: "aXZpdml2aXZpdml2" } });
check("★ 只带密文、没有标题正文的推送被接受（不是 400）", encPush.status !== 400, JSON.stringify(encPush.json));

console.log("\n★ 删除账号");
const deleted = await call("DELETE", `/account/${P.id}`, { secret: P.secret });
check("删除 → 200", deleted.status === 200 && deleted.json?.data?.deleted === true, JSON.stringify(deleted.json));
check("之后凭 secret 也进不去 → 401", (await call("GET", `/account/${P.id}`, { secret: P.secret })).status === 401);
check("★ 它的推送地址立即失效 → 404", (await call("GET", `/${pCh.key}/x`)).status === 404);
check("错的 secret 删不了 → 401", (await call("DELETE", `/account/${A.id}`, { secret: "wrong" })).status === 401);

console.log("\n★ 举报、屏蔽与停用");
{
  const O = await newAccount("r", "群主的手机");
  const M = await newAccount("s", "成员的手机");
  const N = await newAccount("t", "路人的手机");
  await call("PATCH", `/account/${O.id}`, { secret: O.secret, body: { name: "王五" } });
  const made = await call("POST", `/account/${O.id}/channels`, { secret: O.secret, body: { name: "举报测试群" } });
  const gid = made.json?.data?.channel?.id;
  const gkey = made.json?.data?.channel?.key;
  const invite = async () =>
    (await call("POST", `/account/${O.id}/channels/${gid}/invites`, { secret: O.secret })).json?.data?.code;
  const code1 = await invite();
  const joined = await call("POST", `/account/${M.id}/invites/${code1}`, { secret: M.secret });
  check("成员加入（前置）", joined.status === 200, JSON.stringify(joined.json));

  const report = (who, body) => call("POST", `/account/${who.id}/channels/${gid}/report`, { secret: who.secret, body });
  const r1 = await report(M, { reason: "spam", detail: "一直发广告", message_id: "m-1", excerpt: "加微信领红包" });
  check("成员举报一条消息 → 200", r1.status === 200 && r1.json?.data?.reported === true, JSON.stringify(r1.json));
  check("举报整个群（不带 message_id）→ 200", (await report(M, { reason: "harassment" })).status === 200);
  check("理由不在列表里 → 400", (await report(M, { reason: "nope" })).status === 400);
  check("没给理由 → 400", (await report(M, {})).status === 400);
  check("message_id 格式不对 → 400", (await report(M, { reason: "spam", message_id: "x".repeat(65) })).status === 400);
  check("补充说明太长不报错，截断收下 → 200", (await report(M, { reason: "other", detail: "长".repeat(800) })).status === 200);
  check("★ 群主举报自己的群 → 400", (await report(O, { reason: "spam" })).status === 400);
  check("★ 不在群里的人举报 → 404", (await report(N, { reason: "spam" })).status === 404);
  check(
    "没带凭据 → 401",
    (await call("POST", `/account/${M.id}/channels/${gid}/report`, { body: { reason: "spam" } })).status === 401,
  );

  const blocked = await call("POST", `/account/${M.id}/channels/${gid}/block`, { secret: M.secret });
  check("屏蔽群主 → 200", blocked.status === 200, JSON.stringify(blocked.json));
  check("★ 屏蔽即退出：这个群不在他的列表里了", !(blocked.json?.data?.channels ?? []).some((c) => c.id === gid));
  const entry = (blocked.json?.data?.blocked ?? []).find((b) => b.account_id === O.id);
  check("★ 屏蔽名单里有群主，带着对方当时的显示名", entry?.name === "王五", JSON.stringify(blocked.json?.data?.blocked));
  const roster = await call("GET", `/account/${O.id}/channels/${gid}/members`, { secret: O.secret });
  check("★ 群主的成员名单里也没有他了", !(roster.json?.data?.members ?? []).some((m) => m.account_id === M.id));
  check("群主屏蔽不了自己 → 400", (await call("POST", `/account/${O.id}/channels/${gid}/block`, { secret: O.secret })).status === 400);

  const code2 = await invite();
  const peek = await call("GET", `/account/${M.id}/invites/${code2}`, { secret: M.secret });
  check("屏蔽后仍能预览邀请，并被告知已屏蔽", peek.status === 200 && peek.json?.data?.blocked === true, JSON.stringify(peek.json));
  check("没屏蔽的人预览时没有这个标记", (await call("GET", `/account/${N.id}/invites/${code2}`, { secret: N.secret })).json?.data?.blocked === undefined);
  check("★ 被屏蔽的群主再发邀请也进不来 → 403", (await call("POST", `/account/${M.id}/invites/${code2}`, { secret: M.secret })).status === 403);

  const unblocked = await call("DELETE", `/account/${M.id}/blocked/${O.id}`, { secret: M.secret });
  check("解除屏蔽 → 200，名单清空", unblocked.status === 200 && (unblocked.json?.data?.blocked ?? []).length === 0, JSON.stringify(unblocked.json));
  check("解除一个不在名单上的人 → 404", (await call("DELETE", `/account/${M.id}/blocked/${O.id}`, { secret: M.secret })).status === 404);
  check("解除后可以重新加入", (await call("POST", `/account/${M.id}/invites/${code2}`, { secret: M.secret })).status === 200);

  const suspended = await call("POST", `/__test__/suspend/${gid}`);
  check("（本地测试接口）停用 → 200", suspended.status === 200, JSON.stringify(suspended.json));
  const pushed = await call("GET", `/${gkey}/还能推吗`);
  check("★ 停用后路径式推送被拒 → 403", pushed.status === 403, JSON.stringify(pushed.json));
  const batch = await call("POST", "/push", { body: { device_key: gkey, body: "还能推吗" } });
  check("★ 停用后批量接口也推不进去", batch.status === 400 && JSON.stringify(batch.json).includes("停用"), JSON.stringify(batch.json));
  check("★ 停用后第三方 webhook 被拒 → 403", (await call("POST", `/hook/${gkey}/github`, { body: { zen: "x" } })).status === 403);
  check("★ 停用后邀请预览 → 403", (await call("GET", `/account/${N.id}/invites/${code2}`, { secret: N.secret })).status === 403);
  check("★ 停用后加入 → 403", (await call("POST", `/account/${N.id}/invites/${code2}`, { secret: N.secret })).status === 403);
  check("停用后不能再生成邀请 → 403", (await call("POST", `/account/${O.id}/channels/${gid}/invites`, { secret: O.secret })).status === 403);
  check(
    "停用后不能认领 → 403",
    (await call("POST", `/account/${M.id}/channels/${gid}/ack`, { secret: M.secret, body: { message_id: "m-1" } })).status === 403,
  );
  const ownerView = await call("GET", `/account/${O.id}`, { secret: O.secret });
  check("群主看得到「已停用」", (ownerView.json?.data?.channels ?? []).find((c) => c.id === gid)?.suspended === true);
  const landing = await (await fetch(`${BASE}/i/${code2}`)).text();
  check("停用的群，公开邀请页不再替它引流", !landing.includes("举报测试群"));

  await call("POST", `/__test__/restore/${gid}`);
  check("恢复后推送不再被拒", (await call("GET", `/${gkey}/恢复了`)).status !== 403);
  const after = await call("GET", `/account/${O.id}`, { secret: O.secret });
  check("恢复后「已停用」标记消失", (after.json?.data?.channels ?? []).find((c) => c.id === gid)?.suspended === undefined);
  check("测试接口只收 POST", (await call("GET", `/__test__/suspend/${gid}`)).status === 404);
  check("测试接口不认识的动作 → 404", (await call("POST", `/__test__/delete/${gid}`)).status === 404);

  const terms = await fetch(`${BASE}/terms`);
  const termsText = await terms.text();
  check("使用条款页 → 200", terms.status === 200);
  check("★ 条款写明零容忍", termsText.includes("零容忍"));
  check("★ 条款写明 24 小时内处理", termsText.includes("24 小时内"));
  check("隐私政策链到使用条款", (await (await fetch(`${BASE}/privacy`)).text()).includes('href="/terms"'));
  check("隐私政策写明了举报记录", (await (await fetch(`${BASE}/privacy`)).text()).includes("举报记录"));
}

console.log("\n★ 网站监控");
{
  const w1 = await call("POST", `/account/${A.id}/watches`, {
    secret: A.secret,
    body: { kind: "up", channelId: dflt.id, url: "https://nfo.im", name: "官网", intervalMinutes: 5 },
  });
  check("建掉线监控 → 200", w1.status === 200 && w1.json?.data?.watch?.id, JSON.stringify(w1.json));
  const wid = w1.json?.data?.watch?.id;
  check("回带规整后的字段", w1.json?.data?.watch?.kind === "up" && w1.json?.data?.watch?.interval_minutes === 5);

  const kw = await call("POST", `/account/${A.id}/watches`, {
    secret: A.secret,
    body: { kind: "keyword", channelId: dflt.id, url: "https://nfo.im", keyword: "有票", present: true },
  });
  check("建关键词监控 → 200", kw.status === 200 && kw.json?.data?.watch?.keyword === "有票");

  check("网址不合法 → 400", (await call("POST", `/account/${A.id}/watches`, { secret: A.secret, body: { kind: "up", channelId: dflt.id, url: "x" } })).status === 400);
  check(
    "★ 监控别人的通道 → 404（推送目标必须自己创建）",
    (await call("POST", `/account/${B.id}/watches`, { secret: B.secret, body: { kind: "up", channelId: dflt.id, url: "https://a.com" } })).status === 404,
  );
  check("没凭据 → 401", (await call("POST", `/account/${A.id}/watches`, { body: { kind: "up", channelId: dflt.id, url: "https://a.com" } })).status === 401);

  const list = await call("GET", `/account/${A.id}/watches`, { secret: A.secret });
  check("列出我的监控（2 个）", (list.json?.data?.watches ?? []).length === 2, JSON.stringify(list.json));
  check("★ 看不到别人的监控", (list.json?.data?.watches ?? []).every((w) => w.channel_id === dflt.id));

  const del = await call("DELETE", `/account/${A.id}/watches/${wid}`, { secret: A.secret });
  check("删除 → 200", del.status === 200 && del.json?.data?.deleted === true);
  check("删完剩 1 个", ((await call("GET", `/account/${A.id}/watches`, { secret: A.secret })).json?.data?.watches ?? []).length === 1);
  check("删不存在的 → 404", (await call("DELETE", `/account/${A.id}/watches/nosuchwatch00`, { secret: A.secret })).status === 404);
}

console.log("\n★ 通用链接与落地页下载");
{
  const aasa = await fetch(`${BASE}/.well-known/apple-app-site-association`);
  check("AASA → 200", aasa.status === 200);
  check("AASA 是 JSON", (aasa.headers.get("content-type") || "").includes("application/json"));
  const j = await aasa.json();
  check("★ AASA 带 appID 与 /i/* 路径", j.applinks?.details?.[0]?.appIDs?.[0] === "R4Q9M7H956.im.nfo.pigeon" && JSON.stringify(j).includes("/i/*"));

  const invite = await call("POST", `/account/${A.id}/channels/${dflt.id}/invites`, { secret: A.secret });
  const code = invite.json?.data?.code;
  const landing = await (await fetch(`${BASE}/i/${code}`)).text();
  check("落地页有下载入口", landing.includes("还没装信鸽"));
  check("未上架时显示「即将上架」", landing.includes("即将上架"));
}

console.log("\n★ 站点图标");
{
  const png = await fetch(`${BASE}/favicon.png`);
  check("favicon.png → 200", png.status === 200);
  check("content-type 是 image/png", (png.headers.get("content-type") || "").includes("image/png"));
  const buf = new Uint8Array(await png.arrayBuffer());
  check(
    "★ 真的是 PNG（魔数 89 50 4E 47）",
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
    `${buf[0]},${buf[1]},${buf[2]},${buf[3]}`,
  );
  check("有实际内容，不是空响应", buf.length > 500, String(buf.length));

  const ico = await fetch(`${BASE}/favicon.ico`);
  check("favicon.ico 也返回图标（浏览器会盲请求它）", ico.status === 200);

  const touch = await fetch(`${BASE}/apple-touch-icon.png`);
  const touchBuf = new Uint8Array(await touch.arrayBuffer());
  check("apple-touch-icon 是更大的那张", touchBuf.length > buf.length, `${touchBuf.length} vs ${buf.length}`);

  const home = await (await fetch(`${BASE}/`)).text();
  check(
    "落地页 head 引用了图标",
    home.includes('rel="icon"') && home.includes("apple-touch-icon"),
  );
  check("★ 图标路径没被当成推送 key", (await call("GET", "/favicon.png")).status === 200);
}

console.log("\n加密推送工具");
{
  const { readFileSync } = await import("node:fs");
  const tool = await fetch(`${BASE}/tools/pigeon-send.mjs`);
  const text = await tool.text();
  check("可以直接下载 → 200", tool.status === 200);
  check("★ 下发的内容和仓库里的源码逐字节一致", text === readFileSync(new URL("../tools/pigeon-send.mjs", import.meta.url), "utf8"));
  check("不存在的工具 → 404", (await fetch(`${BASE}/tools/nothing.mjs`)).status === 404);
}

console.log("\n推送路由");
check("不存在的 key → 404", (await call("GET", "/nosuchkey000000/hi")).status === 404);
check("★ 公开 id 不能当推送地址用", (await call("GET", `/${dflt.id}/hi`)).status === 404);
check("没有内容 → 400", (await call("GET", `/${dflt.key}`)).status === 400);
check(
  "适配器路由能找到通道（非 404）",
  (await call("POST", `/hook/${dflt.key}/github`, { body: { zen: "x", repository: { full_name: "a/b" } } })).status !== 404,
);
check("不存在的适配器 → 404", (await call("POST", `/hook/${dflt.key}/nosuch`, { body: {} })).status === 404);

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
