/**
 * tianshu-imbridge — 天枢 IM 插件（QQ 渠道）· W5（桌面端原生会话）
 *
 * 目标：手机 QQ 消息直接进入天枢、天枢回复直接回到 QQ，中间不经 DSH；
 * 且每个 QQ 对话线以「桌面端原生会话」形式可见（模仿 dsh-im 的会话绑定做法）。
 *
 * 骨架纪律（来自 2026-09-24 常驻探针实测 + 官方 design 插件提示）：
 * 1. 入口顶层保持轻量：顶层 import 链失败会让整个插件被天枢静默跳过。
 *    重依赖（QQ SDK / 桥接层 / serve 客户端）一律在真正用到时 lazy-import。
 * 2. 顶层常驻逻辑每进程只执行一次（探针实测：serve 与 headless 两种入口均恰好 1 次）。
 * 3. 插件跑在天枢进程内：一切异步自兜异常，任何失败都不能拖垮天枢本体。
 * 4. 不硬编码个人路径；凭据走配置/环境变量，永不入源码与日志。
 *
 * W5 模式：
 * - serve-native：插件运行在 serve 进程内（可读 token/port）→ 用桌面端原生会话
 *   （首条消息建会话、后续 prompt 同一会话；回复经事件流收集）
 * - headless：非 serve 环境降级（每会话独立 cwd + 客户端历史注入）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeSessionMap } from './lib/session-map.mjs'
import { join } from 'node:path'

const PLUGIN_NAME = 'tianshu-imbridge'
const VERSION = '0.6.0'
const TIANSHU_TIMEOUT_MS = 180_000

// ── 运行状态：im_status 工具与后续模块共享 ──────────────────────
const state = {
  phase: 'native-session', // skeleton → qq-connect → bridge → native-session → stable
  startedAt: new Date().toISOString(),
  configSource: null,      // QQ 侧（兼容旧字段）
  configFile: null,
  maskedAppId: null,
  maskedWeixinToken: null, // 微信侧
  weixinConfigFile: null,
  weixinConfigError: null,
  lastInboundAt: null,
  lastInboundSender: null,
  inboundCount: 0,
  lastError: null,
}

// ── 日志器：统一前缀，走 stderr（天枢 sidecar 日志可见）──────────
const logger = {
  info: (...args) => console.error(`[${PLUGIN_NAME}]`, ...args),
  warn: (...args) => console.error(`[${PLUGIN_NAME}:warn]`, ...args),
  error: (...args) => console.error(`[${PLUGIN_NAME}:error]`, ...args),
}

// ── 通道配置（两份独立读；任一通道没配就是没启用，不是错误）────
let qqConfig = null
let weixinConfig = null

// ── 多通道连接管理（懒加载；失败兜住，不影响插件本体）──────────
// Map<通道名, { connection, channel }>；QQ 与微信各一条，互不干扰。
const connections = new Map()
const connectionInits = new Map()

/** 把一条连接包装成「连接器 + 通道身份」，供桥的出站路由认领。 */
function makeChannelConnector(connection, channel) {
  return {
    connection,
    channel,
    sendText: (target, text) => connection.sendText(target, text),
    sendTyping: (target, seconds) => connection.sendTyping?.(target, seconds),
    get status() {
      return connection?.status ?? null
    },
  }
}

/** 桥的出站回调按通道挑选连接器：空的 send 回调曾让 QQ 回复全部失败。 */
function pickConnector(target, preferred = 'qq') {
  const wanted = target && typeof target === 'object' && typeof target.channel === 'string'
    ? target.channel
    : preferred
  const hit = connections.get(wanted)
  if (hit) return hit
  return connections.get(preferred) ?? null
}

async function ensureConnected(channel) {
  if (connections.has(channel)) return connections.get(channel)
  const pending = connectionInits.get(channel)
  if (pending) return pending
  const run = (async () => {
    try {
      if (channel === 'weixin') {
        if (!weixinConfig?.configured) {
          logger.info('微信未配置：把 weixin.json 放进数据目录，或设置 TIANSHU_IM_WEIXIN_TOKEN')
          return null
        }
        if (!weixinConfig.enabled) {
          logger.info('微信连接在配置中被禁用（enabled=false）')
          return null
        }
        if (!weixinConfig.ownerUserId) {
          // 安全默认：未配置 owner = 全部拒收（见 lib/weixin/authorization.mjs）
          logger.warn(
            '未配置微信 ownerUserId：安全默认为「全部拒收」，任何微信消息都不会被响应。'
            + `请在该文件的 ownerUserId 字段填入您的 user_id 后重启天枢：${weixinConfig.configFile}`,
          )
        }
        const { WeixinConnection } = await import('./lib/weixin/connection.mjs')
        const connection = new WeixinConnection({
          config: weixinConfig,
          logger,
          dataDir: weixinConfig.dataDir,
          onMessage: (message) => handleInbound(message, 'weixin'),
        })
        const connector = makeChannelConnector(connection, 'weixin')
        connections.set('weixin', connector)
        connection.start()
        logger.info(`微信连接启动中（token=${state.maskedWeixinToken}，来源=${weixinConfig.source}）`)
        return connector
      }

      // 默认通道：QQ
      if (!qqConfig?.configured) {
        logger.info('QQ 未配置：将 config.json 放入数据目录，或设置 TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET')
        return null
      }
      if (!qqConfig.enabled) {
        logger.info('QQ 连接在配置中被禁用（enabled=false）')
        return null
      }
      if (!qqConfig.ownerUserOpenid) {
        logger.warn(
          '未配置 ownerUserOpenid：安全默认为「全部拒收」，任何 QQ 消息都不会被响应。'
          + `请在该文件的 ownerUserOpenid 字段填入您的 openid 后重启天枢：${qqConfig.configFile}`,
        )
      }
      const { QqConnection } = await import('./lib/qq/connection.mjs')
      const connection = new QqConnection({
        config: qqConfig,
        logger,
        dataDir: qqConfig.dataDir,
        onMessage: (message) => handleInbound(message, 'qq'),
      })
      const connector = makeChannelConnector(connection, 'qq')
      connections.set('qq', connector)
      connection.start()
      logger.info(`QQ 连接启动中（appId=${state.maskedAppId}，来源=${qqConfig.source}）`)
      return connector
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      logger.error(`${channel} 连接初始化失败:`, state.lastError)
      return null
    } finally {
      connectionInits.delete(channel)
    }
  })()
  connectionInits.set(channel, run)
  return run
}

/** 老入口名保留（QQ 时代就这么叫，测试与后续代码都可能引用）。 */
function ensureConnection() {
  return ensureConnected('qq')
}

// ── 消息桥（懒加载；W5 双模式）───────────────────────────────────
let bridge = null
let bridgeInit = null

/**
 * 并发首条消息只建一次桥（与 ensureConnection 同一手法）。
 * 建两次会得到两个 HistoryStore 写同一个 history.json，headless 路径下可能丢历史。
 */
async function buildBridge() {
  if (bridge) return bridge
  bridgeInit ??= buildBridgeOnce().finally(() => {
    if (!bridge) bridgeInit = null // 建失败 → 下一条消息可重试
  })
  return bridgeInit
}

async function buildBridgeOnce() {
  const { ImBridge } = await import('./lib/bridge.mjs')
  const { buildInvocation, callTianshu, resolveRuntimeDir } = await import('./lib/tianshu.mjs')
  const { HistoryStore } = await import('./lib/history.mjs')
  const { createServeClientIfAvailable } = await import('./lib/serve-client.mjs')
  const { createCommandHandlers, dispatchCommand } = await import('./lib/command-handlers.mjs')
  const runtimeDir = resolveRuntimeDir()
  const homeDir = process.env.RIVET_HOME?.trim()
  if (!homeDir) throw new Error('RIVET_HOME 未设置，无法定位天枢数据目录')
  const nodePath = process.execPath
  // 数据目录与工作区覆盖取「第一个已启用的通道」：桥是单例（会话历史与绑定只有一份），
  // 让两个通道共用它，会话标识里已经带了通道前缀（c2c:/group:），不会串号。
  const primary = (weixinConfig?.configured && weixinConfig.enabled ? weixinConfig : null)
    ?? (qqConfig?.configured && qqConfig.enabled ? qqConfig : null)
  const dataDir = primary?.dataDir ?? qqConfig?.dataDir ?? weixinConfig?.dataDir
  if (!dataDir) throw new Error('没有可用通道的数据目录（QQ 与微信都未配置）')
  const workspaceOverride = qqConfig?.workspace ?? weixinConfig?.workspace ?? null
  const workspaceRoot = join(dataDir, 'workspace')
  const historyStore = new HistoryStore({ file: join(dataDir, 'history.json') })
  const sessionMap = makeSessionMap(join(dataDir, 'session-map.json'))
  const { makeCommandHints } = await import('./lib/command-hints.mjs')
  const commandHints = makeCommandHints(join(dataDir, 'command-hints.json'))

  // serve 原生会话通道：仅当插件运行在 serve 进程内时可用（token + --port 可探）
  const serveClient = createServeClientIfAvailable()

  // 命令层：以 / 开头且形状合法的消息走这里，不送模型
  const commandHandlers = createCommandHandlers({
    workspace: workspaceOverride,
    serveClient,
    sessionMap,
  })

  bridge = new ImBridge({
    workspaceRoot,
    workspaceOverride,
    logger,
    ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
    historyStore,
    serveClient,
    sessionMap,
    commandHints,
    onCommand: (ctx) => dispatchCommand(ctx, commandHandlers),
    call: async ({ cwd, prompt }) => {
      const invocation = buildInvocation({
        runtimeDir, nodePath, homeDir, cwd, prompt,
      })
      return callTianshu(invocation, { timeoutMs: TIANSHU_TIMEOUT_MS })
    },
    send: async (target, text) => {
      // 按目标自带的通道标签回信；缺标签时按「谁先配置认谁」兜底。
      // 桥把 target 当作不透明句柄，通道身份由连接层写进去、这里认领。
      const connector = pickConnector(target, connections.has('qq') ? 'qq' : 'weixin')
      if (!connector) throw new Error('没有可用的通道连接（QQ 与微信都未就绪）')
      return connector.sendText(target, text)
    },
  })
  logger.info(
    `消息桥就绪（模式=${bridge.mode}，工作区=${workspaceOverride ?? workspaceRoot}`
    + `${serveClient ? `，serve=${serveClient.baseUrl}` : ''}）`,
  )
  return bridge
}

/** 入站消息：日志 + 交给桥（异步；同会话由桥内部串行）。 */
function handleInbound(message, channel = 'qq') {
  state.inboundCount += 1
  state.lastInboundAt = new Date().toISOString()
  if (typeof message?.senderId === 'string' && message.senderId) {
    state.lastInboundSender = message.senderId
  }
  const kind = message?.kind ?? 'unknown'
  const from = typeof message?.senderId === 'string' ? `${message.senderId.slice(0, 10)}…` : '?'
  const preview = typeof message?.content === 'string' ? message.content.replace(/\s+/g, ' ').slice(0, 80) : ''
  logger.info(`📨 收到消息 [${channel}/${kind}] 来自 ${from}: "${preview}"`)

  // 连接层已在自己的循环里报错并重试；这一层只管把消息送进桥，异常自兜。
  void (async () => {
    try {
      const b = await buildBridge()
      await b.handle(message)
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      logger.error('消息处理失败:', state.lastError)
      try {
        await pickConnector(message?.replyTarget, channel)
          ?.sendText?.(message?.replyTarget, `（内部错误：${state.lastError}）`)
      } catch { /* 尽力而为 */ }
    }
  })()
}

// ── 顶层常驻区：按配置决定起哪几条通道 ─────────────────────────
// （探针实测：本区域每进程只执行一次；连接句柄随进程生命周期存续）
void (async () => {
  try {
    const { loadQqConfig, maskAppId } = await import('./lib/qq/config.mjs')
    const { loadWeixinConfig, maskToken } = await import('./lib/weixin/config.mjs')
    qqConfig = loadQqConfig()
    weixinConfig = loadWeixinConfig()
    state.configSource = qqConfig.source
    state.configFile = qqConfig.configFile
    state.maskedAppId = maskAppId(qqConfig.appId)
    state.weixinConfigFile = weixinConfig.configFile
    state.maskedWeixinToken = maskToken(weixinConfig.botToken)
    state.weixinConfigError = weixinConfig.configError
    if (qqConfig.configError) logger.warn(qqConfig.configError)
    if (weixinConfig.configError) logger.warn(weixinConfig.configError)
  } catch (error) {
    logger.error('通道配置读取失败:', error?.message ?? error)
    return
  }
  // 两条通道各自的失败互不牵连（互不 await）
  if (qqConfig.configured) void ensureConnected('qq')
  if (weixinConfig.configured) void ensureConnected('weixin')
})().catch((error) => {
  logger.error('顶层初始化异常:', error?.message ?? error)
})

// ── 微信绑定协助（agent 在天枢会话里配置通道的落点）──────────────
// 服务端要的二维码只有微信能给，而扫码要等主人拿手机——所以工具**立刻返回**
// （把二维码与步骤交回对话），真正的等待与收尾交给一个后台进程：
// 它跑的是 lib/weixin/binder-cli.mjs，与命令行工具共用同一份核心。

/** 绑定请求文件（后台进程从它读参数；用文件而不是命令行，避免参数进进程列表）。 */
function bindRequestFile(dataDir) {
  return join(dataDir, 'weixin-bind-request.json')
}

/** 绑定状态文件（对话侧读它判断进展）。 */
function bindStatusFile(dataDir) {
  return join(dataDir, 'weixin-bind-status.json')
}

/**
 * 派生后台绑定进程；返回启动结果，不等待它结束。
 * 二维码落桌面这件事由 binder 负责（含桌面不可用时的回退与如实交代）。
 */
async function spawnBinderProcess(config) {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binderCli = fileURLToPath(new URL('./lib/weixin/binder-cli.mjs', import.meta.url))
  const requestFile = bindRequestFile(config.dataDir)
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(requestFile, `${JSON.stringify({
    configFile: config.configFile ?? join(config.dataDir, 'weixin.json'),
    dataDir: config.dataDir,
    baseUrl: config.baseUrl,
    statusFile: bindStatusFile(config.dataDir),
    timeoutMs: 300_000,
    qrFileName: '天枢-微信扫码.png',
  }, null, 2)}\n`)
  // detached + stdio ignore：这轮对话结束也不影响它；
  // 用 process.execPath 而不是写死 node 路径（红线 5：不硬编码个人路径）。
  const child = spawn(process.execPath, [binderCli, requestFile], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: config.dataDir,
  })
  child.unref()
  return { pid: child.pid ?? null }
}

// ── 工具 ─────────────────────────────────────────────────────
export const tools = [
  {
    definition: {
      name: 'im_status',
      description: 'Report tianshu-imbridge status: phase, mode (serve-native/headless), enabled channels (QQ / WeChat), session map, inbound/reply stats',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      let serveAvailable = false
      try {
        const { probeServerEnv } = await import('./lib/serve-client.mjs')
        serveAvailable = probeServerEnv().available
      } catch { /* ignore */ }
      // 会话绑定数：读落盘事实（与桥共用同一按路径缓存），桥未建时也能如实报告
      let sessionMapSize = 0
      try {
        const { pluginDataDir } = await import('./lib/data-dir.mjs')
        sessionMapSize = makeSessionMap(join(pluginDataDir(process.env), 'session-map.json')).size()
      } catch (error) {
        logger.warn('im_status: 会话绑定表读取失败:', error?.message ?? error)
      }
      const qq = connections.get('qq')
      const weixin = connections.get('weixin')
      // 绑定进展也一并上报：agent 排障时要能看出「是不是卡在扫码那一步」
      let weixinBind = null
      try {
        const { readBindStatus } = await import('./lib/weixin/binder.mjs')
        const dataDir = weixinConfig?.dataDir ?? qqConfig?.dataDir
        if (dataDir) weixinBind = readBindStatus(bindStatusFile(dataDir))
      } catch (error) {
        logger.warn('im_status: 绑定状态读取失败:', error?.message ?? error)
      }
      return {
        content: JSON.stringify(
          {
            plugin: PLUGIN_NAME,
            version: VERSION,
            phase: state.phase,
            mode: bridge?.mode ?? 'not-started',
            serveAvailable,
            // 两条通道各自上报：连接对象在时以它的状态机为准
            channels: {
              qq: {
                configured: Boolean(qqConfig?.configured),
                enabled: qqConfig?.enabled ?? null,
                connection: qq?.status?.state ?? 'not-started',
                detail: qq?.status ?? null,
                maskedAppId: state.maskedAppId,
                source: state.configSource,
                configFile: state.configFile,
              },
              weixin: {
                configured: Boolean(weixinConfig?.configured),
                enabled: weixinConfig?.enabled ?? null,
                connection: weixin?.status?.state ?? 'not-started',
                detail: weixin?.status ?? null,
                maskedToken: state.maskedWeixinToken,
                source: weixinConfig?.source ?? null,
                configFile: state.weixinConfigFile,
                configError: state.weixinConfigError,
                bind: weixinBind
                  ? {
                    state: weixinBind.state,
                    step: weixinBind.step,
                    qrPath: weixinBind.qrPath,
                    ownerFilled: weixinBind.ownerFilled,
                    updatedAt: weixinBind.updatedAt,
                  }
                  : null,
              },
            },
            // 兼容旧字段（QQ 视角），避免既有排障习惯被打断
            connection: qq?.status?.state ?? 'not-started',
            bridgeStats: bridge?.stats ?? null,
            sessionMapSize,
            security: {
              qqOwnerConfigured: Boolean(qqConfig?.ownerUserOpenid),
              weixinOwnerConfigured: Boolean(weixinConfig?.ownerUserId),
              inboundPolicy: 'owner-only（两条通道各自判定，未配置 owner 即全部拒收）',
              blockedCount: (qq?.status?.filteredCount ?? 0) + (weixin?.status?.filteredCount ?? 0),
            },
            inboundCount: state.inboundCount,
            lastInboundAt: state.lastInboundAt,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            startedAt: state.startedAt,
            lastError: state.lastError,
          },
          null,
          2,
        ),
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'im_send',
      description: 'Send a proactive message to the owner (notification) over QQ or WeChat. Defaults to the configured owner / last inbound sender of the chosen channel.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
          targetId: { type: 'string', description: 'Optional openid/user_id; defaults to owner/last sender' },
          channel: { type: 'string', description: "Which channel to use: 'qq' or 'weixin' (defaults to the first ready one)" },
        },
        required: ['text'],
      },
    },
    execute: async (params) => {
      const text = typeof params?.text === 'string' ? params.text.trim() : ''
      if (!text) return { content: 'im_send 需要 text 参数', isError: true }
      const wanted = typeof params?.channel === 'string' ? params.channel.trim().toLowerCase() : ''
      const channel = wanted === 'qq' || wanted === 'weixin'
        ? wanted
        : (connections.has('qq') ? 'qq' : (connections.has('weixin') ? 'weixin' : 'qq'))
      const connector = connections.get(channel)
      if (!connector) return { content: `通道未就绪：${channel}（先确认配置并重启天枢）`, isError: true }
      const owned = channel === 'qq' ? qqConfig?.ownerUserOpenid : weixinConfig?.ownerUserId
      const targetId = (typeof params?.targetId === 'string' ? params.targetId.trim() : '')
        || owned
        || state.lastInboundSender
      if (!targetId) {
        return { content: `无发送目标：请配置 ${channel === 'qq' ? 'ownerUserOpenid' : 'ownerUserId'}，或先收到一条消息`, isError: true }
      }
      try {
        // 无 msgId → 主动消息（受平台额度限制，适合低频通知）
        await connector.sendText({ scope: 'c2c', targetId, channel }, text)
        return { content: `已发送（${channel} → ${String(targetId).slice(0, 8)}…，${text.length} 字）` }
      } catch (error) {
        return { content: `发送失败（${channel}）：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'weixin_bind_start',
      description: 'Start WeChat (iLink/ClawBot) binding: generates a QR code image onto the user\'s Desktop and waits in the background for the scan. Returns immediately with the image path and the steps the user must do. Call weixin_bind_status to check the result.',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      try {
        const { loadWeixinConfig } = await import('./lib/weixin/config.mjs')
        const { readBindStatus, DEFAULT_BIND_TIMEOUT_MS } = await import('./lib/weixin/binder.mjs')
        const config = loadWeixinConfig()
        const current = readBindStatus(bindStatusFile(config.dataDir))
        if (current.state === 'running' && current.updatedAt) {
          const ageMs = Date.now() - Date.parse(current.updatedAt)
          if (Number.isFinite(ageMs) && ageMs < DEFAULT_BIND_TIMEOUT_MS) {
            return { content: JSON.stringify({
              alreadyRunning: true,
              qrPath: current.qrPath,
              step: current.step,
              hint: '绑定已经在进行中：直接用那张二维码，扫完让我查进展即可。',
            }, null, 2) }
          }
        }
        const { pid } = await spawnBinderProcess(config)
        // 给后台进程一点时间把二维码落到桌面，这样首次返回就能带上图片路径
        await new Promise((resolve) => { const t = setTimeout(resolve, 2_000); t.unref?.() })
        const after = readBindStatus(bindStatusFile(config.dataDir))
        return { content: JSON.stringify({
          started: true,
          pid,
          dataDir: config.dataDir,
          configFile: config.configFile,
          qrPath: after.qrPath,
          qrOnDesktop: after.qrOnDesktop,
          qrNote: after.qrNote,
          step: after.step,
          steps: [
            after.qrPath
              ? `打开桌面上的二维码图片（${after.qrPath}），用手机微信「扫一扫」`
              : '等几秒后让我再查一次，二维码就绪了会给出图片位置',
            '微信里若有提示（例如要验证码），把内容告诉我',
            '扫完后对我说一声，我查绑定结果',
          ],
        }, null, 2) }
      } catch (error) {
        return { content: `启动微信绑定失败：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'weixin_bind_status',
      description: 'Check the WeChat binding progress: whether the QR was scanned, whether credentials were saved, and what to do next (usually: restart Tianshu).',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      try {
        const { loadWeixinConfig, maskToken } = await import('./lib/weixin/config.mjs')
        const { readBindStatus } = await import('./lib/weixin/binder.mjs')
        const config = loadWeixinConfig()
        const status = readBindStatus(bindStatusFile(config.dataDir))
        const live = loadWeixinConfig()
        const next = status.state === 'success'
          ? '凭据已就绪。请**重启天枢**（插件在启动时加载），重启后给这个微信发条消息即可验证。'
          : (status.state === 'running'
            ? '还在等扫码。二维码在桌面（或状态里的 qrPath），扫完再让我查一次。'
            : (status.state === 'need-verifycode'
              ? '服务端要验证码：把手机微信里显示的那串数字告诉我，我带着它重试。'
              : '没有正在进行的绑定。要接入微信的话，让我启动一次绑定。'))
        return { content: JSON.stringify({
          state: status.state,
          step: status.step,
          qrPath: status.qrPath,
          qrOnDesktop: status.qrOnDesktop,
          qrNote: status.qrNote,
          qrUrl: status.qrUrl,
          botId: status.botId,
          userId: status.userId,
          ownerFilled: status.ownerFilled,
          reason: status.reason,
          message: status.message,
          updatedAt: status.updatedAt,
          channelConfigured: Boolean(live.configured),
          maskedToken: maskToken(live.botToken),
          next,
        }, null, 2) }
      } catch (error) {
        return { content: `查绑定状态失败：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
