/**
 * 协议层：JSON-RPC 方法 → 响应对象。
 *
 * 与 hub、与 stdio 都无关，方便单测。
 * 依赖注入一个 {call, status} 形状的 hub，而不是 import 具体实现。
 */

import {opOf, tools} from './tools.mjs'

const SERVER_INFO = {name: 'node-inspector-mcp', version: '0.1.0'}

const wrap = (value) => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
})

const errorContent = (message) => ({
  content: [{type: 'text', text: message}],
  isError: true,
})

export const createRpcHandler = ({hub, extra = {}}) => {
  const callTool = async (name, args) => {
    if (name === 'figma_status') {
      // status 可能是异步的（未绑端口的进程要转发查询），统一 await
      return wrap({...(await hub.status()), toolCount: tools.length, ...extra})
    }
    const op = opOf[name]
    if (!op) throw new Error(`未知工具: ${name}`)
    // MCP 工具名与插件 op 名不是同一套命名，必须翻译后再下发
    return wrap(await hub.call(op, args || {}))
  }

  return async (msg) => {
    const {id, method, params} = msg

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {tools: {listChanged: false}},
          serverInfo: SERVER_INFO,
        },
      }
    }

    if (method === 'tools/list') {
      return {jsonrpc: '2.0', id, result: {tools}}
    }

    if (method === 'tools/call') {
      try {
        const r = await callTool(params?.name, params?.arguments)
        return {jsonrpc: '2.0', id, result: r}
      } catch (e) {
        const err = errorContent(String(e.message || e))
        return {jsonrpc: '2.0', id, result: err}
      }
    }

    if (method === 'ping') {
      return {jsonrpc: '2.0', id, result: {}}
    }

    // 通知（无 id）不需要响应
    if (id === undefined) return null

    return {
      jsonrpc: '2.0',
      id,
      error: {code: -32601, message: `未实现的方法: ${method}`},
    }
  }
}

/** newline-delimited JSON-RPC 的 stdio 泵。stdout 只写协议数据。 */
export const attachStdio = (
  handle,
  {stdin = process.stdin, stdout = process.stdout} = {},
) => {
  const send = (payload) => stdout.write(`${JSON.stringify(payload)}\n`)

  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
      if (!line) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        const err = {code: -32700, message: 'JSON 解析失败'}
        send({jsonrpc: '2.0', id: null, error: err})
        continue
      }

      Promise.resolve(handle(msg))
        .then((res) => {
          if (res) send(res)
        })
        .catch((e) => {
          if (msg.id !== undefined) {
            send({
              jsonrpc: '2.0',
              id: msg.id,
              error: {code: -32603, message: String(e.message || e)},
            })
          }
        })
    }
  })
}