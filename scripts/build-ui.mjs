/**
 * 将导出能力打成 IIFE 并注入 ui.html。
 */
import * as esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const entry = path.join(rootDir, 'ui/export-api.mjs')
const uiPath = path.join(rootDir, 'ui.html')
const startMark = '<!-- export-bundle:start -->'
const endMark = '<!-- export-bundle:end -->'

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'FigmaExportBundle',
  target: ['es2017'],
  minify: true,
})

const code = result.outputFiles[0].text
const snippet = `${startMark}
<script>
${code}
</script>
${endMark}`

let html = fs.readFileSync(uiPath, 'utf8')
if (!html.includes(startMark) || !html.includes(endMark)) {
  console.error('ui.html 缺少 export-bundle 占位标记')
  process.exit(1)
}

const start = html.indexOf(startMark)
const end = html.indexOf(endMark) + endMark.length
html = html.slice(0, start) + snippet + html.slice(end)
fs.writeFileSync(uiPath, html, 'utf8')

console.log(
  `Injected export bundle into ui.html (${(code.length / 1024).toFixed(1)} KB)`,
)
