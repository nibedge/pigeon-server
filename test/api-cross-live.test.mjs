/**
 * 几条功能线合起来之后的衔接：实时活动（L6）跟着接收方自己的设置（L4 的 critical 授权、minLevel 最低级别、
 * 成员发消息时发消息的本人）走 —— 普通推送到谁那里是静默的，就不给谁开实时活动；
 * critical 被降成时效性的人照样响，照样开。在进程里跑（见 l6-live-harness.mjs）：
 *
 *   node test/api-cross-live.test.mjs
 */
import { alerts, check, finish, hit, live, liveRequests, makeEnv, register, reset, SECRET } from "./l6-live-harness.mjs";

const { deliver } = live;
const OWNER = "a1".padEnd(64, "0");
const MEMBER = "b1".padEnd(64, "0");
const startsFor = (token) => liveRequests().filter((r) => r.payload.aps?.event === "start" && r.token === `5${token.slice(0, 2)}`.padEnd(64, "a"));
const alertTo = (token) => alerts().find((r) => r.token === token)?.payload;

console.log("\n★ 接收方的最低提醒级别：普通推送静默的，不开实时活动");
{
  reset();
  const { env, channel, recipients } = makeEnv({ group: true, memberPrefs: { minLevel: { chanL001: "critical" } } });
  const report = await deliver(env, channel, recipients, { title: "主库挂了", id: "db-1", status: "firing", level: "timeSensitive", live: "1" });
  check("群主：原样响、开了实时活动", alertTo(OWNER)?.aps["interruption-level"] === "time-sensitive" && startsFor(OWNER).length === 1);
  check("★ 最低级别「只提醒紧急的」的成员：时效性静默送达，不开实时活动", alertTo(MEMBER)?.aps["interruption-level"] === "passive" && startsFor(MEMBER).length === 0, JSON.stringify(liveRequests().map((r) => r.token)));
  check("响应里只开了一个", report.live?.started === 1 && report.muted === 1, JSON.stringify(report.live));
}
{
  reset();
  const { env, channel, recipients } = makeEnv({ group: true, memberPrefs: { minLevel: { chanL001: "timeSensitive" } } });
  await deliver(env, channel, recipients, { title: "主库挂了", id: "db-2", status: "firing", level: "timeSensitive", live: "1" });
  check("最低级别到时效性、消息正是时效性：照响、照开", startsFor(MEMBER).length === 1 && alertTo(MEMBER)?.aps["interruption-level"] === "time-sensitive");
}

console.log("\n★ critical 与接收方的紧急授权");
{
  reset();
  const { env, channel, recipients } = makeEnv({ group: true });
  await deliver(env, channel, recipients, { title: "机房断电", id: "pw-1", status: "firing", level: "critical", live: "1" });
  check("没授权紧急的成员：降成时效性，照响", alertTo(MEMBER)?.level === "timeSensitive" && alertTo(MEMBER)?.aps["interruption-level"] === "time-sensitive", JSON.stringify(alertTo(MEMBER)));
  check("★ 降成时效性的也开实时活动（它是响着送到的）", startsFor(MEMBER).length === 1 && startsFor(OWNER).length === 1);
}
{
  reset();
  const { env, channel, recipients } = makeEnv({ group: true, memberPrefs: { mutes: { chanL001: 0 } } });
  await deliver(env, channel, recipients, { title: "机房断电", id: "pw-2", status: "firing", level: "critical", live: "1" });
  check("★ 静音了这个群、没授权紧急：critical 到他那里静默，不开实时活动", alertTo(MEMBER)?.aps["interruption-level"] === "passive" && startsFor(MEMBER).length === 0);
}
{
  reset();
  const { env, channel, recipients } = makeEnv({ group: true, memberPrefs: { mutes: { chanL001: 0 }, critical: { chanL001: true } } });
  await deliver(env, channel, recipients, { title: "机房断电", id: "pw-3", status: "firing", level: "critical", live: "1" });
  // 没拿到 Apple 的紧急授权前 critical 按时效性送（aps 里是 time-sensitive），原样的那一版顶层 level 仍是 critical
  check("★ 静音了但授权了紧急：critical 突破，开实时活动", alertTo(MEMBER)?.level === "critical" && alertTo(MEMBER)?.aps["interruption-level"] === "time-sensitive" && startsFor(MEMBER).length === 1, JSON.stringify(alertTo(MEMBER)));
}

console.log("\n★ 发消息的本人");
{
  reset();
  const { env, channel, recipients, member } = makeEnv({ group: true });
  await deliver(env, channel, recipients, { title: "我来看看", id: "m-1", status: "firing", live: "1" }, { sender: "张三", senderId: member.id });
  check("★ 发消息的人自己的设备静默收下，不开实时活动", alertTo(MEMBER)?.aps["interruption-level"] === "passive" && startsFor(MEMBER).length === 0 && startsFor(OWNER).length === 1);
}

console.log("\n★ 告警演练（L5）走真告警的路子：通道默认开了实时活动的，演练也开一块，收尾时收起");
{
  reset();
  const { env, owner } = makeEnv({ defaults: { live: "1" } });
  const post = (body) => hit(env, `/account/${owner.id}/selftest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  const started = await (await post({ drill: true })).json();
  check("演练受理", started.code === 200 && typeof started.data?.drill?.id === "string", JSON.stringify(started));
  check("★ 演练开了实时活动", startsFor(OWNER).length === 1 && startsFor(OWNER)[0].payload.aps.attributes.messageId === started.data?.drill?.id, JSON.stringify(liveRequests().map((r) => r.payload.aps?.event)));
  // 手机上开起来之后登记这一块的更新令牌（App 做的事）
  const reg = await register(env, owner, owner.devices[0], started.data.drill.id, "9".repeat(64), started.data.sent_at);
  check("登记更新令牌", reg.status === 200 && reg.json?.data?.registered === true, JSON.stringify(reg));
  const ended = await (await post({ drill_resolve: started.data.drill.id })).json();
  check("收尾受理", ended.code === 200, JSON.stringify(ended));
  check("★ 收尾时那一块收起", liveRequests().some((r) => r.payload.aps?.event === "end"), JSON.stringify(liveRequests().map((r) => r.payload.aps?.event)));
}

finish("实时活动 × 接收方设置 全部通过");
