/**
 * 给 App 核对用的样本：实时活动的推送和登记接口的响应，按真实的投递流程和 Worker 入口跑出来，
 * 和 test/fixtures/live-activity-samples.json 逐字节比对。
 *
 *   node test/api-l6-live-samples.test.mjs                    比对
 *   UPDATE_FIXTURES=1 node test/api-l6-live-samples.test.mjs  改了推送的样子之后重新生成
 *
 * App 仓库的 Tests/Fixtures/ 里放着同一份，App 的测试拿它按系统的规矩（默认策略的 JSONDecoder）解码：
 * attributes-type 和 Swift 类型名一字不差、content-state 和 attributes 的每个键都有对应的属性、时刻的单位对得上。
 * 两边各自的测试只能证明「自己和自己写的样子对得上」，这份样本把两边钉在一起 —— 服务端这里一变就会失败，
 * 重新生成后拷到 App 仓库，App 的测试再过一遍，才算两边都认。
 *
 * 时刻从固定的 1800000000123 起算（把 Date.now 换成手拨的钟），生成结果每次一样。
 * 认领凭据由每次现生成的私钥签出，换成固定的占位（先核对它就是普通通知里那一个）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { alerts, check, finish, hit, live, liveRequests, makeEnv, put, register, reset, SECRET } from "./l6-live-harness.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/live-activity-samples.json", import.meta.url));
const { announceAck, deliver, ATTRIBUTES_TYPE, LIVE_DISMISS_AFTER_MS } = live;

/** 2027-01-15 08:00:00.123 UTC。带毫秒，秒和毫秒弄混时一眼看得出 */
const T0 = 1_800_000_000_123;
const realNow = Date.now;
let clock = T0;
Date.now = () => clock;
const at = (offsetMs) => {
  clock = T0 + offsetMs;
};

/** 认领凭据的占位：base64url 的 "sample-ack-sig" */
const ACK_SIG = "c2FtcGxlLWFjay1zaWc";
const SAMPLE_HEADERS = ["apns-push-type", "apns-topic", "apns-priority", "apns-expiration"];

/** 发给某个令牌的那一条实时活动推送：只留和内容有关的头（不留带签名的 authorization） */
function pushTo(token, label) {
  const request = liveRequests().find((r) => r.token === token);
  check(`${label}：发出去了`, request !== undefined);
  if (!request) return null;
  const headers = Object.fromEntries(SAMPLE_HEADERS.filter((h) => h in request.headers).map((h) => [h, request.headers[h]]));
  const payload = structuredClone(request.payload);
  const attrs = payload.aps?.attributes;
  if (attrs?.ackSig !== undefined) {
    const sig = alerts()[0]?.payload.ack_sig;
    check(`${label}：认领凭据就是普通通知里那一个（样本里换成占位）`, typeof sig === "string" && attrs.ackSig === sig, `${attrs.ackSig} / ${sig}`);
    attrs.ackSig = ACK_SIG;
  }
  return { headers, payload };
}

const json = async (response) => response.json();
const auth = (method) => ({ method, headers: { authorization: `Bearer ${SECRET}` } });

const pushes = {};
const responses = {};

console.log("\n★ 样本：群里的一件事，开始 → 登记 → 认领 → 恢复");
{
  const { env, channel, recipients, owner, member } = makeEnv({ group: true });
  const mid = "db:01";
  reset();
  at(0);
  await deliver(env, channel, recipients, {
    title: "主库连不上", body: "db-01 无响应", id: mid, status: "firing", level: "timeSensitive", live: "1",
  });
  pushes.start = pushTo(owner.devices[0].activityStartToken, "开始");

  at(5_000);
  responses.registration_firing = (await register(env, owner, owner.devices[0], mid, "ab".repeat(40), T0)).json;
  await register(env, member, member.devices[0], mid, "ef".repeat(40), T0);

  reset();
  at(3 * 60_000);
  await announceAck(env, channel, recipients, mid, "张三");
  pushes.update_acked = pushTo("ab".repeat(40), "认领");

  // 认领之后才开起来的一块来登记
  at(3 * 60_000 + 5_000);
  responses.registration_acked = (await register(env, member, member.devices[0], mid, "cd".repeat(40), T0)).json;

  reset();
  at(18 * 60_000);
  await deliver(env, channel, recipients, { body: "已恢复", id: mid, status: "resolved" });
  pushes.end_resolved = pushTo("ab".repeat(40), "恢复");

  // 推送晚到的一块：恢复之后才来登记
  at(18 * 60_000 + 5_000);
  responses.registration_resolved = (await register(env, owner, owner.devices[0], mid, "99".repeat(40), T0)).json;
}

console.log("\n★ 样本：个人通道的加密消息，开始 → 撤回");
{
  const { env, channel, recipients, owner } = makeEnv();
  const mid = "pay:7";
  reset();
  at(0);
  await deliver(env, channel, recipients, { ciphertext: "Y2lwaGVy", iv: "aXY=", id: mid, status: "firing", live: "1" });
  pushes.start_sealed = pushTo(owner.devices[0].activityStartToken, "加密消息的开始");

  at(10_000);
  await register(env, owner, owner.devices[0], mid, "12".repeat(40), T0);
  reset();
  at(60_000);
  await deliver(env, channel, recipients, { id: mid, delete: "1" });
  pushes.end_retracted = pushTo("12".repeat(40), "撤回");

  at(65_000);
  responses.registration_retracted = (await register(env, owner, owner.devices[0], mid, "34".repeat(40), T0)).json;
}

console.log("\n★ 样本：开始令牌的登记、账号视图里的标记、删除");
{
  const { env, owner } = makeEnv({ ownerDevices: [{ token: "cd".repeat(32), env: "production", name: "iPhone", addedAt: T0 - 86_400_000 }] });
  const path = `/account/${owner.id}/devices/${owner.devices[0].token}/activity-start-token`;
  at(0);
  responses.start_token_put = await json(await hit(env, path, put({ token: "5a".repeat(40) })));
  const view = await json(await hit(env, `/account/${owner.id}`, auth("GET")));
  const item = view?.data?.devices?.[0] ?? {};
  // 只留设备项里和这件事有关的几个键：别的功能往账号视图里加字段，不该让这份样本跟着变
  responses.account_device = Object.fromEntries(
    ["token_prefix", "environment", "name", "added_at", "activity_start_token_prefix"].filter((k) => k in item).map((k) => [k, item[k]]),
  );
  at(2_000);
  responses.start_token_delete = await json(await hit(env, path, auth("DELETE")));
}

Date.now = realNow;

const samples = {
  about: [
    "服务端 test/api-l6-live-samples.test.mjs 按真实的投递流程和接口跑出来的样子；App 仓库 Tests/Fixtures/ 里是同一份，逐字节一致。",
    "别手改：服务端改了实时活动推送或登记接口的样子，跑 UPDATE_FIXTURES=1 node test/api-l6-live-samples.test.mjs 重新生成，拷到 App 仓库再跑 App 的测试。",
    `时刻从 ${T0}（毫秒）起算；认领凭据每次跑都不一样，换成了固定的占位。`,
  ],
  attributes_type: ATTRIBUTES_TYPE,
  dismiss_after_seconds: LIVE_DISMISS_AFTER_MS / 1000,
  pushes,
  responses,
};

console.log("\n★ 样本本身");
check("五种推送都采到了", ["start", "update_acked", "end_resolved", "start_sealed", "end_retracted"].every((k) => pushes[k]?.payload?.aps));
check("登记接口的响应都是 200 的信封", Object.entries(responses)
  .filter(([k]) => k !== "account_device")
  .every(([, r]) => r?.code === 200 && r.data), JSON.stringify(responses));
check("账号视图里的标记是开始令牌的前 12 位", responses.account_device.activity_start_token_prefix === "5a".repeat(6));
check("撤回之后登记回的是 retracted", responses.registration_retracted?.data?.status === "retracted");

const text = `${JSON.stringify(samples, null, 2)}\n`;
if (process.env.UPDATE_FIXTURES === "1") {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, text);
  console.log(`  已重新生成 ${FIXTURE}\n  记得拷到 App 仓库的 Tests/Fixtures/，再跑 App 的 ./scripts/test.sh`);
} else if (!existsSync(FIXTURE)) {
  check("样本文件在", false, "没有 test/fixtures/live-activity-samples.json：UPDATE_FIXTURES=1 生成一份");
} else {
  const stored = readFileSync(FIXTURE, "utf8");
  const same = stored === text;
  let detail = "";
  if (!same) {
    const a = stored.split("\n");
    const b = text.split("\n");
    const line = a.findIndex((l, i) => l !== b[i]);
    detail = `第 ${line + 1} 行起不同：存的是 ${JSON.stringify(a[line])}，现在是 ${JSON.stringify(b[line])}。` +
      "推送的样子变了：确认 App 解得开之后 UPDATE_FIXTURES=1 重新生成，并拷到 App 仓库的 Tests/Fixtures/";
  }
  check("★ 实时活动的推送和登记响应和给 App 的样本一模一样", same, detail);
}

finish("实时活动的样本全部通过");
