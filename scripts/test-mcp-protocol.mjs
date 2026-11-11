/**
 * 协议层测试：用假 hub，验证 MCP 语义（不需要监听端口）。
 *
 * 跑法：npm run test:protocol
 */

import assert from 'node:assert'
import {createRpcHandler} from '../src/mcp/protocol.mjs'
import {tools} from '../src/mcp/tools.mjs'

// 工具清单与宿主插件 ops 注册表的一致性由 check.mjs 守护（跨项目读取），
// 这里只校验协议层自身的契约，不再引用任何插件侧副本。
assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, '工具名重复')

const fakeHub = {
  status: () => ({port: 3999, pluginConnected: true, queueLength: 0}),
  call: async (op, args) => ({op, args}),
}

const handle = createRpcHandler({hub: fakeHub, extra: {hubBase: 'x'}})

const init = await handle({id: 1, method: 'initialize', params: {}})
assert.equal(init.result.serverInfo.name, 'node-inspector-mcp')
assert.equal(init.result.capabilities.tools.listChanged, false)

const list = await handle({id: 2, method: 'tools/list'})
const names = list.result.tools.map((t) => t.name)
assert.ok(names.length >= 15, `工具数量不足: ${names.length}`)
for (const required of [
  'figma_status',
  'figma_get_node',
  'figma_group_nodes',
  'figma_ungroup',
  'figma_reorder_nodes',
  'figma_set_layout',
]) {
  assert.ok(names.includes(required), `缺少工具 ${required}`)
}

// 合并进 Node Inspector 后刻意不开放逃生口
assert.ok(!names.includes('figma_eval'), 'figma_eval 应已移除')

// 每个工具必须有可用 schema
for (const tool of list.result.tools) {
  assert.equal(tool.inputSchema.type, 'object')
  assert.ok(tool.description, `${tool.name} 缺少描述`)
}

// status 走本地注入
const call = (id, name) =>
  handle({id, method: 'tools/call', params: {name}})

const status = await call(3, 'figma_status')
const statusBody = JSON.parse(status.result.content[0].text)
assert.equal(statusBody.pluginConnected, true)
assert.equal(statusBody.toolCount, names.length)
assert.equal(statusBody.hubBase, 'x')

// 正常转发，且工具名要翻译成插件 op 名
const fwd = await handle({
  id: 4,
  method: 'tools/call',
  params: {name: 'figma_group_nodes', arguments: {nodeIds: ['1:2']}},
})
assert.equal(JSON.parse(fwd.result.content[0].text).op, 'groupNodes')

// 未知工具 → isError，而不是抛异常
const unknown = await call(5, 'nope')
assert.equal(unknown.result.isError, true)

// hub 报错 → isError
const failing = createRpcHandler({
  hub: {
    status: () => ({}),
    call: async () => {
      throw new Error('插件未响应')
    },
  },
})
const failed = await failing({
  id: 6,
  method: 'tools/call',
  params: {name: 'figma_get_node'},
})
assert.equal(failed.result.isError, true)
assert.match(failed.result.content[0].text, /插件未响应/)

// 未知方法 → -32601
const bad = await handle({id: 7, method: 'resources/list'})
assert.equal(bad.error.code, -32601)

// 通知不应有响应
const note = await handle({method: 'notifications/initialized'})
assert.equal(note, null)

console.log(`protocol OK（${names.length} 个工具）`)