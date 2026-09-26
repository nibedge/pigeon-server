/**
 * 个人偏好的端到端测试：prefs_patch 只交改了的那几项、那几条，服务端按项合并；群图片开关（images）。
 *
 *   BASE=http://localhost:8799 node test/api-s1-prefs.test.mjs
 *
 * 和别的 API 测试共用同一个 wrangler dev、同一份本地 KV：账号都是这个文件自己新建的，令牌每次跑都换一批。
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

/** client：带上 X-Pigeon-Client（新版 App 都带）；不给就是老版 App */
async function call(method, path, { body, secret, client } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (client) headers["x-pigeon-client"] = client;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言去判断 */
  }
  return { status: res.status, json };
}

const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);
const NEW_APP = "ios/1.1 (20)";

async function newAccount(seed, name) {
  const r = await call("POST", "/account", {
    body: { device_token: token(seed), environment: "sandbox", device_name: name },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {} };
}

// ── C6 偏好按项合并 ──────────────────────────────────────────────────

console.log("\n偏好按项合并：prefs_patch");
const P = await newAccount("pfa", "偏好测试机");
const addChannel = async (acct, name) =>
  (await call("POST", `/account/${acct.id}/channels`, { secret: acct.secret, body: { name } })).json?.data?.channel?.id;
const c1 = P.channel.id;
const c2 = await addChannel(P, "第二个");
const c3 = await addChannel(P, "第三个");
check("准备三个通道", [c1, c2, c3].every((c) => typeof c === "string"), JSON.stringify([c1, c2, c3]));
const patch = (body, client = NEW_APP) => call("PATCH", `/account/${P.id}`, { secret: P.secret, client, body });
const prefsOf = (res) => res.json?.data?.prefs ?? {};
{
  const base = await patch({
    prefs: {
      pins: [c1],
      mutes: { [c1]: 0 },
      folders: [{ id: "fold0001", name: "工作" }, { id: "fold0002", name: "家里" }],
      folderOf: { [c1]: "fold0001", [c2]: "fold0002" },
      sounds: { [c1]: "alert_siren.caf" },
      defaultSound: "chime_soft.caf",
      aliases: { [c2]: "值班" },
    },
  });
  check("老方式整份提交照常 → 200", base.status === 200 && prefsOf(base).pins?.[0] === c1, JSON.stringify(prefsOf(base)));

  const m = await patch({ prefs_patch: { mutes: { [c2]: 0 } } });
  const mp = prefsOf(m);
  check("★ 只交一条免打扰 → 200", m.status === 200, JSON.stringify(m.json));
  check("★ 表类逐条合并：新旧两条都在", mp.mutes?.[c1] === 0 && mp.mutes?.[c2] === 0, JSON.stringify(mp.mutes));
  check("★ 没提到的偏好原样保留", mp.pins?.[0] === c1 && mp.folderOf?.[c2] === "fold0002" && mp.sounds?.[c1] === "alert_siren.caf" && mp.defaultSound === "chime_soft.caf" && mp.aliases?.[c2] === "值班", JSON.stringify(mp));
  check("响应仍是完整账号视图", typeof m.json?.data?.account_id === "string" && Array.isArray(m.json?.data?.channels) && Array.isArray(m.json?.data?.devices));

  const del = prefsOf(await patch({ prefs_patch: { mutes: { [c1]: null } } }));
  check("★ 条目值 null → 只删这一条", !(c1 in (del.mutes ?? {})) && del.mutes?.[c2] === 0, JSON.stringify(del.mutes));
  const noAlias = prefsOf(await patch({ prefs_patch: { aliases: null } }));
  check("★ 顶层 null → 整项删掉", !("aliases" in noAlias) && noAlias.mutes?.[c2] === 0, JSON.stringify(noAlias));
  const pins = prefsOf(await patch({ prefs_patch: { pins: [c3, c1] } }));
  check("★ 数组整项替换", JSON.stringify(pins.pins) === JSON.stringify([c3, c1]), JSON.stringify(pins.pins));
  const ds = prefsOf(await patch({ prefs_patch: { defaultSound: "alert_urgent.caf" } }));
  check("★ 单值整项替换", ds.defaultSound === "alert_urgent.caf");
  const badDs = prefsOf(await patch({ prefs_patch: { defaultSound: "../../etc/passwd.caf" } }));
  check("合并后照样清洗：非法铃声名进不来", badDs.defaultSound === undefined, JSON.stringify(badDs));
  const folders = prefsOf(await patch({ prefs_patch: { folders: [{ id: "fold0001", name: "工作" }] } }));
  check("★ 删掉一个分组：归到它下面的通道一起清掉", folders.folderOf?.[c1] === "fold0001" && !(c2 in (folders.folderOf ?? {})), JSON.stringify(folders.folderOf));
  const ghost = prefsOf(await patch({ prefs_patch: { sounds: { nosuchchan01: "chime_soft.caf", [c3]: "chime_soft.caf" } } }));
  check("不认识的通道丢掉，合法的留下", ghost.sounds?.[c3] === "chime_soft.caf" && !("nosuchchan01" in ghost.sounds) && ghost.sounds?.[c1] === "alert_siren.caf", JSON.stringify(ghost.sounds));

  // 两台设备手里各是旧快照，各改一项：原先整份替换，后提交的会把先提交的那项抹掉
  await patch({ prefs_patch: { mutes: { [c3]: 0 } } });            // iPhone：给第三个设免打扰
  await patch({ prefs_patch: { aliases: { [c2]: "iPad 起的" } } }); // iPad：给第二个起备注名
  const both = prefsOf(await call("GET", `/account/${P.id}`, { secret: P.secret }));
  check("★ 两台设备各改一项：两项都留下", both.mutes?.[c3] === 0 && both.aliases?.[c2] === "iPad 起的" && both.mutes?.[c2] === 0, JSON.stringify(both));

  const snapshot = JSON.stringify(both);
  const arr = await patch({ prefs_patch: [1, 2] });
  check("★ prefs_patch 是数组 → 400", arr.status === 400 && arr.json?.code === 400, JSON.stringify(arr.json));
  const str = await patch({ prefs_patch: "mutes" });
  check("prefs_patch 是字符串 → 400", str.status === 400);
  check("★ 400 时什么都没改", JSON.stringify(prefsOf(await call("GET", `/account/${P.id}`, { secret: P.secret }))) === snapshot);
  const nameAndBad = await patch({ name: "不该生效", prefs_patch: 5 });
  check("同一请求里的改名也不生效", nameAndBad.status === 400 && (await call("GET", `/account/${P.id}`, { secret: P.secret })).json?.data?.name !== "不该生效");
  const nul = await patch({ prefs_patch: null });
  check("prefs_patch: null → 200，什么都不变", nul.status === 200 && JSON.stringify(prefsOf(nul)) === snapshot);
  const badTable = await patch({ prefs_patch: { mutes: [] } });
  check("★ 表类给了数组：丢掉，原有免打扰不清空", badTable.status === 200 && JSON.stringify(prefsOf(badTable).mutes) === JSON.stringify(both.mutes), JSON.stringify(prefsOf(badTable).mutes));

  const both2 = await patch({ prefs: { mutes: { [c1]: 0 } }, prefs_patch: { mutes: { [c2]: 0 } } });
  const bp = prefsOf(both2);
  check("★ prefs 和 prefs_patch 同时来：先整份替换，再合并补丁", JSON.stringify(bp.mutes) === JSON.stringify({ [c1]: 0, [c2]: 0 }) && !("pins" in bp) && !("aliases" in bp), JSON.stringify(bp));

  const combo = await patch({ name: "合并测试", prefs_patch: { pins: [c2] } });
  check("改名和补丁在同一个请求里都生效", combo.status === 200 && combo.json?.data?.name === "合并测试" && prefsOf(combo).pins?.[0] === c2);

  const legacyWhole = await patch({ prefs: { pins: [c1] } }, null);
  check("★ 老版 App 整份提交：仍是整份替换（没设过图片开关）", legacyWhole.status === 200 && JSON.stringify(prefsOf(legacyWhole)) === JSON.stringify({ pins: [c1] }), JSON.stringify(prefsOf(legacyWhole)));
  const emptied = await patch({ prefs_patch: { pins: null } });
  check("删到一项不剩 → prefs 是空对象", emptied.status === 200 && JSON.stringify(prefsOf(emptied)) === "{}", JSON.stringify(prefsOf(emptied)));
}

// ── C8 群图片开关 ────────────────────────────────────────────────────

console.log("\n群图片开关：images 偏好");
{
  const img = prefsOf(await patch({ prefs_patch: { images: { [c1]: true, [c2]: false, [c3]: "true", nosuchchan01: true } } }));
  check("★ 只留已知通道的布尔值", JSON.stringify(img.images) === JSON.stringify({ [c1]: true, [c2]: false }), JSON.stringify(img.images));
  const flip = prefsOf(await patch({ prefs_patch: { images: { [c2]: true } } }));
  check("★ 逐条合并：改一个不动另一个", flip.images?.[c1] === true && flip.images?.[c2] === true, JSON.stringify(flip.images));
  const whole = prefsOf(await patch({ prefs: { images: { [c3]: true } } }));
  check("整份提交也认 images", JSON.stringify(whole.images) === JSON.stringify({ [c3]: true }));

  // 老版 App 不认识 images：它随手改个置顶，交上来的整份偏好里没有 images，不能把开关清空
  const legacy = prefsOf(await patch({ prefs: { pins: [c2], mutes: { [c1]: 0 } } }, null));
  check("★ 老版 App 整份提交（不带 images）：图片开关原样保留", JSON.stringify(legacy.images) === JSON.stringify({ [c3]: true }), JSON.stringify(legacy));
  check("★ 它提到的项照旧整份替换", JSON.stringify(legacy.pins) === JSON.stringify([c2]) && legacy.mutes?.[c1] === 0 && !("defaultSound" in legacy), JSON.stringify(legacy));
  const cleared = prefsOf(await patch({ prefs: { pins: [c2], images: {} } }));
  check("整份提交里明说 images 为空 → 清空", !("images" in cleared), JSON.stringify(cleared));

  // 成员给加入的群打开了图片 —— 退群、群被删，这一条都跟着清掉
  const O = await newAccount("pfo", "群主");
  const M = await newAccount("pfm", "成员");
  const g1 = O.channel.id;
  const g2 = await addChannel(O, "第二个群");
  for (const gid of [g1, g2]) {
    const code = (await call("POST", `/account/${O.id}/channels/${gid}/invites`, { secret: O.secret })).json?.data?.code;
    await call("POST", `/account/${M.id}/invites/${code}`, { secret: M.secret });
  }
  const set = await call("PATCH", `/account/${M.id}`, {
    secret: M.secret,
    client: NEW_APP,
    body: { prefs_patch: { images: { [g1]: true, [g2]: true }, mutes: { [g1]: 0 } } },
  });
  check("成员给两个加入的群打开图片 → 两条都在", JSON.stringify(prefsOf(set).images) === JSON.stringify({ [g1]: true, [g2]: true }), JSON.stringify(prefsOf(set)));

  const left = await call("DELETE", `/account/${M.id}/channels/${g1}`, { secret: M.secret });
  check("成员退出第一个群 → 200", left.status === 200, JSON.stringify(left.json));
  const afterLeave = prefsOf(await call("GET", `/account/${M.id}`, { secret: M.secret }));
  check("★ 退群：这个群的图片开关跟着清掉，另一个不动", JSON.stringify(afterLeave.images) === JSON.stringify({ [g2]: true }), JSON.stringify(afterLeave));

  const dropped = await call("DELETE", `/account/${O.id}/channels/${g2}`, { secret: O.secret });
  check("群主删掉第二个群 → 200", dropped.status === 200);
  const afterDelete = prefsOf(await call("GET", `/account/${M.id}`, { secret: M.secret }));
  check("★ 群被删：成员那边的图片开关也清掉", !(g2 in (afterDelete.images ?? {})), JSON.stringify(afterDelete));

  const stale = await call("PATCH", `/account/${M.id}`, { secret: M.secret, client: NEW_APP, body: { prefs_patch: { images: { [g1]: true } } } });
  check("★ 拿旧快照给已经退出的群开图片：丢掉", !(g1 in (prefsOf(stale).images ?? {})), JSON.stringify(prefsOf(stale)));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
