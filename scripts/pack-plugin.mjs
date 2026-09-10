/**
 * 打包可分发的 Figma 插件目录 + ZIP。
 * 运行时仅需：manifest.json、code.js、ui.html
 *
 * 用法：npm run pack（会先 build）
 * 产出：
 *   release/plugin/                         # 解压后可直接 Import
 *   release/node-inspector-plugin-v{ver}.zip
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {createZipStore} from './lib/zip-store.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const pluginDir = path.join(releaseDir, 'plugin')

const REQUIRED = ['manifest.json', 'code.js', 'ui.html']

function readPackageVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  )
  return String(pkg.version || '0.0.0')
}

function assertBuiltFiles() {
  const missing = REQUIRED.filter(
    (name) => !fs.existsSync(path.join(rootDir, name)),
  )
  if (missing.length) {
    throw new Error(
      `缺少构建产物：${missing.join(', ')}。请先运行 npm run build`,
    )
  }
}

function writeInstallNote(version) {
  return `# Node Inspector 插件（v${version}）

## 安装（仅使用，无需 Node）

1. 解压本 ZIP，得到 \`plugin\` 文件夹（或直接使用仓库里的 \`release/plugin\`）
2. 打开 Figma Desktop
3. Plugins → Development → Import plugin from manifest…
4. 选择解压目录中的 \`manifest.json\`
5. 选中画布节点后运行 **Node Inspector**

## 说明

- 本包仅含插件运行时，不含 CLI
- 二次开发请使用完整仓库（见项目 README）
`
}

function main() {
  assertBuiltFiles()

  const version = readPackageVersion()
  fs.mkdirSync(pluginDir, {recursive: true})

  const zipFiles = []
  for (const name of REQUIRED) {
    const src = path.join(rootDir, name)
    const dest = path.join(pluginDir, name)
    fs.copyFileSync(src, dest)
    zipFiles.push({
      name: `plugin/${name}`,
      data: new Uint8Array(fs.readFileSync(src)),
    })
  }

  const installNote = writeInstallNote(version)
  const installPath = path.join(pluginDir, 'INSTALL.md')
  fs.writeFileSync(installPath, installNote, 'utf8')
  zipFiles.push({
    name: 'plugin/INSTALL.md',
    data: new TextEncoder().encode(installNote),
  })

  const zipName = `node-inspector-plugin-v${version}.zip`
  const zipPath = path.join(releaseDir, zipName)
  const zipBytes = createZipStore(zipFiles)
  fs.writeFileSync(zipPath, zipBytes)

  const sizeKb = (zipBytes.length / 1024).toFixed(1)
  console.log(`packed release/plugin/ (${REQUIRED.join(', ')}, INSTALL.md)`)
  console.log(`packed release/${zipName} (${sizeKb} KB)`)
  console.log(
    'Import: Figma → Plugins → Development → Import plugin from manifest… → release/plugin/manifest.json',
  )
}

main()
