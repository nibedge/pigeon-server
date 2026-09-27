/**
 * 回执与回调在进程里跑的测试（见 l4-harness.mjs）：长轮询读了几次 KV、点按钮时回执写不进去还发不发回调、
 * 回调密钥第一次生成时的并发。这几样要数存储读写、让某一次写失败、拨时钟 —— 打本地 wrangler dev 做不到。
 *
 *   node test/api-l2-receipts.test.mjs
 */
import { apns, call, capture, check, finish, makeEnv, newAccount } from "./l4-harness.mjs";

/**
 * 拨快的时钟：setTimeout 不真等，Date.now 直接往后跳这么多。长轮询一等一分钟，真等的话一个用例就是一分钟
 */
async function withFastClock(fn) {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let now = realNow();
  Date.now = () => now;
  globalThis.setTimeout = (cb, ms = 0, ...args) => {
    now += ms;
    return realSetTimeout(cb, 0, ...args);
  };
  try {
    return await fn(() => now);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

/** 数 KV 读：按键的前缀分别计 */
function countReads(env) {
  const counts = new Map();
  const get = env.PIGEON_KV.get.bind(env.PIGEON_KV);
  env.PIGEON_KV.get = async (key, type) => {
    const prefix = key.slice(0, key.indexOf(":") + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    return get(key, type);
  };
  return {
    of: (prefix) => counts.get(prefix) ?? 0,
    reset: () => counts.clear(),
  };
}

console.log("\n★ 回执长轮询：KV 读得不能太勤");
{
  const env = makeEnv();
  const O = await newAccount(env, "老王");
  const reads = countReads(env);
  const { result, waited } = await withFastClock(async (clock) => {
    const t0 = clock();
    const result = await call(env, "GET", `/${O.key}/receipt/nobody-acks?wait=60`);
    return { result, waited: clock() - t0 };
  });
  check("等满 60 秒、没人处理 → 200，空回执", result.status === 200 && result.json?.data?.acked_by === null, result.text);
  check("到点就回，不多等", waited >= 60_000 && waited < 61_000, `${waited}ms`);
  const rounds = reads.of("ack:");
  check("★ 一分钟的长轮询只读 9 轮（原先每 2 秒一轮，31 轮）", rounds === 9 && reads.of("rcpt:") === 9, `ack ${rounds} / rcpt ${reads.of("rcpt:")}`);

  reads.reset();
  const short = await withFastClock(async (clock) => {
    const t0 = clock();
    await call(env, "GET", `/${O.key}/receipt/nobody-acks?wait=1`);
    return clock() - t0;
  });
  check("wait=1：1 秒就回（最后一轮对准截止时刻）", short >= 1000 && short < 1500 && reads.of("ack:") === 2, `${short}ms，${reads.of("ack:")} 轮`);
}

/** 让某些键的写入失败：times 次之后恢复（不给就一直失败）。模拟撞上 KV 同键每秒一次的上限 */
function failPuts(env, prefix, times = Infinity) {
  const put = env.PIGEON_KV.put.bind(env.PIGEON_KV);
  let failed = 0;
  env.PIGEON_KV.put = async (key, value, opts) => {
    if (key.startsWith(prefix) && failed < times) {
      failed += 1;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }
    return put(key, value, opts);
  };
  return { restore: () => (env.PIGEON_KV.put = put), failed: () => failed };
}

/** 推一条带按钮和回调的消息，取回 App 手里的那份按钮定义和凭据 */
async function pushWithButtons(env, who, id, callback) {
  const { sent } = await capture(() =>
    call(env, "POST", `/${who.key}`, { body: { title: "要处理的事", id, actions: [{ type: "http", label: "收到" }], ...(callback ? { callback } : {}) } }),
  );
  const payload = sent.find((a) => a.device === who.token)?.payload ?? {};
  return { actions: payload.actions, act_sig: payload.act_sig };
}

const callbacksTo = (name, from = 0) => apns.slice(from).filter((a) => a.device === name);

console.log("\n★ 点按钮时回执写不进去：回调照发");
{
  const env = makeEnv();
  const O = await newAccount(env, "老王");
  const tap = (id, button) => O.as("POST", `/account/${O.id}/channels/${O.channelId}/actions`, { message_id: id, index: 0, ...button });

  const button = await pushWithButtons(env, O, "rc-1", "https://hooks.example.com/rc-events");
  check("推出去的按钮带着凭据", typeof button.act_sig === "string" && typeof button.actions === "string", JSON.stringify(button));
  const broken = failPuts(env, "rcpt:");
  const before = apns.length;
  const t0 = Date.now();
  const tapped = await tap("rc-1", button);
  broken.restore();
  check("回执一直写不进去：点按照样回 200", tapped.status === 200 && tapped.json?.data?.ok === true, tapped.text);
  check("写失败等过一秒重试了一次", broken.failed() === 2 && Date.now() - t0 >= 1000, `${broken.failed()} 次，${Date.now() - t0}ms`);
  const events = callbacksTo("rc-events", before);
  check("★ 回调照发：callback 地址是写之前读到的", events.length === 1 && events[0].headers["X-Pigeon-Event"] === "action" && events[0].payload.action === "收到", JSON.stringify(events));

  // 两个人几乎同时点：后写的那次撞上一秒一次的上限，等过这一秒、重读、在最新的记录上再记一次
  await tap("rc-1", button);
  const once = failPuts(env, "rcpt:", 1);
  const second = await tap("rc-1", button);
  once.restore();
  const receipt = (await call(env, "GET", `/${O.key}/receipt/rc-1`)).json?.data ?? {};
  check("★ 撞上一秒一次的上限：重试之后记上了，前一次也还在", second.status === 200 && once.failed() === 1 && receipt.actions?.length === 2, JSON.stringify(receipt));
}

console.log("\n★ 回调密钥：第一次生成落在两个机房");
{
  const env = makeEnv();
  const O = await newAccount(env, "老王");
  const path = `/account/${O.id}/channels/${O.channelId}/callback-secret`;
  const broken = failPuts(env, "cbsec:");
  const first = (await O.as("GET", path)).json?.data?.callback_secret;
  const again = (await O.as("GET", path)).json?.data?.callback_secret;
  broken.restore();
  check("写不进去也回得出密钥（原先点按直接 500）", typeof first === "string" && first.length === 43, String(first));
  check("★ 两次各自「第一次生成」，算出来是同一把（派生的，不是随机的）", first === again && !env.PIGEON_KV.store.has(`cbsec:${O.channelId}`));
  const stored = (await O.as("GET", path)).json?.data?.callback_secret;
  check("写得进去了：存下的还是这一把", stored === first && env.PIGEON_KV.store.get(`cbsec:${O.channelId}`) === first);

  const other = await newAccount(env, "小李");
  const theirs = (await other.as("GET", `/account/${other.id}/channels/${other.channelId}/callback-secret`)).json?.data?.callback_secret;
  check("每个通道各是各的", typeof theirs === "string" && theirs !== first);
  const regen = (await O.as("POST", path)).json?.data?.callback_secret;
  check("★ 重置：换成随机的新值，之后读到的是它", typeof regen === "string" && regen !== first && (await O.as("GET", path)).json?.data?.callback_secret === regen);
}

finish();
