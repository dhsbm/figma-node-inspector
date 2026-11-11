/**
 * MCP server 入口：把 hub 和协议层接起来。
 *
 * stdout 是协议通道，日志只能走 stderr，否则会污染 JSON-RPC 流。
 *
 * hub 绑定失败（端口被占用等）不能让进程退出：
 * MCP 客户端会因此连工具列表都拿不到，排查起来毫无线索。
 *
 * 但也不能假装没事：多个 MCP 客户端（Cursor 重启、多窗口）会各起一个进程，
 * 只有一个能绑上端口。未绑上端口的进程必须把 status/call 转发给真正在
 * 监听的那个，
 * 否则它会报「pluginConnected: false」，让人误以为插件没连上。
 */

import {createHub} from './hub.mjs'
import {attachStdio, createRpcHandler} from './protocol.mjs'

const PORT = Number(process.env.NI_MCP_PORT || 3999)
const HOST = process.env.NI_MCP_HOST || undefined
const ALLOW_EVAL = process.env.NI_MCP_ALLOW_EVAL === '1'

const log = (...args) =>
  process.stderr.write(`[inspector-mcp] ${args.join(' ')}\n`)

const base = `http://localhost:${PORT}`
const hub = createHub({port: PORT, host: HOST})

/** hub 未就绪时置为错误信息，之后一律走转发 */
const hubState = {error: null, probing: false}
const originalStatus = hub.status

const proxyGet = async (path) => {
  const res = await fetch(`${base}${path}`)
  if (!res.ok) throw new Error(`hub 返回 ${res.status}`)
  return res.json()
}

const proxyCall = async (op, args) => {
  const res = await fetch(`${base}/call`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({op, args}),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(body.error || `hub 返回 ${res.status}`)
  return body.result
}

/**
 * 端口被别人占用时，确认占用者确实是同款 hub。
 * 不是的话要明确报错，而不是把请求发到陌服务上。
 */
const probeExisting = async () => {
  try {
    const body = await proxyGet('/status')
    return typeof body?.port === 'number' ? null : '端口被非 hub 服务占用'
  } catch (e) {
    return `端口被占用且不可用：${e.message}`
  }
}

const handle = createRpcHandler({
  hub: {
    call: (op, args) => {
      if (hubState.error) return proxyCall(op, args)
      return hub.call(op, args)
    },
    status: async () => {
      // 自己绑上了端口 → 本地状态就是真相
      if (!hubState.error) {
        return {
          ...originalStatus(),
          hubReady: true,
          hubError: null,
          role: 'owner',
        }
      }
      // 没绑上 → 端口上那个进程才是真相
      try {
        const remote = await proxyGet('/status')
        return {
          ...remote,
          hubReady: true,
          hubError: null,
          role: 'proxy',
          note: `本进程未绑定端口，已转发到 ${base}`,
        }
      } catch (e) {
        return {
          ...originalStatus(),
          hubReady: false,
          hubError: hubState.error || String(e.message || e),
          role: 'orphan',
        }
      }
    },
  },
  extra: {hubBase: base, allowEval: ALLOW_EVAL},
})

attachStdio(handle)

hub
  .listen()
  .then((addr) =>
    log(`hub listening on http://localhost:${addr.port} (${addr.host})`),
  )
  .catch(async (e) => {
    hubState.error = String(e.message || e)
    hubState.probing = true
    const problem = await probeExisting()
    hubState.probing = false

    if (problem) {
      // 端口被别的东西占了：这是真故障，要说清楚
      hubState.error = `${hubState.error}；${problem}`
      log(`hub 启动失败且端口不可用: ${hubState.error}`)
      log(`换个端口：NI_MCP_PORT=4000 node src/mcp/mcp.mjs`)
      return
    }

    log(`端口 ${PORT} 已被另一个 inspector-mcp 占用，本进程转为转发模式`)
  })