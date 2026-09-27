/**
 * 回执与回调在进程里跑的测试（见 l4-harness.mjs）：长轮询读了几次 KV、点按钮时回执写不进去还发不发回调、
 * 回调密钥第一次生成时的并发。这几样要数存储读写、让某一次写失败、拨时钟 —— 打本地 wrangler dev 做不到。
 *
 *   node test/api-l2-receipts.test.mjs
 */
import { call, check, finish, makeEnv, newAccount } from "./l4-harness.mjs";

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

finish();
