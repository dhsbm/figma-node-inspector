/**
 * 端到端（不含 socket）：core 状态机 + 协议层 + 假插件。
 *
 * 真实链路里 core 由 http.mjs 暴露，这里直接驱动 core，
 * 因此能在禁止监听的沙箱里验证「任务入队 → 插件认领 → 回传 → 解析」全流程。
 *
 * 跑法：npm run test:e2e
 */

import assert from 'node:assert'
import {createCore} from '../src/mcp/core.mjs'
import {createRpcHandler} from '../src/mcp/protocol.mjs'

/** 假插件：模拟 ui.html 的轮询循环（204 相当于拿到 null） */
const startFakePlugin = (core, handler) => {
  let alive = true
  const loop = async () => {
    while (alive) {
      const job = await core.next(1000)
      if (!alive) return
      if (!job) continue
      let payload
      try {
        payload = {id: job.id, ok: true, result: await handler(job)}
      } catch (e) {
        payload = {id: job.id, ok: false, error: String(e.message || e)}
      }
      core.settle(payload)
    }
  }
  loop()
  return () => {
    alive = false
  }
}

const core = createCore({timeoutMs: 3000})
const hub = {call: core.call, status: core.status}
const rpc = createRpcHandler({hub, extra: {hubBase: 'http://127.0.0.1:3999'}})

const stop = startFakePlugin(core, (job) => {
  switch (job.op) {
    case 'getSelection':
      return {count: 0, nodes: []}
    case 'groupNodes':
      return {id: '9:9', name: job.args.name, type: 'GROUP'}
    case 'deleteNode':
      throw new Error('插件内部炸了')
    default:
      return {op: job.op}
  }
})

await new Promise((r) => setTimeout(r, 50))

// 1. 插件在线
assert.equal(core.status().pluginConnected, true)

// 2. 正常往返
const sel = await hub.call('getSelection', {})
assert.equal(sel.count, 0)

const grouped = await hub.call('groupNodes', {nodeIds: ['1:1'], name: 'Hero'})
assert.equal(grouped.name, 'Hero')

// 3. 插件抛错要冒泡到 MCP 层，而不是静默成功
const errRes = await rpc({
  id: 1,
  method: 'tools/call',
  params: {name: 'figma_delete_node', arguments: {nodeId: 'boom'}},
})
assert.equal(errRes.result.isError, true)

// 4. 队列多条并发，顺序与结果都要对上
const [a, b] = await Promise.all([
  hub.call('figma_a', {i: 1}),
  hub.call('figma_b', {i: 2}),
])
assert.equal(a.op, 'figma_a')
assert.equal(b.op, 'figma_b')

// 5. 超时清理：无插件时 call 不能再泄漏 inflight
stop()
const idle = createCore({timeoutMs: 150})
await assert.rejects(() => idle.call('nobody'), /超时/)
assert.equal(idle.status().inflightCount, 0)
assert.equal(idle.status().queueLength, 0)

// 6. 僵尸订阅回归：轮询超时后不能再把任务取走
const zc = createCore({timeoutMs: 500})
const stale = await zc.next(80)
assert.equal(stale, null, '超时应返回 null')
assert.equal(zc.status().pluginConnected, false, '超时的 waiter 必须已移出')

const pending = zc.call('later', {})
const fresh = await zc.next(500)
assert.ok(fresh, '新订阅要能拿到任务')
assert.equal(fresh.op, 'later')
zc.settle({id: fresh.id, ok: true, result: 'done'})
assert.equal(await pending, 'done')

console.log('e2e OK：入队 / 认领 / 回传 / 报错 / 并发 / 超时清理 / 僵尸订阅')