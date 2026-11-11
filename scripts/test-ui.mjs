/**
 * ui.html 装配检查（不启动浏览器）。
 *
 * 验证三件容易静默出错的事：
 *   1. 两个 bundle 都被注入且只注入一次
 *   2. bridge bundle 能通过语法解析
 *   3. 桥接包装了原 window.onmessage，而不是覆盖它
 *
 * 跑法：npm run test:ui
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(root, 'ui.html'), 'utf8')

const count = (needle) => html.split(needle).length - 1

// 1. 占位标记各只剩一对（幂等注入）
assert.equal(count('<!-- export-bundle:start -->'), 1, 'export 标记重复')
assert.equal(count('<!-- bridge-bundle:start -->'), 1, 'bridge 标记重复')
assert.equal(count('<!-- export-bundle:end -->'), 1)
assert.equal(count('<!-- bridge-bundle:end -->'), 1)

// 2. 挂载点与样式都在
assert.ok(html.includes('id="ni-bridge-root"'), '缺少桥接挂载点')
assert.ok(html.includes('.ni-bridge-dot'), '缺少桥接样式')

// 3. 抽出 bridge bundle 做语法校验
const bridgeBlock = html
  .split('<!-- bridge-bundle:start -->')[1]
  .split('<!-- bridge-bundle:end -->')[0]
const bridgeCode = bridgeBlock.split('<script>')[1].split('</script>')[0]

assert.ok(bridgeCode.trim().length > 100, 'bridge bundle 是空的')
assert.doesNotThrow(
  () => new Function(bridgeCode),
  'bridge bundle 语法错误',
)

// 4. 行为验证：真正执行 bundle，确认原 onmessage 被保留并调用
//    （不能靠字符串匹配：minify 会改变量名）
{
  let originalCalls = 0
  const posted = []

  const rootEl = {
    innerHTML: '',
    querySelector: () => ({
      dataset: {},
      textContent: '',
      title: '',
      setAttribute() {},
      addEventListener() {},
    }),
  }

  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => (id === 'ni-bridge-root' ? rootEl : null),
      addEventListener() {},
    },
    window: {
      onmessage: function () {
        originalCalls += 1
        // 模拟原处理函数：只认 result 消息
        const msg = arguments[0].data.pluginMessage
        if (msg.type === 'result') posted.push('original-result')
      },
    },
    parent: {
      postMessage: (m) => posted.push(m.pluginMessage.type),
    },
    fetch: () => Promise.reject(new Error('测试中不应联网')),
    console: {error() {}, log() {}},
    setTimeout,
    clearTimeout,
    Date,
    Promise,
  }
  sandbox.globalThis = sandbox

  // 用 with 语义把它放进隔离作用域，避免污染测试进程
  const fn = new Function(
    'window',
    'document',
    'parent',
    'fetch',
    'console',
    'setTimeout',
    'clearTimeout',
    `${bridgeCode}`,
  )

  assert.doesNotThrow(() =>
    fn(
      sandbox.window,
      sandbox.document,
      sandbox.parent,
      sandbox.fetch,
      sandbox.console,
      sandbox.setTimeout,
      sandbox.clearTimeout,
    ),
  )

  assert.equal(typeof sandbox.window.onmessage, 'function', '未注册 onmessage')

  // 触发一条原有消息：必须被原处理函数收到
  sandbox.window.onmessage({
    data: {pluginMessage: {type: 'result', data: {nodes: []}}},
  })
  assert.equal(originalCalls, 1, '原 onmessage 被覆盖了')
  assert.ok(posted.includes('original-result'), '原逻辑未执行')

  // 触发桥接消息：不应让原处理函数崩掉，也不应联网
  sandbox.window.onmessage({
    data: {pluginMessage: {type: 'bridge-busy', busy: true}},
  })
  assert.equal(originalCalls, 2, '桥接消息也必须先经过原处理链')

  // 加载时只应发出 bridge-hello，不应开始轮询
  assert.ok(posted.includes('bridge-hello'), '缺少 hello 握手')
  assert.ok(
    !posted.includes('bridge-job'),
    '加载时不应开始处理任务（说明自动轮询了）',
  )
}

// 5. 原有导出 UI 仍在
for (const id of ['btn-header-export', 'header-export-kind', 'btn-refresh']) {
  assert.ok(html.includes(`id="${id}"`), `原有元素丢失: ${id}`)
}

const size = (bridgeCode.length / 1024).toFixed(1)
console.log(`ui OK（bridge ${size}KB，原 onmessage 已串接）`)