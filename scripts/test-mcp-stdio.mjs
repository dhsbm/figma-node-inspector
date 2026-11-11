/**
 * 真进程冒烟：把 server/mcp.mjs 当子进程，走真实 stdio 管道。
 *
 * 覆盖了 e2e 测试没覆盖的一层：ndjson 分帧、stdout 纯净度、
 * 以及 hub 起不来时是否仍然能服务协议（不能因为端口占用直接死掉）。
 *
 * 跑法：npm run test:stdio
 */

import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import assert from 'node:assert'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const run = ({port, requests}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'src/mcp/mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, NI_MCP_PORT: String(port)},
    })

    let out = ''
    let err = ''
    let finished = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)

    /**
     * hub 是常驻服务，进程不会自己退出。
     * 所以「拿到预期条数的响应」就要主动收尾并 kill，
     * 否则测试会一直挂着等 close 事件。
     */
    const settle = () => {
      if (finished) return
      if (out.split('\n').filter(Boolean).length < expected) return
      finished = true
      clearInterval(waitReady)
      clearTimeout(hardStop)
      // 留一点时间让最后一行 flush
      setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise({out, err})
      }, 80)
    }

    const expected = requests.filter((r) => r.id !== undefined).length

    child.stdout.on('data', settle)

    const started = Date.now()
    const waitReady = setInterval(() => {
      if (err.includes('listening') || err.includes('启动失败')) {
        clearInterval(waitReady)
        for (const req of requests) {
          child.stdin.write(`${JSON.stringify(req)}\n`)
        }
        setTimeout(() => child.stdin.end(), 120)
      } else if (Date.now() - started > 5000) {
        clearInterval(waitReady)
        child.kill('SIGKILL')
        reject(new Error(`等不到 hub 启动日志：${err}`))
      }
    }, 40)

    // 兜底：无论发生什么都不能让测试无限期挂住
    const hardStop = setTimeout(() => {
      if (finished) return
      finished = true
      clearInterval(waitReady)
      child.kill('SIGKILL')
      reject(new Error(`测试超时，已收到 ${out.length} 字节 stdout`))
    }, 15000)

    child.on('close', () => {
      if (finished) return
      finished = true
      clearInterval(waitReady)
      clearTimeout(hardStop)
      resolvePromise({out, err})
    })
  })

const parse = (out) =>
  out
    .trim()
    .split('\n')
    .filter(Boolean)
    // stdout 必须只有协议数据，任何日志混进来都会在这里炸
    .map((line) => JSON.parse(line))

const requests = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {protocolVersion: '2024-11-05'},
  },
  {jsonrpc: '2.0', id: 2, method: 'tools/list'},
  // 通知没有 id，客户端不会等响应
  {jsonrpc: '2.0', method: 'notifications/initialized'},
  {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {name: 'nope', arguments: {}},
  },
  {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {name: 'figma_status'},
  },
]

const {out, err} = await run({port: 0, requests})
const lines = parse(out)

assert.ok(
  err.includes('listening') || err.includes('启动失败'),
  `hub 应给出明确日志：${err}`,
)
// 无论 hub 是否起来，协议层都必须完整可用
assert.equal(lines.length, 4, '通知不应产生响应')
assert.equal(lines[0].result.serverInfo.name, 'node-inspector-mcp')
assert.ok(lines[1].result.tools.length >= 15)
assert.equal(lines[2].result.isError, true, '未知工具应返回 isError')

const status = JSON.parse(lines[3].result.content[0].text)
assert.equal(status.toolCount, lines[1].result.tools.length)
assert.ok('hubReady' in status, 'status 必须报告 hub 是否就绪')

// 沙箱外应能绑定；被限制时也要能把原因表达出来，而不是静默
if (status.hubReady) {
  assert.ok(err.includes('listening'))
} else {
  assert.match(status.hubError, /EPERM|EADDRINUSE/, String(status.hubError))
}

const count = lines[1].result.tools.length
console.log(`stdio OK（${count} 个工具，hubReady=${status.hubReady}）`)