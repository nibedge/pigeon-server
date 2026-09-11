/**
 * 网站监控的解析与判定。失败方式都是静默的 —— 状态判错就是「该响没响」或「不停乱响」。
 */
import { parseWatchInput } from "../.test-build/watch.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`); }
}

console.log("\n监控输入校验");
{
  const ok = parseWatchInput({ kind: "up", url: "https://nfo.im", channelId: "abcdef" });
  check("掉线监控正常解析", typeof ok === "object" && ok.kind === "up" && ok.name === "nfo.im");
  check("kind 不对 → 报错", typeof parseWatchInput({ kind: "x", url: "https://a.com", channelId: "abcdef" }) === "string");
  check("网址不合法 → 报错", typeof parseWatchInput({ kind: "up", url: "不是网址", channelId: "abcdef" }) === "string");
  check("非 http(s) → 报错", typeof parseWatchInput({ kind: "up", url: "ftp://a.com", channelId: "abcdef" }) === "string");
  check("channelId 格式不对 → 报错", typeof parseWatchInput({ kind: "up", url: "https://a.com", channelId: "!!" }) === "string");
  check("关键词监控缺 keyword → 报错", typeof parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef" }) === "string");

  const kw = parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef", keyword: "有票" });
  check("关键词监控解析，默认出现时提醒", typeof kw === "object" && kw.keyword === "有票" && kw.present === true);
  const gone = parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef", keyword: "售罄", present: false });
  check("可设成消失时提醒", typeof gone === "object" && gone.present === false);

  const fast = parseWatchInput({ kind: "up", url: "https://a.com", channelId: "abcdef", intervalMinutes: 1 });
  check("频率下限夹到 5 分钟", typeof fast === "object" && fast.intervalMinutes === 5);
  const named = parseWatchInput({ kind: "up", url: "https://a.com/x", channelId: "abcdef", name: "我的站" });
  check("自定义名字保留", typeof named === "object" && named.name === "我的站");
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
