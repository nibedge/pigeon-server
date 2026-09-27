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

finish();
