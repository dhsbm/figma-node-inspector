/**
 * 协议层：JSON-RPC 方法 → 响应对象。
 *
 * 与 hub、与 stdio 都无关，方便单测。
 * 依赖注入一个 {call, status} 形状的 hub，而不是 import 具体实现。
 */

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {opOf, tools} from './tools.mjs'

const SERVER_INFO = {name: 'node-inspector-mcp', version: '0.2.0'}

/**
 * 大于这个字节数的图片不直接内联。
 *
 * 原因：JSON-RPC 走 ndjson，一张图就是一整行。
 * 几 MB 的单行会让客户端解析变慢甚至失败。
 * 超阈值改为落盘 + 返回路径，由 agent 用文件读取工具打开。
 *
 * 为什么用 512KB 而不是更大：base64 编码会再膨胀约 33%，
 * 512KB 原图对应约 680KB 文本，已经接近单行可接受的极限。
 */
const INLINE_IMAGE_MAX_BYTES = 512 * 1024

/**
 * 落盘位置：项目内 temp/ 的专属子目录，而不是系统临时目录。
 *
 * 选项目内 temp/ 的理由：
 * - 已在 .gitignore 里，不会污染仓库
 * - 和插件既有导出产物放在一起，你能直接在 Finder/VSCode 里翻
 * - os.tmpdir() 会被系统定期清理，调试到一半文件就没了
 *
 * 可用 NI_MCP_TEMP_DIR 覆盖（相对路径按项目根算）。
 */
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

const CACHE_DIR = (() => {
  const custom = process.env.NI_MCP_TEMP_DIR
  if (!custom) return path.join(PROJECT_ROOT, 'temp', 'mcp-images')
  return path.isAbsolute(custom) ? custom : path.join(PROJECT_ROOT, custom)
})()

/** 编号上限：避免同名文件无限堆积，超过就回绕复用 */
const MAX_SEQ = 500

const text = (value) => ({
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
})

const wrap = (value) => ({content: [text(value)]})

const errorContent = (message) => ({
  content: [text(message)],
  isError: true,
})

const isImageResult = (r) =>
  r && typeof r === 'object' && typeof r.data === 'string' && r.mimeType

/**
 * 落盘并返回绝对路径。
 *
 * 命名以「节点 id」为稳定键：同一节点反复导出时覆盖同一个文件，
 * 避免调十次就在 temp 里留十个副本。
 * 只有同名不同节点（几乎不会发生）才加序号。
 */
const writeImage = (image) => {
  fs.mkdirSync(CACHE_DIR, {recursive: true})
  const ext = (image.mimeType || 'image/png').split('/')[1] || 'png'
  const safe = String(image.name || 'image')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .slice(0, 40)
  const id = String(image.nodeId || 'node').replace(/[^\w-]+/g, '_')

  const base = path.join(CACHE_DIR, `${safe}-${id}`)
  let file = `${base}.${ext}`
  let n = 1
  while (fs.existsSync(file) && fs.statSync(file).size !== image.byteLength) {
    file = `${base}-${n}.${ext}`
    n += 1
    if (n > MAX_SEQ) break
  }

  fs.writeFileSync(file, Buffer.from(image.data, 'base64'))
  return file
}

/**
 * 图片结果的两种给出方式：
 * - 小图：MCP image content，模型直接看到像素
 * - 大图：落盘 + 文本路径，避免 ndjson 单行过大
 */
const wrapImage = (image) => {
  if (image.byteLength > INLINE_IMAGE_MAX_BYTES) {
    const file = writeImage(image)
    return wrap({
      nodeId: image.nodeId,
      name: image.name,
      format: image.format,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      scale: image.scale,
      path: file,
      note:
        `图片 ${(image.byteLength / 1024).toFixed(0)}KB 超过内联阈值 ` +
        `${(INLINE_IMAGE_MAX_BYTES / 1024).toFixed(0)}KB，已落盘。` +
        '用文件读取工具打开该路径查看像素。',
    })
  }

  return {
    content: [
      {
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      },
      text({
        nodeId: image.nodeId,
        name: image.name,
        format: image.format,
        byteLength: image.byteLength,
        width: image.width,
        height: image.height,
        scale: image.scale,
      }),
    ],
  }
}

/** 批量导出：逐张按大小分流，图片与元信息分开给 */
const wrapImageList = (result) => {
  const images = result.images || []
  const errors = result.errors || []
  const content = []
  const meta = []

  for (const image of images) {
    if (image.byteLength > INLINE_IMAGE_MAX_BYTES) {
      meta.push({
        nodeId: image.nodeId,
        name: image.name,
        format: image.format,
        byteLength: image.byteLength,
        width: image.width,
        height: image.height,
        path: writeImage(image),
      })
      continue
    }
    content.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    })
    meta.push({
      nodeId: image.nodeId,
      name: image.name,
      format: image.format,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      inline: true,
    })
  }

  content.push(text({count: images.length, images: meta, errors}))
  return {content}
}

/** 按结果形状选包装方式 */
const wrapResult = (result, op) => {
  if (op === 'exportNodesImages') return wrapImageList(result)
  if (isImageResult(result)) return wrapImage(result)
  return wrap(result)
}

export const createRpcHandler = ({hub, extra = {}}) => {
  const callTool = async (name, args) => {
    if (name === 'figma_status') {
      // status 可能是异步的（未绑端口的进程要转发查询），统一 await
      return wrap({...(await hub.status()), toolCount: tools.length, ...extra})
    }
    const op = opOf[name]
    if (!op) throw new Error(`未知工具: ${name}`)
    // MCP 工具名与插件 op 名不是同一套命名，必须翻译后再下发
    return wrapResult(await hub.call(op, args || {}), op)
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