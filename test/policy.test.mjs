/**
 * 免打扰时段与去重的测试。
 *
 * 这两条策略的失败方式都是**静默吞掉告警** —— 跨午夜的区间算错一个边界，
 * 或者去重窗口把不同内容判成重复，用户看到的都是「这个通道好像不响了」，
 * 不会有任何报错。所以边界要逐个钉死。
 */
import {
  applyPolicy,
  applyQuietHours,
  isDuplicate,
  isQuietNow,
  parsePolicy,
  parseQuietHours,
  plaintextRejection,
  suspensionRejection,
} from "../.test-build/policy.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function memoryEnv() {
  const store = new Map();
  return {
    PIGEON_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
}

/** 构造一个「上海时间为 hh:mm」的 UTC 时刻 */
function shanghai(hh, mm = 0) {
  // 上海恒为 UTC+8，没有夏令时，换算是确定的
  return new Date(Date.UTC(2026, 5, 15, (hh - 8 + 24) % 24, mm));
}

console.log("\n免打扰时段的解析");
{
  const good = parseQuietHours({ start: "23:00", end: "08:00", timezone: "Asia/Shanghai" });
  check("正常值能解析", good?.start === "23:00" && good?.timezone === "Asia/Shanghai");

  check("时间格式不对 → undefined", parseQuietHours({ start: "25:00", end: "08:00", timezone: "UTC" }) === undefined);
  check("缺时区 → undefined", parseQuietHours({ start: "23:00", end: "08:00" }) === undefined);
  check("时区名瞎写 → undefined", parseQuietHours({ start: "23:00", end: "08:00", timezone: "Mars/Olympus" }) === undefined);
  check("起止相同（等于全天静音）→ undefined", parseQuietHours({ start: "08:00", end: "08:00", timezone: "UTC" }) === undefined);
  check("null → undefined", parseQuietHours(null) === undefined);
}

console.log("\n★ 跨午夜的区间 23:00–08:00");
{
  const quiet = { start: "23:00", end: "08:00", timezone: "Asia/Shanghai" };
  const cases = [
    ["22:59 还没到", 22, 59, false],
    ["23:00 起点算在内", 23, 0, true],
    ["23:30 区间内", 23, 30, true],
    ["00:00 跨过午夜", 0, 0, true],
    ["03:00 凌晨", 3, 0, true],
    ["07:59 快结束", 7, 59, true],
    ["08:00 终点不算在内", 8, 0, false],
    ["12:00 大白天", 12, 0, false],
    ["18:00 傍晚", 18, 0, false],
  ];
  for (const [label, hh, mm, expected] of cases) {
    check(label, isQuietNow(quiet, shanghai(hh, mm)) === expected);
  }
}

console.log("\n不跨午夜的区间 09:00–17:00");
{
  const quiet = { start: "09:00", end: "17:00", timezone: "Asia/Shanghai" };
  check("08:59 区间外", !isQuietNow(quiet, shanghai(8, 59)));
  check("09:00 起点算在内", isQuietNow(quiet, shanghai(9, 0)));
  check("12:00 区间内", isQuietNow(quiet, shanghai(12, 0)));
  check("17:00 终点不算在内", !isQuietNow(quiet, shanghai(17, 0)));
  check("23:00 区间外", !isQuietNow(quiet, shanghai(23, 0)));
}

console.log("\n时区确实生效");
{
  // 同一个 UTC 时刻，在上海是深夜、在纽约是白天
  const moment = shanghai(23, 30);
  check(
    "上海 23:30 在免打扰内",
    isQuietNow({ start: "23:00", end: "08:00", timezone: "Asia/Shanghai" }, moment),
  );
  check(
    "同一时刻纽约是上午，不在免打扰内",
    !isQuietNow({ start: "23:00", end: "08:00", timezone: "America/New_York" }, moment),
  );
}

console.log("\n降级而不是丢弃");
{
  const original = {
    title: "磁盘满了", body: "94%", level: "timeSensitive",
    sound: "alarm", call: "1", volume: "8", url: "https://x",
  };
  const quieted = applyQuietHours(original);
  check("级别降到 passive", quieted.level === "passive");
  check("铃声被去掉", quieted.sound === undefined);
  check("重复响铃被去掉", quieted.call === undefined);
  check("音量被去掉", quieted.volume === undefined);
  check("★ 正文照常保留（不是丢弃，是降级）", quieted.body === "94%" && quieted.title === "磁盘满了");
  check("其它字段不受影响", quieted.url === "https://x");
  check("不修改入参", original.level === "timeSensitive");
}

console.log("\n★ critical 不受免打扰压制");
{
  const env = memoryEnv();
  const channel = {
    id: "k1",
    key: "k1",
    policy: { quietHours: { start: "23:00", end: "08:00", timezone: "Asia/Shanghai" } },
  };
  const night = shanghai(2, 0);

  const normal = await applyPolicy(env, channel, { body: "一般告警", level: "active" }, night);
  check("普通级别深夜被降级", normal.quieted && normal.params.level === "passive");

  const critical = await applyPolicy(env, channel, { body: "生产挂了", level: "critical" }, night);
  check(
    "★ critical 深夜照样吵醒（这正是它存在的理由）",
    !critical.quieted && critical.params.level === "critical",
  );
}

console.log("\n去重");
{
  const env = memoryEnv();
  const msg = { title: "服务不可用", body: "api-01 无响应", level: "timeSensitive" };

  check("第一条放行", !(await isDuplicate(env, "k1", msg, 300)));
  check("立刻重复的第二条被压掉", await isDuplicate(env, "k1", msg, 300));
  check("第三条也被压掉", await isDuplicate(env, "k1", msg, 300));

  check(
    "正文不同就不算重复",
    !(await isDuplicate(env, "k1", { ...msg, body: "api-02 无响应" }, 300)),
  );
  check(
    "★ 同样文案但级别升高，不算重复（状态变化必须让人知道）",
    !(await isDuplicate(env, "k1", { ...msg, level: "critical" }, 300)),
  );
  check(
    "另一个通道互不影响",
    !(await isDuplicate(env, "k2", msg, 300)),
  );
  check("窗口为 0 时完全不去重", !(await isDuplicate(env, "k1", msg, 0)));
}

console.log("\n去重机制自身失效时必须放行");
{
  const broken = {
    PIGEON_KV: {
      async get() {
        throw new Error("KV 挂了");
      },
      async put() {
        throw new Error("KV 挂了");
      },
    },
  };
  check(
    "★ KV 报错时放行而不是拦截（宁可多响一次，不能吞掉告警）",
    !(await isDuplicate(broken, "k1", { body: "x" }, 300)),
  );
}

console.log("\n策略解析");
{
  const policy = parsePolicy({
    quietHours: { start: "22:00", end: "07:00", timezone: "Asia/Shanghai" },
    dedupeWindow: 120,
  });
  check("两项都解析出来", policy.quietHours?.start === "22:00" && policy.dedupeWindow === 120);

  check("负的窗口被忽略", parsePolicy({ dedupeWindow: -5 }).dedupeWindow === undefined);
  check("非数字窗口被忽略", parsePolicy({ dedupeWindow: "abc" }).dedupeWindow === undefined);
  check("超长窗口被夹到上限", parsePolicy({ dedupeWindow: 999999 }).dedupeWindow === 3600);
  check("空对象 → 空策略", Object.keys(parsePolicy({})).length === 0);
  check("null → 空策略", Object.keys(parsePolicy(null)).length === 0);
  check(
    "时段非法时只丢掉时段，不影响窗口",
    parsePolicy({ quietHours: { start: "bad" }, dedupeWindow: 60 }).dedupeWindow === 60,
  );
}

console.log("\n去重优先于免打扰");
{
  const env = memoryEnv();
  const channel = {
    id: "k9",
    key: "k9",
    policy: {
      quietHours: { start: "23:00", end: "08:00", timezone: "Asia/Shanghai" },
      dedupeWindow: 300,
    },
  };
  const night = shanghai(2, 0);
  const msg = { body: "重复的告警", level: "active" };

  const first = await applyPolicy(env, channel, msg, night);
  check("第一条：不压制，但被降级", !first.suppressed && first.quieted);

  const second = await applyPolicy(env, channel, msg, night);
  check("第二条：直接压制，不必再谈降级", second.suppressed && !second.quieted);
}

console.log("\n★ 只接受加密消息");
{
  check("严格的 true 才打开", parsePolicy({ e2eOnly: true }).e2eOnly === true);
  check("字符串 \"true\" 不算", parsePolicy({ e2eOnly: "true" }).e2eOnly === undefined);
  const strict = { id: "c1", policy: { e2eOnly: true } };
  check("明文被拒，并说明怎么办", typeof plaintextRejection(strict, { body: "明文" }) === "string");
  check("密文放行", plaintextRejection(strict, { ciphertext: "x" }) === null);
  check("没开这个开关的通道不管", plaintextRejection({ id: "c2" }, { body: "明文" }) === null);
}

console.log("\n★ 加密消息不能被去重误伤");
{
  const env = memoryEnv();
  check("第一条加密消息放行", !(await isDuplicate(env, "k7", { ciphertext: "AAAA" }, 300)));
  check("★ 另一条加密消息（密文不同）也放行", !(await isDuplicate(env, "k7", { ciphertext: "BBBB" }, 300)));
}

console.log("\n★ 停用的通道");
{
  check("没停用 → null", suspensionRejection({}) === null);
  check("停用了 → 给出理由", typeof suspensionRejection({ suspended: { at: 1 } }) === "string");
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
