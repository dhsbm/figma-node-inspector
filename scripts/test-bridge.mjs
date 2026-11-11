/**
 * 桥接纯逻辑单测（不依赖 Figma、不监听端口）。
 *
 * 覆盖两处最容易出错的逻辑：
 *   1. 层级重排的索引语义
 *   2. 轮询的暂停与退避
 *
 * 跑法：npm run test:bridge
 */
import assert from 'node:assert'
import {
  planMove,
  planReorder,
  assertPermutation,
} from '../src/bridge/layer-order.mjs'
import {createPollTimer} from '../src/bridge/poll-timer.mjs'
import {createSerialQueue} from '../src/bridge/queue.mjs'

/* ---------- 层级重排 ---------- */

const base = ['a', 'b', 'c', 'd']

const check = (args, expected, label) =>
  assert.deepEqual(planMove(...args).desired, expected, label)

check([base, 'd', 0], ['d', 'a', 'b', 'c'], '移到最底层')
check([base, 'a', 3], ['b', 'c', 'd', 'a'], '移到最上层')
check([base, 'b', 1], base, '原地不动')
check([base, 'b', 99], ['a', 'c', 'd', 'b'], '越界夹到顶')
check([base, 'b', -5], ['b', 'a', 'c', 'd'], '负索引夹到底')

/** 用纯数组模拟 insertChild，验证指令序列能到达目标顺序 */
const simulate = (current, desired) => {
  const working = [...current]
  for (const step of planReorder(current, desired)) {
    // 可能是新搬入、尚不在 current 里的节点
    const from = working.indexOf(step.id)
    if (from >= 0) working.splice(from, 1)
    working.splice(step.index, 0, step.id)
  }
  return working
}

const cases = [
  [['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']],
  [['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']],
  [['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']],
  [['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']],
  [['a', 'b', 'c', 'd', 'e'], ['c', 'a', 'e', 'b', 'd']],
  [['x'], ['x']],
]

for (const [current, desired] of cases) {
  const result = simulate(current, desired)
  assert.deepEqual(result, desired, `${current} → ${desired} 失败`)
  assert.ok(assertPermutation(current, result), '节点不能丢失或重复')
}

// 已在目标位置时不应产生任何指令（避免无意义重写兄弟顺序）
assert.deepEqual(planReorder(base, base), [], '无变化时不产生指令')

// 批量插入：跨父级搬入的节点按插入处理
const current = ['a', 'b', 'c']
const incoming = ['x', 'y']
const desired = current.filter((id) => !incoming.includes(id))
desired.splice(1, 0, ...incoming)
assert.deepEqual(desired, ['a', 'x', 'y', 'b', 'c'])
assert.deepEqual(
  simulate(current, desired),
  ['a', 'x', 'y', 'b', 'c'],
  '批量插入保持相对顺序',
)

// 最坏情况：完全反转
assert.deepEqual(
  simulate(['a', 'b', 'c', 'd', 'e'], ['e', 'd', 'c', 'b', 'a']),
  ['e', 'd', 'c', 'b', 'a'],
)

/* ---------- 轮询节奏 ---------- */

// 暂停期间不发请求，恢复后继续
{
  let paused = true
  let slept = 0
  const timer = createPollTimer({
    shouldPause: () => paused,
    sleep: async () => {
      slept += 1
      if (slept > 3) paused = false
    },
  })
  await timer.wait()
  assert.ok(slept >= 4, '暂停时应继续等待而不是跳过')
}

// 连续失败按指数退避，且不无限增长
{
  const delays = []
  const timer = createPollTimer({
    maxBackoffMs: 30000,
    sleep: async (ms) => {
      delays.push(ms)
    },
  })
  for (let i = 0; i < 8; i += 1) timer.recordFailure()
  await timer.wait()
  const last = delays[delays.length - 1]
  assert.ok(last <= 30000, `退避超过上限: ${last}`)
  assert.ok(last >= 1000, `退避过小: ${last}`)
}

// 成功后清零
{
  const timer = createPollTimer({sleep: async () => {}})
  timer.recordFailure()
  timer.recordFailure()
  assert.equal(timer.failures, 2)
  timer.recordSuccess()
  assert.equal(timer.failures, 0, '成功后应清零')
}

// stop 之后 wait 立即返回，不能死循环
{
  const timer = createPollTimer({
    shouldPause: () => true,
    sleep: async () => {
      timer.stop()
    },
  })
  await timer.wait()
  assert.equal(timer.stopped, true)
}

/* ---------- 串行队列 ---------- */

{
  const queue = createSerialQueue()
  const order = []
  const slow = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 20))
    order.push('slow')
    return 'slow'
  })
  const fast = queue.run(async () => {
    order.push('fast')
    return 'fast'
  })
  assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast'])
  assert.deepEqual(order, ['slow', 'fast'], '必须严格串行')
}

// 前一个失败不能阻断后一个
{
  const queue = createSerialQueue()
  const bad = queue.run(async () => {
    throw new Error('boom')
  })
  const good = queue.run(async () => 'ok')
  await assert.rejects(() => bad, /boom/)
  assert.equal(await good, 'ok', '失败不应阻塞后续任务')
}

console.log('bridge OK：层级重排 / 轮询退避 / 串行队列')