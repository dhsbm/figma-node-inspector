/**
 * Hub 传输层：把 core 状态机暴露成 HTTP。
 *
 *   GET  /next?wait=20000  插件长轮询取任务（204 = 等待超时，无任务）
 *   POST /result           插件回传结果
 *   POST /call             手动调试：直接下发一个 op
 *   GET  /status           健康检查
 *
 * 只绑 127.0.0.1：这是本机 agent 与插件的私聊通道，不该暴露到局域网。
 */

import http from 'node:http'
import {createCore} from './core.mjs'

const POLL_MAX_MS = 30_000
const POLL_DEFAULT_MS = 20_000

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export const createHub = ({port, host, timeoutMs}) => {
  const core = createCore({timeoutMs})

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === '/next') {
      const wait = Math.min(
        Math.max(Number(url.searchParams.get('wait')) || POLL_DEFAULT_MS, 1000),
        POLL_MAX_MS,
      )

      // next() 自己管超时，超时会移出 waiter，不会留下僵尸订阅
      const job = await core.next(wait)

      if (!job) {
        res.writeHead(204, {'access-control-allow-origin': '*'})
        return res.end()
      }
      return json(res, 200, job)
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await readBody(req)
      const ok = core.settle(body)
      return json(res, ok ? 200 : 404, {accepted: ok})
    }

    if (req.method === 'POST' && url.pathname === '/call') {
      const body = await readBody(req)
      try {
        const result = await core.call(body.op, body.args || {}, {
          timeout: body.timeoutMs || timeoutMs,
        })
        return json(res, 200, {ok: true, result})
      } catch (e) {
        return json(res, 500, {ok: false, error: String(e.message || e)})
      }
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {port, host, ...core.status()})
    }

    return json(res, 404, {error: 'not found'})
  })

  const bound = {host: host || '(dual-stack)', port}

  /**
   * 监听。
   *
   * host 省略时 Node 绑双栈（IPv4 + IPv6）。这对插件很重要：
   * 浏览器把 localhost 解析成 ::1 时也要能连上，
   * 只绑 127.0.0.1 会让那次连接直接 ECONNREFUSED。
   */
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        const addr = server.address()
        bound.host = addr.address
        bound.port = addr.port
        resolve({port: addr.port, host: addr.address, family: addr.family})
      })
    })

  const close = () =>
    new Promise((resolve) => {
      core.shutdown()
      server.close(() => resolve())
      server.closeAllConnections?.()
    })

  return {
    call: core.call,
    status: () => ({port: bound.port, host: bound.host, ...core.status()}),
    listen,
    close,
    server,
  }
}