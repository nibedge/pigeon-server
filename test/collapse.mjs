import { createHash } from "node:crypto";

/** 这个通道里这个消息 id 的 apns-collapse-id（见 push.ts collapseId）：断言要的是「同通道同 id 折叠、别的通道不折叠」 */
export const collapseOf = (channelId, id) => createHash("sha256").update(`${channelId}/${id}`).digest("hex").slice(0, 32);
