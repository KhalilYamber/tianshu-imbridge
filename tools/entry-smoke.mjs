/**
 * 插件入口加载冒烟（真机同款环境：Windows node + 真实 RIVET_HOME）。
 *
 * 为什么要有它：入口顶层 import 链一挂，天枢会**静默跳过**整个插件（红线第 1 条）。
 * 单测能钉住接口，但钉不住「真机上 import index.js 会不会炸」——所以这里真加载一次。
 *
 * 用法：RIVET_HOME=<...> "<node.exe>" tools/entry-smoke.mjs
 * 退出码：0 = 入口加载成功且 im_status 可调用；1 = 有问题（原因打到 stderr）。
 */
import { pathToFileURL } from 'node:url'

const pluginIndex = process.argv[2] ?? new URL('../index.js', import.meta.url).pathname

try {
  const mod = await import(pathToFileURL(pluginIndex).href)
  const tools = mod?.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('入口没有导出 tools 数组（天枢会看不到任何工具）')
  }
  const names = tools.map((t) => t?.definition?.name).filter(Boolean)
  if (!names.includes('im_status') || !names.includes('im_send')) {
    throw new Error(`工具清单缺少 im_status / im_send，实得：${JSON.stringify(names)}`)
  }

  // 给顶层常驻区一点时间跑完（配置读取 + 连接器启动）
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  const status = tools.find((t) => t.definition.name === 'im_status')
  const result = await status.execute({})
  const parsed = JSON.parse(result.content)
  console.log('入口加载：OK')
  console.log(`工具清单：${JSON.stringify(names)}`)
  console.log(`版本：${parsed.version}`)
  console.log(`通道：QQ=${parsed.channels.qq.connection}(configured=${parsed.channels.qq.configured}) `
    + `微信=${parsed.channels.weixin.connection}(configured=${parsed.channels.weixin.configured})`)
  console.log(`安全：qqOwner=${parsed.security.qqOwnerConfigured} weixinOwner=${parsed.security.weixinOwnerConfigured}`)
  console.log(`桥：${parsed.mode}，sessionMap=${parsed.sessionMapSize}`)
  console.log('SMOKE-RESULT: OK')
} catch (error) {
  console.error(`入口加载失败：${error?.message ?? error}`)
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'))
  console.log('SMOKE-RESULT: FAIL')
  process.exitCode = 1
}

// 加载成功并不意味着进程会退出：入口顶端会起连接器（QQ 网关 / 微信长轮询），
// 这正是它在天枢里应有的形态。所以这里不主动 exit（Windows 上会触发 libuv 断言），
// 由调用方用超时收尾——按 SMOKE-RESULT 标记判断结果。5 秒后若无标记则调用方自行判定。
setTimeout(() => {
  console.log('SMOKE-NOTE: 入口仍在运行（连接器存活，符合预期）')
}, 5_000).unref?.()
