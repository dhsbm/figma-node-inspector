/**
 * 一致性检查。
 *
 * 合并进 Node Inspector 之后，"插件侧"不再在本目录里，
 * 所以这里守的是三方契约：
 *
 *   1. 端口：ui.html 的轮询地址 / manifest 白名单 / server 默认端口
 *   2. 工具：server 的工具清单 op 名 ↔ Node Inspector 的 ops 注册表
 *   3. ops 注册表里不能出现 server 未暴露的操作（会变成死代码）
 *
 * 跑法：npm run check
 */

import assert from 'node:assert'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {opNames} from '../src/mcp/tools.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const read = (p) => fs.readFileSync(resolve(root, p), 'utf8')

// 1. 端口三处一致
const manifest = JSON.parse(read('manifest.json'))
const clientPort = read('src/bridge/client.ts').match(
  /http:\/\/localhost:(\d+)/,
)?.[1]
const mcpPort = read('src/mcp/mcp.mjs').match(/NI_MCP_PORT \|\| (\d+)/)?.[1]

assert.ok(
  clientPort,
  'src/bridge/client.ts 里找不到 HUB 端口（应为 http://localhost:PORT）',
)
assert.equal(
  mcpPort,
  clientPort,
  `server 默认端口 ${mcpPort} ≠ 插件 ${clientPort}`,
)

// 2. manifest 网络声明必须符合 Figma 的校验规则
const net = manifest.networkAccess || {}
const dev = net.devAllowedDomains || []
const allowed = net.allowedDomains || []

// localhost 只能放 devAllowedDomains
assert.ok(
  dev.some((d) => d.endsWith(`:${clientPort}`)),
  `devAllowedDomains 缺端口 ${clientPort}：${dev.join(', ')}`,
)
assert.ok(
  !allowed.some((d) => /localhost|127\.0\.0\.1/.test(d)),
  '本地地址不能写进 allowedDomains，发布版会要求审核',
)

// Figma 拒绝 IP 字面量，这条曾经导致插件直接加载失败
for (const pattern of [...allowed, ...dev]) {
  assert.ok(
    !/^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(pattern),
    `Figma 不接受 IP 字面量: ${pattern}（改用 localhost）`,
  )
}

// 发布版保持无网络
assert.deepEqual(
  allowed,
  ['none'],
  'allowedDomains 应为 ["none"]，网络权限只给开发模式',
)

// 2. 工具清单与插件 ops 注册表对齐
const opsSource = read('src/bridge/ops.ts')
const registered = [...opsSource.matchAll(/^ {4}async (\w+)\(/gm)].map(
  (m) => m[1],
)

assert.ok(registered.length > 0, '没解析到插件的 ops 注册表')
assert.deepEqual(
  [...registered].sort(),
  [...opNames].sort(),
  'src/mcp/tools.mjs 的 op 名与 src/bridge/ops.ts 不一致',
)

// 3. 已移除的逃生口不能死灰复燃
assert.ok(
  !opNames.includes('eval'),
  'eval 不应出现在工具清单（不开放任意代码执行）',
)

console.log(
  `mcp check OK（端口 ${clientPort}，工具 ${opNames.length} 个，ops 对齐）`,
)