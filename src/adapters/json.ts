import { genericMessage } from "../compat/generic";
import type { PushParams } from "../types";
import type { Adapter } from "./util";

/**
 * 通用 JSON：/hook/{key}/json。什么结构都收 —— 标题取 title、name、event、status 这类常见字段，
 * 正文取 message、description 这类成段的文字，没有就排前 6 个字段「键：值」；url、image、severity 认得出就用上。
 *
 * 和直接推到 /{key} 的区别：/{key} 先按信鸽自己的参数读（title、body、level、id……），认不出正文才兜底；
 * 这里一律当别人家的数据看 —— 请求体里的 id、level、repeat 不会被当成推送参数，
 * 别的服务的「id」「level」和信鸽的意思多半对不上
 */
export const json: Adapter = {
  name: "json",
  label: "任意 JSON",
  render(body): PushParams | null {
    const m = genericMessage(body);
    if (!m.title && !m.body) return null;
    return { title: m.title, body: m.body, url: m.url, image: m.image, level: m.level };
  },
};
