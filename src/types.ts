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
  /** 限流绑定（见 wrangler.toml）。本地测试和自建环境可能没有，缺了就不限流 —— 见 ratelimit.ts */
  RL_PUSH?: RateLimiter;
  RL_IP?: RateLimiter;
  RL_ACCOUNT?: RateLimiter;
  /**
   * 不是绑定：cron 数子请求用的计数器（见 db.ts meteredEnv），每次对外 fetch 调一下。
   * Workers 一次调用最多 1000 个子请求，KV 操作和 fetch 合在一起算。线上请求的 env 里没有它
   */
  countFetch?: () => void;
}

/** Workers 限流绑定的最小接口 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
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
  /** 第一次同意使用条款的时刻（毫秒）。建群、设为群组、生成邀请之前 App 会请人确认一次 */
  termsAcceptedAt?: number;
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
  /** 通道 id → 铃声文件名。只同步「选了哪个」，铃声文件本身不上传 */
  sounds?: Record<string, string>;
  /** 默认铃声文件名。没有单独设置铃声的通道都用它；留空表示跟随系统 */
  defaultSound?: string;
  /**
   * 备注名：通道 id → 只有自己看得到的名字。群名只有创建者能改（改了所有人都变），
   * 成员想按自己的叫法认群，就在这里记，同一账号的各台设备同步
   */
  aliases?: Record<string, string>;
  /**
   * 图片开关：通道 id → 要不要加载发送方给的图片和图标（true = 加载）。开着时设备会直接访问
   * 发送方给的地址，对方由此能看到你的 IP、知道消息什么时候送到。没有条目时，自己建的通道算开、加入的群算关
   */
  images?: Record<string, boolean>;
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
  /**
   * 累计推送条数，用来看哪个来源最吵。推送热路径已经不写这里了：这两个字段停在改动那一刻，
   * 之后的记在 stat:{id}，显示时两者相加（见 db.ts pushStatOf）
   */
  count: number;
  lastPushAt?: number;
  /**
   * 因违反使用条款被停用。停用后推送、邀请、认领一律拒绝；记录保留，以便复核申诉。
   * 现在存在 susp:{id}，getChannel 读通道时合进来；旧数据里直接写在通道记录上的照样认
   */
  suspended?: { at: number; reason?: string };
  /**
   * 建的时候就说了是群组。还没人加入时成员只有创建者一个，光看人数它不算群 ——
   * App 的群组页上就找不到刚建好的群。普通通道邀请了人照样算群（看人数），这个标记只补「刚建、还没人」那段
   */
  group?: boolean;
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
  /** "1" = 撤回同 id 的消息：通知换成「此消息已撤回」，App 历史里删掉。必须带 id */
  delete?: string;
  /** 逗号分隔的标签。认得的表情短码（warning、rotating_light…）显示成表情，其余显示成标签 */
  tags?: string;
  /** 事件状态：firing（进行中）/ resolved（已恢复）。同一个 id 从进行中变成已恢复，App 会算出持续了多久 */
  status?: string;
  /** 重复提醒的间隔分钟数（5–60）："1" / "true" / "yes" 表示 5。一直提醒到有人点「知道了」、消息恢复，或满一小时 */
  repeat?: string;
  /**
   * 监控告警专用，不是推送参数（PARAM_KEYS 里没有，发送方给不了）：payload 里的 watch_id，App 凭它打开监控详情。
   * 网址监控是监控 id；心跳是由 id 推出来的引用（id 本身就是报到凭据，见 watch.ts watchRef）
   */
  watchId?: string;
}

/**
 * 一条待补发的重复提醒，存在 `repeat:{通道 id}:{消息 id}`。cron 到点把 params 原样再推一次。
 * 这是推送内容落盘的第二种情形（第一种是举报附上的原文），最长约 70 分钟，隐私政策里写明了。
 */
export interface RepeatRecord {
  channelId: string;
  messageId: string;
  /** 原消息的推送参数，id 和 repeat 已经定下。端到端加密的消息这里只有密文 */
  params: PushParams;
  /** 间隔分钟数 */
  every: number;
  /** 下一次提醒的时刻（毫秒） */
  nextAt: number;
  /** 提醒的截止时刻（毫秒）：原消息之后一小时 */
  until: number;
  /** 已经推过几次，含原消息 */
  count: number;
  /** 原消息的发出时刻（毫秒），补发沿用。旧记录没有，按 until 倒推 */
  sentAt?: number;
  /** 原消息为了塞进 4KB 被截短过。params 已是截短后的，补发时照样标上 */
  truncated?: boolean;
  /** 通道创建者。提醒结束时凭它找到占位（见 push.ts 的 rptslot:）一并删掉；旧记录没有，也没有占位 */
  ownerId?: string;
}

/**
 * 监控。up / keyword 由 cron 每轮把到点的网址抓一遍，状态变了推给通道：
 * up：在线/掉线；keyword：某段文字在页面上出现或消失（抢票、降价、公告更新）。
 * heartbeat 反过来：服务器不去抓谁，等定时任务自己来报到，过了点没来才提醒。
 */
export interface Watch {
  id: string;
  /** 推给哪个通道；必须是 ownerId 自己创建的 */
  channelId: string;
  /** 创建者的账号 id */
  ownerId: string;
  kind: "up" | "keyword" | "heartbeat";
  /** 要抓的网址。heartbeat 没有 */
  url?: string;
  keyword?: string;
  /** keyword：true=出现就提醒，false=消失就提醒 */
  present?: boolean;
  /** up / keyword：多久抓一次；heartbeat：任务预期多久报到一次 */
  intervalMinutes: number;
  /** heartbeat：过了预期的时刻再等多久才算失联 */
  graceMinutes?: number;
  name: string;
  /**
   * 提醒强度：告警（掉线、失联、报告失败、关键词命中）用这个级别。没设就用告警自带的（timeSensitive）。
   * 「恢复」不受它影响 —— 好消息不必比平常更吵
   */
  level?: "active" | "timeSensitive";
  /** 告警的重复提醒间隔（分钟，5–60），规则同推送参数 repeat。没设就看通道默认值 */
  repeat?: number;
  /** 上一次判定的状态：up/down、present/absent；heartbeat 是 new（还没报到过）/ up / down */
  lastStatus?: string;
  lastCheckedAt?: number;
  /** heartbeat：最近一次报到的时刻，成功失败都算。为了省 KV 写入，可能比实际旧几分钟（见 watch.ts） */
  lastPingAt?: number;
  /** up / keyword：连续检查失败了几次（掉线、抓取出错都算），成功一次就清零。up 连续 2 次才算掉线 */
  failCount?: number;
  /** up / keyword：连续几次等不到回应（超时）。从第 2 次起检查间隔翻倍，满 8 次暂停常规检查 */
  timeoutCount?: number;
  /** 暂停常规检查的时刻：连续超时太多次，改成每天试一次，有回应了自动恢复 */
  pausedAt?: number;
  /** 最近一次检查失败的说明（超时、HTTP 403（可能被目标站拦截）、无法判定……）；检查成功时没有 */
  lastDetail?: string;
  /** 告警没推出去（APNs 出错、一台设备都没送到），已经试了几轮。状态先不改，下一轮重推，满 3 轮放弃 */
  pendingAlertAttempts?: number;
  createdAt: number;
  // ── 以下是监控管理（编辑、暂停、维护窗口、历史）加的，全部可选：老数据没有，按没设处理 ──
  /** 配置最近一次被编辑的时刻。同一把键每秒只能写一次，连着两次编辑要错开 */
  updatedAt?: number;
  /**
   * 用户手动暂停：暂停到这一刻（毫秒）；0 = 一直暂停到手动恢复。暂停期间网址不抓、心跳不判失联、什么都不推。
   * 恢复时记成恢复的那一刻 —— 过去的时刻就是「没在暂停」，同时是心跳重新计时的起点
   */
  pausedUntil?: number;
  /** 每周的维护窗口：窗口里照常检查、照常记录，只是不推告警（见 watchquiet.ts） */
  maintenance?: MaintenanceWindow;
  /** 状态：暂停或维护期间压下了告警（见 watchquiet.ts gate）。结束时和压下之前比，还不对劲才补推 */
  quiet?: WatchQuiet;
  /** 状态，心跳：最近一次 /hb/{id}/start 的时刻。晚于最近一次报到才算「在跑」，下一次报到据此算出用时 */
  startedAt?: number;
  /** 状态：最近 20 次状态变化、24 小时的每次检查、30 天按小时的正常 / 异常时长（见 watchhistory.ts） */
  history?: WatchHistory;
}

/** 每周维护窗口。days 是窗口开始的那几天（1 = 周一 … 7 = 周日）；end 不晚于 start 时跨到第二天 */
export interface MaintenanceWindow {
  days: number[];
  /** "03:00" */
  start: string;
  /** "04:00" */
  end: string;
  /** IANA 时区名，如 "Asia/Shanghai"：存名字不存偏移量，夏令时变了也不跑偏 */
  tz: string;
}

/** 安静期（暂停、维护窗口）里压下的告警 */
export interface WatchQuiet {
  /** 压下第一条告警之前的状态 —— 用户最后知道的样子。"" 表示那时还没有状态 */
  from: string;
  /** 安静期到什么时候结束（毫秒）。0 = 没有确定的结束（一直暂停） */
  until: number;
  /** pause：手动暂停；maint：维护窗口 */
  why: "pause" | "maint";
}

/** 监控的历史，跟状态存在同一把键的值里（不进 metadata），和状态一起写，不多花一次写入 */
export interface WatchHistory {
  /** 最近 20 次状态变化，旧的在前 */
  changes: WatchChange[];
  /** 最近 24 小时的每次检查（心跳是每次记下的报到）：[时刻（秒）, 响应或运行毫秒数（-1 = 没有）, 1 正常 / 0 异常] */
  checks: [number, number, 0 | 1][];
  /** 最近 30 天按小时的正常、异常秒数：up[i] / down[i] 是第 start + i 个小时（Unix 毫秒 ÷ 3600000） */
  hours: { start: number; up: number[]; down: number[] };
  /** 从 since 起到下一次记录，这段时间算哪一类：1 正常、0 异常、-1 不计（暂停、维护期间的异常、心跳还没接上） */
  cur: 1 | 0 | -1;
  since: number;
}

export interface WatchChange {
  at: number;
  status: string;
  /** HTTP 503、5 秒内没有回应、退出码 2、没有按时上报……不存任务附的说明（那是推送内容） */
  detail?: string;
  /** 暂停或维护期间发生，没有推告警 */
  quiet?: 1;
}

export interface PushResult {
  deviceToken: string;
  env: ApnsEnv;
  status: number;
  reason?: string;
}
