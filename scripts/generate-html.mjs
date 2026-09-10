/**
 * 将 Figma 导出 JSON 转为可预览的静态 HTML（一比一样式还原）。
 * 原稿对比页 contrast.html 仅由插件 ZIP 导出生成。
 *
 * 用法：
 *   node scripts/generate-html.mjs -i ./export.json -o ./dist/index.html
 *   npm run generate:html -- -i a.json -o dist/a.html
 */
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {generateHtmlDocument} from './lib/generate-html-doc.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function printHelp() {
  console.log(`Usage: node scripts/generate-html.mjs [options] [input] [output]

Options:
  -i, --input <file>     输入 JSON（必填）
  -o, --output <file>    输出 HTML 完整路径（优先于 --outdir/--name）
  -d, --outdir <dir>     输出目录（默认：./dist）
  -n, --name <file>      输出文件名（默认：index.html，仅在未指定 -o 时生效）
  -h, --help             显示帮助
`)
}

function parseArgs(argv) {
  const args = argv.slice(2)
  let input
  let output
  let outdir
  let name
  const positionals = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = () => {
      const value = args[++i]
      if (value == null || value.startsWith('-')) {
        throw new Error(`缺少参数值：${arg}`)
      }
      return value
    }

    switch (arg) {
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      case '-i':
      case '--input':
        input = next()
        break
      case '-o':
      case '--output':
        output = next()
        break
      case '-d':
      case '--outdir':
        outdir = next()
        break
      case '-n':
      case '--name':
        name = next()
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`未知参数：${arg}（使用 --help 查看用法）`)
        }
        positionals.push(arg)
    }
  }

  if (!input && positionals[0]) input = positionals[0]
  if (!output && positionals[1]) output = positionals[1]

  if (!input) {
    throw new Error('请指定输入 JSON：-i <file>')
  }

  const inputPath = path.resolve(rootDir, input)
  let outPath
  if (output) {
    outPath = path.resolve(rootDir, output)
  } else {
    const dir = path.resolve(rootDir, outdir || 'dist')
    outPath = path.join(dir, name || 'index.html')
  }

  return {inputPath, outPath}
}

let inputPath
let outPath
try {
  ;({inputPath, outPath} = parseArgs(process.argv))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  printHelp()
  process.exit(1)
}

if (!fs.existsSync(inputPath)) {
  console.error(`输入文件不存在：${inputPath}`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const outDir = path.dirname(outPath)

const {html} = generateHtmlDocument(data, {
  sourceLabel: path.basename(inputPath),
  imageMode: 'inline',
})

fs.mkdirSync(outDir, {recursive: true})
fs.writeFileSync(outPath, html, 'utf8')
console.log(`Input:  ${inputPath}`)
console.log(`Wrote:  ${outPath}`)
console.log(
  `Size:   ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`,
)
