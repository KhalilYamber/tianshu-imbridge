import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ServeSessionClient,
  TurnAccumulator,
  parseServerPort,
  probeServerEnv,
} from '../lib/serve-client.mjs'

const ev = (seq, type, data) => ({ seq, type, data })
const json = (body, status = 200) => ({ status, json: async () => body })

// ── probeServerEnv / parseServerPort ──────────────────────────

test('parseServerPort: 标准 serve argv', () => {
  assert.equal(parseServerPort(['node', 'cli/entry.js', 'serve', '--port', '22423']), 22423)
})

test('parseServerPort: 等号写法 --port=N 也认', () => {
  assert.equal(parseServerPort(['node', 'cli/entry.js', 'serve', '--port=43324']), 43324)
})

test('parseServerPort: 无 --port → null', () => {
  assert.equal(parseServerPort(['node', 'main.js', '-p', 'x']), null)
  assert.equal(parseServerPort(undefined), null)
})

test('parseServerPort: 非 serve argv（headless）一律不认', () => {
  assert.equal(parseServerPort(['node', 'main.js', '-p', 'x', '--json']), null)
})

test('parseServerPort: 用户消息正文里的 --port= 不能被当成端口', () => {
  // headless 路径把消息正文作为独立 argv 元素传进来（buildInvocation）
  assert.equal(
    parseServerPort(['n.exe', 'main.js', '-p', '--port=27015 这个 flag 干什么的', '--json']),
    null,
  )
  // 最极端：正文恰好就是一个 --port=N
  const attack = ['n.exe', 'main.js', '-p', '--port=27015', '--json']
  assert.equal(parseServerPort(attack), null)
  assert.equal(probeServerEnv({ RIVET_SERVER_TOKEN: 't' }, attack).available, false)
})

test('parseServerPort: 非法值 → null', () => {
  assert.equal(parseServerPort(['node', 'x', 'serve', '--port', 'abc']), null)
  assert.equal(parseServerPort(['node', 'x', 'serve', '--port', '99999']), null)
  assert.equal(parseServerPort(['node', 'x', 'serve', '--port', '0']), null)
})

test('probeServerEnv: env+argv 齐全 → available', () => {
  const r = probeServerEnv(
    { RIVET_SERVER_TOKEN: 'tok' },
    ['node', 'entry.js', 'serve', '--port', '11277'],
  )
  assert.deepEqual(r, { available: true, token: 'tok', port: 11277 })
})

test('probeServerEnv: 缺 token → 不可用', () => {
  const r = probeServerEnv({}, ['node', 'entry.js', 'serve', '--port', '11277'])
  assert.equal(r.available, false)
  assert.equal(r.token, null)
  assert.equal(r.port, 11277)
})

test('probeServerEnv: 缺 port（TUI/headless 场景）→ 不可用', () => {
  const r = probeServerEnv({ RIVET_SERVER_TOKEN: 'tok' }, ['node', 'main.js', '-p', 'x'])
  assert.equal(r.available, false)
  assert.equal(r.port, null)
})

// ── HTTP 层：错误要能区分出来 ─────────────────────────────────

test('getSession: 只有 404 算「会话已消失」', async () => {
  const client = new ServeSessionClient({
    token: 't', port: 1, fetchImpl: async () => json({ error: 'x' }, 404),
  })
  assert.equal(await client.getSession('s1'), null)
})

test('getSession: 500 必须抛出（否则调用方会误清持久绑定）', async () => {
  const client = new ServeSessionClient({
    token: 't', port: 1, fetchImpl: async () => json({ error: 'boom' }, 500),
  })
  await assert.rejects(() => client.getSession('s1'), (e) => e.code === 'snapshot-failed')
})

test('fetchEvents: 非 200 必须抛出（401/500 不能被吞成「没有新事件」）', async () => {
  const client = new ServeSessionClient({
    token: 't', port: 1, fetchImpl: async () => json({ error: 'nope' }, 401),
  })
  await assert.rejects(() => client.fetchEvents('s1', 0), (e) => e.code === 'events-failed')
})

// ── waitForReply：抖动、基线、有界收尾 ────────────────────────
// serve-client 的 sleep 是 unref 的（插件里不拖住天枢退出），测试里自己保活。

const withKeepAlive = async (fn) => {
  const keepAlive = setInterval(() => {}, 1000)
  try {
    return await fn()
  } finally {
    clearInterval(keepAlive)
  }
}

/** 按脚本逐次回应；脚本用尽后一直返回空事件页。 */
function scriptedFetch(script) {
  let n = 0
  return async () => {
    const step = script[n++]
    if (step === 'throw') throw new TypeError('fetch failed')
    return json(step ?? { events: [] })
  }
}

test('waitForReply: 轮询中途抖一次网络 → 仍收到完整回复', async () => {
  await withKeepAlive(async () => {
    const client = new ServeSessionClient({
      token: 't',
      port: 1,
      fetchImpl: scriptedFetch([
        'throw',
        { events: [ev(3, 'text_delta', { text: '完整' }), ev(4, 'turn_complete', { isFinal: true })] },
      ]),
    })
    const r = await client.waitForReply('s1', { since: 2, timeoutMs: 2000, graceMs: 0, pollMs: 1 })
    assert.equal(r.text, '完整')
    assert.equal(r.timedOut, false)
    assert.equal(r.error, null)
  })
})

test('waitForReply: 一路连不上 → 超时并把错误带出（不再整轮抛出）', async () => {
  await withKeepAlive(async () => {
    const client = new ServeSessionClient({
      token: 't',
      port: 1,
      fetchImpl: async () => { throw new TypeError('fetch failed') },
    })
    const r = await client.waitForReply('s1', { since: 0, timeoutMs: 30, graceMs: 0, pollMs: 5 })
    assert.equal(r.timedOut, true)
    assert.equal(r.text, '')
    assert.match(String(r.error?.message ?? r.error), /fetch failed/)
  })
})

test('waitForReply: 抖过又恢复 → 不残留错误（错误随成功清除）', async () => {
  await withKeepAlive(async () => {
    const client = new ServeSessionClient({
      token: 't',
      port: 1,
      fetchImpl: scriptedFetch(['throw', { events: [ev(1, 'text_delta', { text: 'A' })] }]),
    })
    // timeoutMs 放宽到 400ms：本用例要等「第一次抛错之后的成功轮」；60ms 在并发全量跑
    // （node --test 多文件并行）时偶发来不及，会误报成 flaky（2026-09-24 实测到一次）。
    const r = await client.waitForReply('s1', { since: 0, timeoutMs: 400, graceMs: 0, pollMs: 2 })
    assert.equal(r.timedOut, true)
    assert.equal(r.error, null, '连接已恢复，就不该再报连接错误')
  })
})

test('waitForReply: 只收 seq > since 的事件（基线之前的内容不算本轮回复）', async () => {
  await withKeepAlive(async () => {
    const client = new ServeSessionClient({
      token: 't',
      port: 1,
      // 服务端「多返回」了历史事件：客户端必须自己守住基线
      fetchImpl: async () => json({
        events: [
          ev(1, 'text_delta', { text: '【历史】' }),
          ev(2, 'text_delta', { text: '【历史2】' }),
          ev(3, 'text_delta', { text: '本轮' }),
          ev(4, 'turn_complete', { isFinal: true }),
        ],
      }),
    })
    const r = await client.waitForReply('s1', { since: 2, timeoutMs: 2000, graceMs: 0, pollMs: 1 })
    assert.equal(r.text, '本轮')
  })
})

test('waitForReply: 请求永不响应但兑现 abort → 有界收尾，不永久挂住', async () => {
  await withKeepAlive(async () => {
    const client = new ServeSessionClient({
      token: 't',
      port: 1,
      requestTimeoutMs: 60,
      // 模拟真实 fetch：尊重 AbortSignal
      fetchImpl: (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    })
    const started = Date.now()
    const r = await client.waitForReply('s1', { since: 0, timeoutMs: 600, graceMs: 0, pollMs: 10 })
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - started < 3000, '不该无限挂住')
  })
})

// ── TurnAccumulator ───────────────────────────────────────────

test('TurnAccumulator: 收文本 + isFinal 未到不完成', () => {
  const acc = new TurnAccumulator({ graceMs: 1000 })
  acc.feed([ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'A' })], 0)
  assert.equal(acc.text(), 'A')
  assert.equal(acc.isComplete(10_000), false)
})

test('TurnAccumulator: isFinal 后宽限期满 → 完成', () => {
  const acc = new TurnAccumulator({ graceMs: 1000 })
  acc.feed([ev(1, 'text_delta', { text: 'A' }), ev(2, 'turn_complete', { isFinal: true })], 5000)
  assert.equal(acc.isComplete(5500), false)
  assert.equal(acc.isComplete(6001), true)
})

test('TurnAccumulator: 宽限期内新 text_delta（补救轮）→ 撤销完成、续收', () => {
  const acc = new TurnAccumulator({ graceMs: 1000 })
  acc.feed([ev(1, 'text_delta', { text: 'A' }), ev(2, 'turn_complete', { isFinal: true })], 0)
  acc.feed([ev(3, 'text_delta', { text: 'B' })], 500)
  assert.equal(acc.isComplete(10_000), false, '出现未终结的新内容')
  acc.feed([ev(4, 'turn_complete', { isFinal: true })], 2000)
  assert.equal(acc.isComplete(3001), true)
  assert.equal(acc.text(), 'AB')
})

test('TurnAccumulator: isFinal=false 的 turn_complete 不计', () => {
  const acc = new TurnAccumulator({ graceMs: 100 })
  acc.feed([ev(1, 'turn_complete', { isFinal: false })], 0)
  assert.equal(acc.isComplete(100000), false)
})

test('TurnAccumulator: turn_complete 缺 isFinal 字段时宽容视为终结', () => {
  const acc = new TurnAccumulator({ graceMs: 100 })
  acc.feed([ev(1, 'text_delta', { text: 'X' }), ev(2, 'turn_complete', {})], 0)
  assert.equal(acc.isComplete(101), true)
})

test('TurnAccumulator: 重复 feed 同一批事件幂等（seq 去重）', () => {
  const acc = new TurnAccumulator({ graceMs: 100 })
  const batch = [ev(1, 'text_delta', { text: 'A' }), ev(2, 'text_delta', { text: 'B' })]
  acc.feed(batch, 0)
  acc.feed(batch, 10)
  assert.equal(acc.text(), 'AB')
})
