import type { ChannelPolicy } from "./policy";

export interface Env {
  PIGEON_KV: KVNamespace;
  APNS_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_TOPIC: string;
  /** 通知 category，需与 iOS App 里 UNNotificationCategory 的标识符一致 */
  APNS_CATEGORY?: string;
  /** 覆盖 APNs 主机，调试时可指向 api.sandbox.push.apple.com */
  APNS_HOST?: string;
  /** 部署时注入的源码版本（git describe）。/info 对外公布，方便对照公开仓库 */
  GIT_COMMIT?: string;
  /**
   * 仅本地 API 测试用：为 "1" 时开放 /__test__/ 下的停用、恢复接口。
   * 线上从不设置 —— 这些路径在 nfo.im 上永远 404，线上的停用走 npm run mod。
   */
  PIGEON_TEST_ADMIN?: string;
}

/** APNs 有两套独立环境，token 只在签发它的那一套里有效 */
export type ApnsEnv = "sandbox" | "production";

export interface Device {
  token: string;
  /**
   * 这个 token 属于哪套 APNs 环境。
   *
   * 模拟器、以及 Xcode 直接装到真机上的 debug 包，拿到的都是 sandbox token；
   * TestFlight 和 App Store 的包才是 production。两者不通用 —— 拿 sandbox
   * token 去打生产端点，只会得到一句 BadDeviceToken，跟「token 已失效」的
   * 报错一模一样，不记下来就会排查半天。
   *
   * 由客户端在注册时申报：App 在编译期就知道自己带的是哪种 aps-environment
   * 权限，这是唯一可靠的信息来源。
   */
  env: ApnsEnv;
  /** 设备名，让用户在设备列表里认得出哪台是哪台 */
  name: string;
  addedAt: number;
}

/**
 * 账号：一个人，可以有多台设备。
 *
 * 账号上只存它创建或加入的通道 id，通道本身独立存放 —— 群组需要同一个通道
 * 被多个账号共享，通道若嵌在某个账号里，就只能属于那一个人。
 */
export interface Account {
  id: string;
  /** bearer secret 的 SHA-256。明文只在创建时返回一次，服务端不留底。 */
  secretHash: string;
  /** 显示名。群组里别人靠它知道是谁在处理告警；不设就用第一台设备的名字 */
  name?: string;
  devices: Device[];
  /** 只是索引，不是真相 —— 谁是成员以通道自己的名单为准，见 listChannels */
  channelIds: string[];
  /** 个人偏好：置顶、免打扰、分组。按人存，同一账号的各台设备共享 */
  prefs?: AccountPrefs;
  /**
   * 加入的群组的端到端密钥，已用本账号的主密钥包裹。
   * 服务端只是替各台设备保管 —— 主密钥从不离开设备，这些密文服务端解不开。
   */
  wrappedKeys?: Record<string, string>;
  /** 主密钥指纹（SHA-256 前 8 字节的十六进制）。设备据此判断手里的主密钥和账号对不对得上 */
  e2eFingerprint?: string;
  /** 屏蔽的群主。屏蔽即退出他的群，并拒收他之后的一切邀请 */
  blocked?: BlockEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface Folder {
  id: string;
  name: string;
}

/**
 * 个人偏好。和通道设置是两回事：通道设置（免打扰时段、去重）由创建者定、对所有人生效；
 * 这里的每一项只影响这个人自己 —— 群里有人把群设成免打扰，别人照常收。
 */
export interface AccountPrefs {
  /** 置顶的通道 id，按置顶先后 */
  pins?: string[];
  /** 免打扰：通道 id → 截止时刻（毫秒）；0 表示一直免打扰 */
  mutes?: Record<string, number>;
  /** 自定义分组，按显示顺序 */
  folders?: Folder[];
  /** 通道 id → 分组 id */
  folderOf?: Record<string, string>;
}

/**
 * 通道 = 一个推送入口。可以一个人独用，也可以是多人共享的群组。
 *
 * **id 和 key 刻意分开：**
 * - id  是公开的稳定标识：列表、导航、成员管理、历史分类都用它
 * - key 是推送凭据：拿到它就能往这个通道推消息，**只有创建者看得到**
 *
 * 不分开的话，历史分类只能拿 key 当标识，而推送 payload 会经由 APNs 落到
 * 每个成员的设备上 —— 等于把凭据发给了群里所有人，谁都能冒用这个地址。
 */
export interface Channel {
  id: string;
  key: string;
  name: string;
  icon?: string;
  /** 创建者。只有他能改名、改策略、换 key、邀请与移除成员、删除通道 */
  ownerId: string;
  /** 其余接收者。只接收，不能管理 */
  memberIds: string[];
  /** 这个通道的默认参数，推送时作为兜底 */
  defaults?: Partial<PushParams>;
  /** 免打扰时段、去重窗口。见 policy.ts */
  policy?: ChannelPolicy;
  createdAt: number;
  /** 累计推送条数，用来看哪个来源最吵 */
  count: number;
  lastPushAt?: number;
  /** 因违反使用条款被停用。停用后推送、邀请、认领一律拒绝；记录保留，以便复核申诉 */
  suspended?: { at: number; reason?: string };
}

/** key → 通道 id 的反查指针，推送热路径靠它定位 */
export interface KeyPointer {
  id: string;
}

/** 群组邀请。有效期内可重复使用，和群二维码一样 */
export interface Invite {
  code: string;
  channelId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

/** 认领记录：群组里谁接手了哪条消息 */
export interface AckRecord {
  accountId: string;
  name: string;
  at: number;
}

/** 屏蔽名单的一项。名字是屏蔽那一刻对方的显示名，只为了让人认得出是谁 */
export interface BlockEntry {
  id: string;
  name: string;
  at: number;
}

/**
 * 举报记录。90 天后由 KV 自动删除。
 *
 * 端到端加密的消息服务端看不到内容，excerpt 是举报人自己选择附上的那条消息的原文 ——
 * 这是推送内容会落盘的唯一情形，隐私政策里写明了。
 */
export interface Report {
  channelId: string;
  /** 通道名和群主记在这里：群被删了，举报仍然看得懂、复核得了 */
  channelName: string;
  ownerId: string;
  reporterId: string;
  /** 举报的是哪一条；举报整个群组时没有 */
  messageId?: string;
  /** REPORT_REASONS 里的键 */
  reason: string;
  detail?: string;
  excerpt?: string;
  at: number;
}

/** 一次推送可携带的全部参数。规范写法见 README 的参数表。 */
export interface PushParams {
  title?: string;
  subtitle?: string;
  body?: string;
  /** active | timeSensitive | passive | critical */
  level?: string;
  /** critical 级别的音量 0–10 */
  volume?: string;
  badge?: string;
  /** "1" = 重复响铃 30 秒 */
  call?: string;
  /** "1" = 自动复制 */
  autoCopy?: string;
  /** 点击时复制的内容 */
  copy?: string;
  sound?: string;
  /** 通知图标 URL（iOS 15+） */
  icon?: string;
  /** 通知分组，映射到 APNs thread-id */
  group?: string;
  /** 端到端加密后的密文 */
  ciphertext?: string;
  iv?: string;
  /** "1" = 存入 App 历史 */
  isArchive?: string;
  /** 历史保留秒数 */
  ttl?: string;
  /** 点击跳转的 URL */
  url?: string;
  image?: string;
  markdown?: string;
  /** "none" = 点击无动作 */
  action?: string;
  /** 幂等 id，同时作为 apns-collapse-id */
  id?: string;
  /** "1" = 静默推送，用于删除同 id 的历史消息 */
  delete?: string;
  /** 逗号分隔的标签。认得的表情短码（warning、rotating_light…）显示成表情，其余显示成标签 */
  tags?: string;
  /** 事件状态：firing（进行中）/ resolved（已恢复）。同一个 id 从进行中变成已恢复，App 会算出持续了多久 */
  status?: string;
}

/**
 * 网站监控。cron 每轮把到点的抓一遍，状态变了推给通道。
 * up：在线/掉线；keyword：某段文字在页面上出现或消失（抢票、降价、公告更新）。
 */
export interface Watch {
  id: string;
  /** 推给哪个通道；必须是 ownerId 自己创建的 */
  channelId: string;
  /** 创建者的账号 id */
  ownerId: string;
  kind: "up" | "keyword";
  url: string;
  keyword?: string;
  /** keyword：true=出现就提醒，false=消失就提醒 */
  present?: boolean;
  intervalMinutes: number;
  name: string;
  /** 上一次判定的状态：up/down 或 present/absent */
  lastStatus?: string;
  lastCheckedAt?: number;
  createdAt: number;
}

export interface PushResult {
  deviceToken: string;
  env: ApnsEnv;
  status: number;
  reason?: string;
}
