// 把 tools/ 下的两个工具原样嵌进 Worker，由 /tools/… 下发：
//   tools/pigeon-send.mjs → src/generated/sender.ts（端到端加密发送工具）
//   tools/pigeon.sh       → src/generated/wrapper.ts（命令行包装器）
// 测试会核对线上下发的内容和这里的源码逐字节一致 —— 用户审计的就是他跑的。
import { readFileSync, writeFileSync } from "node:fs";

function embed(source, target, name) {
  const text = readFileSync(new URL(`../tools/${source}`, import.meta.url), "utf8");
  writeFileSync(
    new URL(`../src/generated/${target}`, import.meta.url),
    `// 由 scripts/embed-tools.mjs 生成，不要手改。源文件：tools/${source}\n` +
      `export const ${name} = ${JSON.stringify(text)};\n`,
  );
}

embed("pigeon-send.mjs", "sender.ts", "SENDER_SCRIPT");
embed("pigeon.sh", "wrapper.ts", "WRAPPER_SCRIPT");
