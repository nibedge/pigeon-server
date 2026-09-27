/**
 * 几条功能线合起来之后的衔接：账号偏好里 L4 的 critical、minLevel 和 L5 的 readThrough 同时在场时，
 * prefs_patch（逐条合并）、老版 App 的整份 prefs 替换、sanitizePrefs 的清洗、删通道 / 退群的清理都各管各的、互不吃掉。
 * 在进程里跑（见 l4-harness.mjs）：
 *
 *   node test/api-cross-prefs.test.mjs
 */
import { check, finish, makeEnv, makeGroup, newAccount } from "./l4-harness.mjs";

const env = makeEnv();
const O = await newAccount(env, "老王");
const M = await newAccount(env, "李四");
const G = await makeGroup(env, O, [M]);
const prefsOf = async (who) => (await who.as("GET", `/account/${who.id}`)).json?.data?.prefs ?? {};
const t0 = Date.now() - 60_000;

console.log("\n★ 一次 prefs_patch 里三样都给");
{
  const r = await M.as("PATCH", `/account/${M.id}`, {
    prefs_patch: {
      critical: { [G.id]: true },
      minLevel: { [G.id]: "timeSensitive", [M.channelId]: "Critical" },
      readThrough: { [G.id]: t0, [M.channelId]: t0 },
    },
  });
  check("受理", r.status === 200, r.text);
  const p = await prefsOf(M);
  check("★ critical 留下", p.critical?.[G.id] === true, JSON.stringify(p));
  check("★ minLevel 留下（Critical 规整成 critical）", p.minLevel?.[G.id] === "timeSensitive" && p.minLevel?.[M.channelId] === "critical", JSON.stringify(p.minLevel));
  check("★ readThrough 留下", p.readThrough?.[G.id] === t0 && p.readThrough?.[M.channelId] === t0, JSON.stringify(p.readThrough));
}

console.log("\n★ 分开改：各自逐条合并，不碰别的");
{
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { readThrough: { [G.id]: t0 + 5000 } } });
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { minLevel: { [M.channelId]: null } } });
  const p = await prefsOf(M);
  check("readThrough 往前走", p.readThrough?.[G.id] === t0 + 5000);
  check("★ 删一条 minLevel 不动另一条、不动 critical 和 readThrough", !(M.channelId in (p.minLevel ?? {})) && p.minLevel?.[G.id] === "timeSensitive" && p.critical?.[G.id] === true && p.readThrough?.[M.channelId] === t0, JSON.stringify(p));
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { readThrough: { [G.id]: t0 } } });
  check("readThrough 不往回退", (await prefsOf(M)).readThrough?.[G.id] === t0 + 5000);
}

console.log("\n★ 老版 App 交整份 prefs（不认识这三项）");
{
  const r = await M.as("PATCH", `/account/${M.id}`, { prefs: { pins: [G.id] } });
  check("受理", r.status === 200, r.text);
  const p = await prefsOf(M);
  check("置顶换成新的", JSON.stringify(p.pins) === JSON.stringify([G.id]), JSON.stringify(p));
  check("★ critical、minLevel、readThrough 都还在", p.critical?.[G.id] === true && p.minLevel?.[G.id] === "timeSensitive" && p.readThrough?.[G.id] === t0 + 5000, JSON.stringify(p));
}

console.log("\n★ 坏数据：一项坏了不拖累别的");
{
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { critical: "yes", minLevel: { [G.id]: "loud" }, readThrough: [1, 2] } });
  const p = await prefsOf(M);
  check("★ 认不出的级别丢掉那一条，别的照旧", p.critical?.[G.id] === true && !(G.id in (p.minLevel ?? {})) && p.readThrough?.[G.id] === t0 + 5000, JSON.stringify(p));
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { minLevel: { [G.id]: "timeSensitive" }, critical: { nosuchchannel: true } } });
  check("不认识的通道不收", !("nosuchchannel" in ((await prefsOf(M)).critical ?? {})));
}

console.log("\n★ 退群：三项里这个群的条目一起清掉");
{
  const left = await M.as("DELETE", `/account/${M.id}/channels/${G.id}`);
  check("退群", left.status === 200, left.text);
  const p = await prefsOf(M);
  check("★ critical、minLevel、readThrough 里都没有这个群了", !(G.id in (p.critical ?? {})) && !(G.id in (p.minLevel ?? {})) && !(G.id in (p.readThrough ?? {})), JSON.stringify(p));
  check("自己通道的条目还在", p.readThrough?.[M.channelId] === t0, JSON.stringify(p));
}

console.log("\n★ 入群后紧接着交紧急授权、同一秒还在存已读水位：账号记录撞上一秒一次的上限也不丢");
{
  // 线上 KV 同一个键每秒只能写一次：入群刚写过账号，紧接着的 PATCH 第一次写会被 429 拒掉
  const N = await newAccount(env, "小张");
  const H = await makeGroup(env, O, [N], "值班群");
  const put = env.PIGEON_KV.put;
  let rejected = 0;
  env.PIGEON_KV.put = async (key, value, opts) => {
    if (key === `acct:${N.id}` && rejected === 0) {
      rejected += 1;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }
    return put.call(env.PIGEON_KV, key, value, opts);
  };
  const granted = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { critical: { [H.id]: true } } });
  env.PIGEON_KV.put = put;
  check("★ 第一次写撞上 429：等过这一秒重读再写，回 200（原先直接 500，App 弹「紧急消息的设置没存上」）", rejected === 1 && granted.status === 200 && granted.json?.data?.prefs?.critical?.[H.id] === true, granted.text);

  const token = "cd".repeat(32);
  env.PIGEON_KV.put = async (key, value, opts) => {
    if (key === `acct:${N.id}` && rejected === 1) {
      rejected += 1;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }
    return put.call(env.PIGEON_KV, key, value, opts);
  };
  const start = await N.as("PUT", `/account/${N.id}/devices/${N.token}/activity-start-token`, { token });
  env.PIGEON_KV.put = put;
  const stored = JSON.parse(env.PIGEON_KV.store.get(`acct:${N.id}`));
  check("★ 登记开始令牌撞上 429 也记上了，前面交的紧急授权还在", rejected === 2 && start.status === 200 && stored.devices[0].activityStartToken === token && stored.prefs?.critical?.[H.id] === true, `${start.status} ${JSON.stringify(stored.prefs)}`);
}

finish();
