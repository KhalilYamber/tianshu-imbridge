/**
 * 消息桥：QQ 消息 → 天枢 → 回复 QQ。双模式（W5 改造）：
 *
 * ① serve 原生会话模式（优先）：当插件运行在 serve 进程内（可拿到 token+端口），
 *    每个 QQ 对话线绑定一个「桌面端原生会话」——首条消息创建会话（桌面端列表可见）、
 *    后续消息走该会话的 prompt，回复经事件流（text_delta + turn_complete）收集。
 *    行为与 dsh-im 的会话绑定同构：一条对话线 = 一个持久会话。
 * ② headless 降级模式：非 serve 环境（TUI/独立运行）沿用 headless 调用
 *    （每会话独立 cwd + 客户端历史注入；见 history.mjs / tianshu.mjs）。
 *
 * 依赖全部注入，便于测试：
 * - call / historyStore：headless 路径
 * - serveClient / sessionMap：serve 路径
 * - send / ensureDir：公共
 * - onCommand：命令层（`/` 开头且形状合法的消息交给它，不送模型、不动绑定）
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { formatPrompt } from './history.mjs'
import { firstUseHint, parseCommand } from './command.mjs'
import { planReply } from './reply.mjs'

/** 会话标识：私聊=c2c:<senderId>；群=group:<groupOpenid>（dsh-im 同款口径）。 */
export function conversationKey(message) {
  if (message?.kind === 'group') {
    return `group:${message?.groupOpenid ?? message?.senderId ?? 'unknown'}`
  }
  return `c2c:${message?.senderId ?? 'unknown'}`
}

/** 会话键 → 文件系统安全的稳定目录名（headless 模式的隔离目录用）。 */
export function conversationDirName(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

/** 由首条消息生成会话标题（桌面端列表可读）。 */
export function sessionTitleFor(content) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim()
  return flat ? `QQ: ${flat.slice(0, 30)}` : 'QQ 对话'
}

/** 按 key 串行的轻量任务队列（前序失败不阻塞后续）。 */
export class MessageQueue {
  #chains = new Map()

  run(key, task) {
    const prev = this.#chains.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    // 存"吞错版"防止链断；返回原文给调用方感知失败。
    this.#chains.set(key, next.then(() => undefined, () => undefined))
    return next
  }
}

export class ImBridge {
  #workspaceRoot
  #workspaceOverride
  #logger
  #call
  #send
  #ensureDir
  #historyStore
  #serveClient
  #sessionMap
  #onCommand
  #commandHints
  #queue = new MessageQueue()
  // 命令口径与模型回复口径分开记账，互不串账（replies=模型回复，commandReplies=命令回执）
  #stats = {
    handled: 0,
    failed: 0,
    replies: 0,
    serveSessionsCreated: 0,
    commands: 0,
    commandReplies: 0,
    commandsFailed: 0,
  }

  constructor({
    workspaceRoot,
    workspaceOverride,
    logger,
    call,
    send,
    ensureDir,
    historyStore,
    serveClient,
    sessionMap,
    onCommand,
    commandHints,
  }) {
    if (!workspaceRoot) throw new TypeError('ImBridge 需要 workspaceRoot')
    if (typeof call !== 'function') throw new TypeError('ImBridge 需要 call 注入')
    if (typeof send !== 'function') throw new TypeError('ImBridge 需要 send 注入')
    this.#workspaceRoot = workspaceRoot
    this.#workspaceOverride = typeof workspaceOverride === 'string' && workspaceOverride.trim()
      ? workspaceOverride.trim()
      : null
    this.#logger = logger ?? {}
    this.#call = call
    this.#send = send
    this.#ensureDir = ensureDir ?? (() => {})
    this.#historyStore = historyStore ?? null
    this.#serveClient = serveClient ?? null
    this.#sessionMap = sessionMap ?? null
    this.#onCommand = typeof onCommand === 'function' ? onCommand : null
    this.#commandHints = commandHints ?? null
  }

  get stats() {
    return { ...this.#stats }
  }

  /** 当前模式：serve-native（桌面端原生会话）或 headless（降级）。 */
  get mode() {
    return this.#serveClient?.available ? 'serve-native' : 'headless'
  }

  /** 处理一条入站消息（同会话串行）。 */
  async handle(message) {
    const content = typeof message?.content === 'string' ? message.content.trim() : ''
    const target = message?.replyTarget
    if (!content || !target) return undefined

    const key = conversationKey(message)
    this.#stats.handled += 1

    return this.#queue.run(key, async () => {
      try {
        // 命令层接缝：命令形状的消息交给注入的处理器，不送模型、不动绑定。
        // `text` 类零改动走原路径；命令层未接线时命令暂时按普通消息处理（留一行警告，不静默）。
        const parsed = parseCommand(content)
        // 显式两态：将来 parseCommand 若新增 kind，必须在此被有意接纳，不得默默进命令层
        if (parsed.kind === 'command' || parsed.kind === 'unknown') {
          if (this.#onCommand) {
            this.#stats.commands += 1
            const chunks = []
            try {
              await this.#onCommand({
                message,
                parsed,
                target,
                key,
                // 回执先收集、处理器返回后统一发送：这样「首次使用」提示才能挂在末尾，
                // 一条命令仍只算一次分片发送（commandReplies 口径不变）。
                reply: async (text) => { chunks.push(String(text ?? '')) },
              })
              const body = chunks.filter((t) => t.trim()).join('\n\n')
              // 处理器没有回执就什么都不发：提示不单独成条（空回执的语义保持原样）
              if (body) await this.#sendChunks(target, `${body}${this.#commandHint(parsed)}`, 'commandReplies')
              else this.#logger.warn?.(`[bridge] 命令 ${parsed.name ?? parsed.word} 没有回执`)
            } catch (error) {
              // 处理器抛错：只回一句人话，不冒泡（外层 catch 是给模型路径用的，不能借道）
              this.#stats.commandsFailed += 1
              const label = parsed.kind === 'command' ? parsed.name : parsed.word
              this.#logger.error?.(`[bridge] 命令处理失败（${label}）: ${error?.message ?? error}`)
              try {
                // 已产出的回执不丢；走分片，避免绕过 4500 字与被动条数上限
                const body = chunks.filter((t) => t.trim()).join('\n\n')
                const text = [body, `（命令执行出错：${error?.message ?? error}）`].filter(Boolean).join('\n\n')
                await this.#sendChunks(target, text, 'commandReplies')
              } catch { /* 尽力而为 */ }
            }
            return
          }
          this.#logger.warn?.(
            `[bridge] 命令层未接线，按普通消息处理：${content.replace(/\s+/g, ' ').slice(0, 40)}`,
          )
        }
        if (this.#serveClient?.available) {
          await this.#handleServe({ key, target, content })
        } else {
          await this.#handleHeadless({ key, target, content })
        }
      } catch (error) {
        this.#stats.failed += 1
        this.#logger.error?.(`[bridge] 处理失败: ${error?.message ?? error}`)
        try {
          await this.#send(target, `（内部错误：${error?.message ?? error}）`)
        } catch { /* 尽力而为 */ }
      }
    })
  }

  /**
   * 命令回执末尾的提示行。
   * - 首次用到某条命令（由注入的 commandHints 记忆）→ 附该命令的用法两行，并记下「已教过」；
   * - 之后只附一行「/help 看全部命令」；
   * - 未知命令（它回的就是帮助本身）不再叠加。
   * 未注入记忆时按「已教过」处理：只留一行，免得每条回执都复述用法。
   */
  #commandHint(parsed) {
    if (parsed?.kind !== 'command' || !parsed.name) return ''
    const hints = this.#commandHints
    if (hints && typeof hints.has === 'function' && typeof hints.mark === 'function'
      && !hints.has(parsed.name)) {
      hints.mark(parsed.name)
      const first = firstUseHint(parsed.name)
      if (first) {
        return `\n\n—— 第一次用到 /${parsed.name}，用法放这儿：\n${first}\n（以后只附一行提示；/help 看全部命令）`
      }
    }
    return '\n\n（/help 看全部命令）'
  }

  // ── serve 原生会话路径 ───────────────────────────────────────

  async #handleServe({ key, target, content }) {
    const cwd = this.#workspaceOverride || this.#workspaceRoot
    this.#ensureDir(cwd)

    let sessionId = this.#sessionMap?.get(key) ?? null
    let fresh = false
    if (!sessionId) {
      sessionId = await this.#createServeSession(key, cwd, content)
      fresh = true
    }

    // 基线游标：prompt 之前始终取一次快照（避免把历史 text_delta 当新回复）。
    // 沿用旧会话时若快照缺 lastSeq，退回 0 会把上一轮内容重放进聊天窗口，故直接报错；
    // 刚建的新会话退回 0 是安全的（新会话不该有事件）。
    // 快照拿不到（500/401）会抛错，交由外层上报，持久绑定保持不动。
    let baseSeq = 0
    const snapshot = await this.#serveClient.getSession(sessionId)
    if (!snapshot) {
      // 陈旧映射（会话确已被删除）→ 重建，游标回到 0
      this.#sessionMap?.del?.(key)
      sessionId = await this.#createServeSession(key, cwd, content)
      fresh = true
    } else if (Number.isFinite(snapshot.lastSeq)) {
      baseSeq = snapshot.lastSeq
    } else if (!fresh) {
      throw new Error('会话快照缺少 lastSeq：拒绝从 0 起算（会把历史重放进 QQ）')
    }

    this.#logger.info?.(`[bridge] serve → 会话 ${String(sessionId).slice(0, 14)}（${content.length} 字）`)
    try {
      await this.#serveClient.promptSession(sessionId, content)
    } catch (error) {
      if (error?.code === 'session-not-found') {
        this.#sessionMap?.del?.(key)
        sessionId = await this.#createServeSession(key, cwd, content)
        baseSeq = 0 // 新会话 seq 从头开始；沿用旧游标会让事件被 e.seq > since 全部过滤
        await this.#serveClient.promptSession(sessionId, content)
      } else {
        this.#stats.failed += 1
        await this.#send(target, `（天枢呼叫失败：${error?.message ?? '未知错误'}）`)
        this.#stats.replies += 1
        return
      }
    }

    const reply = await this.#serveClient.waitForReply(sessionId, { since: baseSeq })
    const text = reply?.text ?? ''
    if (!text) {
      this.#stats.failed += 1
      const reason = reply?.error
        ? `（天枢连接中断：${reply.error?.message ?? reply.error}）`
        : reply?.timedOut
          ? '（天枢回合超时，稍后再发一条试试）'
          : '（天枢返回了空内容）'
      await this.#send(target, reason)
      this.#stats.replies += 1
      return
    }
    // 超时但有半截文本：如实标注，别让用户以为这就是全部
    await this.#sendChunks(target, reply?.timedOut
      ? `${text}\n\n（这条可能不完整：天枢回合未结束就超时了）`
      : text)
    this.#logger.info?.(`[bridge] serve ← 回复已发送（${text.length} 字${reply?.timedOut ? '，超时截断' : ''}）`)
  }

  async #createServeSession(key, cwd, content) {
    const session = await this.#serveClient.createSession({ cwd, title: sessionTitleFor(content) })
    const id = session?.id
    if (!id) throw new Error('createSession 未返回会话 id')
    this.#sessionMap?.set?.(key, id)
    this.#stats.serveSessionsCreated += 1
    this.#logger.info?.(`[bridge] serve 新建会话 ${String(id).slice(0, 14)}（${key}）`)
    return id
  }

  // ── headless 降级路径（原逻辑）───────────────────────────────

  async #handleHeadless({ key, target, content }) {
    const cwd = this.#workspaceOverride || join(this.#workspaceRoot, conversationDirName(key))
    this.#ensureDir(cwd)
    const history = this.#historyStore?.get(key) ?? []
    const prompt = formatPrompt(content, history)
    this.#logger.info?.(`[bridge] headless → 天枢调用（${key}，${content.length} 字，历史 ${history.length} 条）`)
    const result = await this.#call({ cwd, prompt })
    if (!result?.ok) {
      this.#stats.failed += 1
      await this.#send(target, `（天枢呼叫失败：${result?.error ?? '未知错误'}）`)
      this.#stats.replies += 1
      return
    }
    this.#historyStore?.appendTurn(key, content, result.text ?? '')
    const text = result.text ?? ''
    if (!text) {
      await this.#send(target, '（天枢返回了空内容）')
      this.#stats.replies += 1
      return
    }
    await this.#sendChunks(target, text)
    this.#logger.info?.('[bridge] headless ← 回复已发送')
  }

  // ── 公共：分片发送 ──────────────────────────────────────────

  /**
   * 分片发送（模型回复与命令回执共用同一套规则：4500 字/片、被动条数上限）。
   * @param {'replies'|'commandReplies'} counter 计入哪个口径，两者互不串账
   * @returns {Promise<number>} 实际发出的片数
   */
  async #sendChunks(target, text, counter = 'replies') {
    const { chunks } = planReply(text, { scope: target.scope })
    if (chunks.length === 0) return 0
    for (const chunk of chunks) {
      await this.#send(target, chunk)
      this.#stats[counter] += 1
    }
    return chunks.length
  }
}
