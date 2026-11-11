/**
 * 把 UI 侧的 bundle 注入 ui.html。
 *
 * 每个 bundle 认领一对占位标记：
 *   <!-- <name>-bundle:start --> ... <!-- <name>-bundle:end -->
 *
 * 之所以要「认领」而不是直接追加：
 * 重复执行 build 必须幂等，否则每次构建都会把同一段代码越叠越多。
 */
import * as esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const uiPath = path.join(rootDir, 'ui.html')

const bundles = [
  {
    name: 'export',
    entry: path.join(rootDir, 'ui/export-api.mjs'),
    globalName: 'FigmaExportBundle',
    extension: 'mjs',
  },
  {
    name: 'bridge',
    entry: path.join(rootDir, 'src/bridge/ui-entry.ts'),
    // 桥接是副作用模块，不需要挂全局
    globalName: null,
    extension: 'ts',
  },
]

const inject = (html, {name, code}) => {
  const startMark = `<!-- ${name}-bundle:start -->`
  const endMark = `<!-- ${name}-bundle:end -->`

  if (!html.includes(startMark) || !html.includes(endMark)) {
    throw new Error(`ui.html 缺少 ${name} 的占位标记`)
  }

  const snippet = `${startMark}
<script>
${code}
</script>
${endMark}`

  const start = html.indexOf(startMark)
  const end = html.indexOf(endMark) + endMark.length
  return html.slice(0, start) + snippet + html.slice(end)
}

let html = fs.readFileSync(uiPath, 'utf8')

for (const bundle of bundles) {
  const result = await esbuild.build({
    entryPoints: [bundle.entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: bundle.globalName ?? undefined,
    target: ['es2017'],
    minify: true,
    loader: {'.ts': 'ts'},
  })

  const code = result.outputFiles[0].text
  html = inject(html, {name: bundle.name, code})
  console.log(
    `Injected ${bundle.name} bundle (${(code.length / 1024).toFixed(1)} KB)`,
  )
}

fs.writeFileSync(uiPath, html, 'utf8')