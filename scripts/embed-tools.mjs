// 把 tools/pigeon-send.mjs 原样嵌进 Worker，由 /tools/pigeon-send.mjs 下发。
// 测试会核对线上下发的内容和这份源码逐字节一致 —— 用户审计的就是他跑的。
import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../tools/pigeon-send.mjs", import.meta.url), "utf8");
writeFileSync(
  new URL("../src/generated/sender.ts", import.meta.url),
  "// 由 scripts/embed-tools.mjs 生成，不要手改。源文件：tools/pigeon-send.mjs\n" +
    `export const SENDER_SCRIPT = ${JSON.stringify(source)};\n`,
);
