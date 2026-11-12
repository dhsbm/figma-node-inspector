/**
 * 样式与图片读取的协议测试。
 *
 * 重点验三件容易出错的事：
 *   1. 小图 → MCP image content（模型能直接看到）
 *   2. 大图 → 落盘 + 路径（避免 ndjson 单行几 MB）
 *   3. 样式结果 → 文本 JSON，不被误判为图片
 *
 * 跑法：node scripts/test-mcp-images.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRpcHandler} from '../src/mcp/protocol.mjs'

/** 项目根目录：脚本在 scripts/ 下 */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

/** 1x1 透明 PNG，用来验证 base64 原样传递 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const stubHub = (result) => ({
  call: async () => result,
  status: async () => ({pluginConnected: true}),
})

const callWith = async (result, name, args = {}) => {
  const handle = createRpcHandler({hub: stubHub(result)})
  return handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {name, arguments: args},
  })
}

// 1. 小图 → 内联 image content
{
  const res = await callWith(
    {
      nodeId: '1:2',
      name: 'icon',
      format: 'PNG',
      mimeType: 'image/png',
      data: TINY_PNG,
      byteLength: 68,
      width: 1,
      height: 1,
      scale: 1,
    },
    'figma_export_node_image',
  )
  const content = res.result.content
  const img = content.find((c) => c.type === 'image')
  assert.ok(img, '小图必须是 image content')
  assert.equal(img.mimeType, 'image/png')
  assert.equal(img.data, TINY_PNG, 'base64 必须原样传递，不能带 data: 前缀')
  assert.ok(!img.data.startsWith('data:'), '不能带 data: 前缀')

  const meta = content.find((c) => c.type === 'text')
  assert.ok(meta, '必须附带元信息')
  assert.match(meta.text, /"nodeId": "1:2"/)
  console.log('  ✓ 小图内联为 image content')
}

// 2. 大图 → 落盘，不内联
{
  const big = Buffer.alloc(600 * 1024, 7).toString('base64')
  const res = await callWith(
    {
      nodeId: '9:9',
      name: '长截图',
      format: 'PNG',
      mimeType: 'image/png',
      data: big,
      byteLength: 600 * 1024,
      width: 375,
      height: 3141,
      scale: 1,
    },
    'figma_export_node_image',
  )
  const content = res.result.content
  assert.ok(
    !content.some((c) => c.type === 'image'),
    '大图不应内联',
  )
  const meta = JSON.parse(content.find((c) => c.type === 'text').text)
  assert.ok(meta.path, '大图必须给出落盘路径')
  assert.ok(fs.existsSync(meta.path), `落盘文件应存在: ${meta.path}`)
  assert.equal(
    fs.statSync(meta.path).size,
    600 * 1024,
    '落盘字节数必须与 byteLength 一致',
  )
  assert.match(meta.note, /超过内联阈值/)

  // 落盘位置必须在项目 temp/ 下，而不是系统临时目录
  assert.ok(
    meta.path.startsWith(path.join(projectRoot, 'temp')),
    `落盘应位于项目 temp/，实际: ${meta.path}`,
  )
  console.log('  ✓ 大图落盘并返回路径（位于项目 temp/）')
}

// 3. 批量：小图内联、大图落盘，混合场景
{
  const big = Buffer.alloc(600 * 1024, 3).toString('base64')
  const res = await callWith(
    {
      images: [
        {
          nodeId: '1:1',
          name: 'small',
          format: 'JPG',
          mimeType: 'image/jpeg',
          data: TINY_PNG,
          byteLength: 68,
          width: 10,
          height: 10,
          scale: 1,
        },
        {
          nodeId: '2:2',
          name: 'large',
          format: 'PNG',
          mimeType: 'image/png',
          data: big,
          byteLength: 600 * 1024,
          width: 375,
          height: 3141,
          scale: 1,
        },
      ],
      errors: [{nodeId: '3:3', name: 'bad', error: 'not exportable'}],
    },
    'figma_export_nodes_images',
  )
  const content = res.result.content
  const inline = content.filter((c) => c.type === 'image')
  assert.equal(inline.length, 1, '只有小图内联')

  const meta = JSON.parse(content[content.length - 1].text)
  assert.equal(meta.count, 2)
  assert.equal(meta.errors.length, 1, '错误必须透出，不能静默丢')
  const withPath = meta.images.filter((i) => i.path)
  assert.equal(withPath.length, 1, '大图应有一个落盘路径')
  assert.ok(fs.existsSync(withPath[0].path))
  console.log('  ✓ 批量混合：小图内联 + 大图落盘 + 错误透出')
}

// 4. 样式结果不能被误判成图片
{
  const res = await callWith(
    {
      id: '5:5',
      name: '卡片',
      type: 'FRAME',
      styles: {
        fills: [
          {
            type: 'GRADIENT_LINEAR',
            stops: [
              {position: 0, color: '#0A2851FF'},
              {position: 1, color: '#001537FF'},
            ],
            cssAngle: 90,
            css: 'linear-gradient(90deg, #0A2851FF 0.00%, #001537FF 100.00%)',
          },
        ],
        cornerRadius: 8,
        effects: [{type: 'DROP_SHADOW', radius: 12}],
      },
    },
    'figma_get_node_styles',
  )
  const content = res.result.content
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text', '样式结果是文本，不是 image')
  const parsed = JSON.parse(content[0].text)
  assert.equal(parsed.styles.cornerRadius, 8)
  assert.ok(parsed.styles.fills[0].css.includes('linear-gradient'))
  console.log('  ✓ 样式结果为文本 JSON，渐变带 CSS 与角度')
}

// 5. 同样的形状但结果里带 data 字段时，不能被误判成图片
//    （样式结果理论上不含 data，但要防误伤）
{
  const res = await callWith(
    {id: '7:7', data: null, styles: {}},
    'figma_get_node_styles',
  )
  assert.equal(
    res.result.content[0].type,
    'text',
    'data 不是 string 时不应走图片分支',
  )
  console.log('  ✓ 非图片结果的 data 字段不会误触发图片分支')
}

// 清理本次产生的落盘产物，避免逐次运行堆积在 temp/
{
  const dir = path.join(projectRoot, 'temp', 'mcp-images')
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f))
    }
  }
}

console.log('images OK：内联/落盘分流、批量、错误透出、样式不误判')