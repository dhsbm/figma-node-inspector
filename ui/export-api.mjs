/**
 * 插件 UI 导出能力：JSON / 纯 HTML / HTML+PNG 压缩包。
 * 由 build-ui 打成 IIFE，注入 ui.html。
 */
import {generateHtmlDocument} from '../scripts/lib/generate-html-doc.mjs'
import {attachListsToData} from '../scripts/lib/detect-lists.mjs'
import {createZipStore} from '../scripts/lib/zip-store.mjs'
import {
  getNodeJsonSchemaDoc,
  getNodeJsonSchemaDocFilename,
} from '../scripts/lib/node-json-schema-doc.mjs'
import {attachHtmlLayoutWarningsToData} from '../scripts/lib/html-layout-warnings.mjs'
import {attachRootRelativeCoordsToData} from '../scripts/lib/root-relative-layout.mjs'

function sanitizeFilename(name, fallback) {
  const cleaned = String(name || fallback || 'export')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return cleaned || fallback || 'export'
}

function findNodeById(nodes, nodeId) {
  for (const node of nodes || []) {
    if (node.id === nodeId) return node
    const found = findNodeById(node.children, nodeId)
    if (found) return found
  }
  return null
}

function countTreeNodes(nodes) {
  let count = 0
  for (const node of nodes || []) {
    count += 1
    if (node.children) count += countTreeNodes(node.children)
  }
  return count
}

/**
 * 收集 HTML 生成实际会用到的图片 key（对齐 generate-html-doc）：
 * - 有 png / pngRef → 只用 pngRef，忽略 fill imageHash
 * - 有 svg / svgRef 且无 png → 不用位图
 * - 否则用可见 IMAGE fill/stroke 的 imageHash
 * - visible:false / flattened 子树不收集
 */
function collectHtmlUsedImageKeys(nodes, keys = new Set()) {
  for (const node of nodes || []) {
    if (!node || node.visible === false) continue

    const hasPng = !!(node.png || node.pngRef)
    const hasSvg = !!(node.svg || node.svgRef)
    if (node.pngRef) keys.add(node.pngRef)

    if (!hasPng && !hasSvg) {
      for (const paint of [
        ...(node.styles?.fills || []),
        ...(node.styles?.strokes || []),
      ]) {
        if (
          paint &&
          paint.type === 'IMAGE' &&
          paint.imageHash &&
          paint.visible !== false
        ) {
          keys.add(paint.imageHash)
        }
      }
    }

    if (node.children?.length && !node.flattened) {
      collectHtmlUsedImageKeys(node.children, keys)
    }
  }
  return keys
}

/** SVG 字符串 FNV-1a（32-bit hex），用于 ZIP 内去重 */
function hashSvgContent(svg) {
  const bytes = new TextEncoder().encode(String(svg || ''))
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 将节点内联 svg 收进池；返回 {svgs, nodeIdToRef}。
 * key 形如 s:<contentHash>。
 */
function poolSvgAssets(nodes) {
  const svgs = {}
  const nodeIdToRef = {}

  const walk = (list) => {
    for (const node of list || []) {
      if (!node || node.visible === false) continue
      if (typeof node.svg === 'string' && node.svg.trim()) {
        const contentHash = hashSvgContent(node.svg)
        const key = `s:${contentHash}`
        const existing = svgs[key]
        if (existing) {
          existing.refCount = (existing.refCount || 1) + 1
        } else {
          const bytes = new TextEncoder().encode(node.svg)
          svgs[key] = {
            mime: 'image/svg+xml',
            source: node.svg,
            byteLength: bytes.length,
            contentHash,
            origin: 'vector',
            refCount: 1,
          }
        }
        nodeIdToRef[node.id] = key
      } else if (node.svgRef) {
        nodeIdToRef[node.id] = node.svgRef
      }
      if (node.children?.length && !node.flattened) walk(node.children)
    }
  }

  walk(nodes)
  return {svgs, nodeIdToRef}
}

function pickImageAssets(images, keys) {
  const out = {}
  const seen = new Set()
  for (const key of keys) {
    let k = key
    while (k && !seen.has(k)) {
      seen.add(k)
      const asset = images?.[k]
      if (!asset) break
      out[k] = asset
      if (asset.duplicateOf) {
        k = asset.duplicateOf
        continue
      }
      break
    }
  }
  return out
}

/**
 * 烘焙节点上的 IMAGE fill 对 HTML 已无用；ZIP JSON 中清掉以免再被误收。
 */
function stripUnusedImageFills(nodes) {
  for (const node of nodes || []) {
    const baked = !!(
      node.flattened ||
      node.png ||
      node.pngRef ||
      node.svg ||
      node.svgRef ||
      node.layout?.bakedVisual
    )
    if (baked && node.styles) {
      if (Array.isArray(node.styles.fills)) {
        node.styles.fills = node.styles.fills.filter(
          (paint) => paint?.type !== 'IMAGE',
        )
      }
      if (Array.isArray(node.styles.strokes)) {
        node.styles.strokes = node.styles.strokes.filter(
          (paint) => paint?.type !== 'IMAGE',
        )
      }
    }
    if (node.children?.length && !node.flattened) {
      stripUnusedImageFills(node.children)
    }
  }
}

/**
 * 从完整导出数据中切出指定节点子树（含其引用的图片资产）。
 * 用于右侧详情面板按节点导出。
 */
function sliceDataForNode(data, nodeId) {
  if (!data?.nodes?.length) throw new Error('没有可导出的数据')
  const node = findNodeById(data.nodes, nodeId)
  if (!node) throw new Error('节点不存在或已被删除')

  const cloned = JSON.parse(JSON.stringify(node))
  const assetKeys = collectHtmlUsedImageKeys([cloned])
  const images = pickImageAssets(data.images || {}, assetKeys)
  const imageOk = Object.values(images).filter(
    (a) => a?.dataUrl && !a.error,
  ).length

  return {
    page: data.page,
    selectedCount: 1,
    totalNodeCount: countTreeNodes([cloned]),
    imageCount: imageOk,
    imageFillRefCount: data.imageFillRefCount,
    fonts: data.fonts,
    fontCount: data.fontCount || (data.fonts && data.fonts.length) || 0,
    images,
    nodes: [cloned],
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function downloadText(filename, text, mime) {
  downloadBlob(
    filename,
    new Blob([text], {type: mime || 'text/plain;charset=utf-8'}),
  )
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 下载主线程回传的图片文件；多文件时打成 ZIP。
 */
function downloadExportedImageFiles(files, options = {}) {
  const list = (files || []).filter((f) => f && f.base64 && f.name)
  if (!list.length) throw new Error('没有可下载的图片')

  if (list.length === 1) {
    const file = list[0]
    const bytes = base64ToBytes(file.base64)
    downloadBlob(
      file.name,
      new Blob([bytes], {type: file.mime || 'application/octet-stream'}),
    )
    return {filename: file.name, fileCount: 1}
  }

  const zipFiles = list.map((file) => ({
    name: file.name,
    data: base64ToBytes(file.base64),
  }))
  const zipName = sanitizeFilename(options.zipName, 'images') + '-images.zip'
  downloadBlob(
    zipName,
    new Blob([createZipStore(zipFiles)], {type: 'application/zip'}),
  )
  return {filename: zipName, fileCount: list.length}
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!m) return null
  return {
    mime: m[1] || 'application/octet-stream',
    isBase64: Boolean(m[2]),
    payload: m[3] || '',
  }
}

async function dataUrlToPngBytes(dataUrl) {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new Error('无效的图片 Data URL')

  if (parsed.mime === 'image/png' && parsed.isBase64) {
    return base64ToBytes(parsed.payload)
  }

  const img = new Image()
  img.decoding = 'async'
  img.src = dataUrl
  await img.decode()

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.drawImage(img, 0, 0)

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))),
      'image/png',
    )
  })
  return new Uint8Array(await blob.arrayBuffer())
}

function resolveAssetPath(images, hashToPath, key) {
  if (!key) return null
  const seen = new Set()
  let k = key
  while (k && !seen.has(k)) {
    seen.add(k)
    if (hashToPath[k]) return hashToPath[k]
    const asset = images[k]
    if (asset?.duplicateOf) {
      k = asset.duplicateOf
      continue
    }
    break
  }
  return null
}

/** ZIP 内完整路径 → 相对当前形态目录（index.html / contrast.html 同级）的路径 */
function assetPathInVariant(zipPath, outputPrefix = '') {
  if (!zipPath) return null
  if (outputPrefix && zipPath.startsWith(outputPrefix)) {
    return zipPath.slice(outputPrefix.length)
  }
  return zipPath
}

/**
 * ZIP 内 JSON：只保留用到的 images；dataUrl 改为相对路径；
 * 内联 svg → svgRef + 顶层 svgs 池（path）；清掉烘焙节点死 fill。
 * path 相对 JSON 所在目录（与 index.html 同级）。
 */
function buildZipJsonPayload(
  data,
  images,
  hashToPath,
  outputPrefix = '',
  svgPack = null,
) {
  const cloned = JSON.parse(
    JSON.stringify(
      attachRootRelativeCoordsToData(attachListsToData(data)),
    ),
  )
  stripUnusedImageFills(cloned.nodes)

  cloned.images = {}
  for (const [hash, asset] of Object.entries(images || {})) {
    if (!asset || asset.error) continue
    const copy = {...asset}
    if (copy.dataUrl) {
      const rel = assetPathInVariant(
        resolveAssetPath(images, hashToPath, hash),
        outputPrefix,
      )
      if (rel) {
        delete copy.dataUrl
        copy.path = rel
      } else if (!copy.duplicateOf) {
        continue
      } else {
        delete copy.dataUrl
      }
    }
    cloned.images[hash] = copy
  }
  cloned.imageCount = Object.values(cloned.images).filter(
    (a) => a && (a.path || a.duplicateOf) && !a.error,
  ).length

  const svgPool = svgPack?.svgs || {}
  const svgRefToPath = svgPack?.svgRefToPath || {}
  const nodeIdToRef = svgPack?.nodeIdToRef || {}
  cloned.svgs = {}
  for (const [key, asset] of Object.entries(svgPool)) {
    const rel = assetPathInVariant(svgRefToPath[key], outputPrefix)
    if (!rel) continue
    cloned.svgs[key] = {
      mime: asset.mime || 'image/svg+xml',
      path: rel,
      byteLength: asset.byteLength,
      contentHash: asset.contentHash,
      source: asset.origin || 'vector',
      refCount: asset.refCount || 1,
    }
  }
  cloned.svgFileCount = Object.keys(cloned.svgs).length

  function walkNodes(nodes) {
    for (const node of nodes || []) {
      if (typeof node.png === 'string' && node.png.startsWith('data:')) {
        const rel = assetPathInVariant(
          node.pngRef
            ? resolveAssetPath(images, hashToPath, node.pngRef)
            : null,
          outputPrefix,
        )
        if (rel) node.png = rel
        else delete node.png
      }
      const svgKey = nodeIdToRef[node.id] || node.svgRef
      if (svgKey && cloned.svgs[svgKey]) {
        node.svgRef = svgKey
        delete node.svg
      } else if (typeof node.svg === 'string') {
        // 未入池的残留内联源码不写进 ZIP JSON
        delete node.svg
      }
      if (node.children) walkNodes(node.children)
    }
  }
  walkNodes(cloned.nodes)

  return cloned
}

function exportJsonSchemaDoc(rootName) {
  const filename = getNodeJsonSchemaDocFilename(rootName)
  downloadText(filename, getNodeJsonSchemaDoc(), 'text/markdown;charset=utf-8')
  return {filename}
}

function exportJson(data) {
  const enriched = attachHtmlLayoutWarningsToData(
    attachRootRelativeCoordsToData(attachListsToData(data)),
  )
  const rootName = sanitizeFilename(enriched.nodes?.[0]?.name, 'nodes')
  const text = JSON.stringify(enriched, null, 2)
  const filename = `${rootName}.json`
  downloadText(filename, text, 'application/json;charset=utf-8')
  return {
    filename,
    listCount: enriched.listCount || 0,
  }
}

/**
 * 生成完整 HTML 文档（不下载），供导出与详情预览共用。
 * @param {object} data
 * @param {{
 *   sourceLabel?: string,
 *   chrome?: 'full'|'minimal',
 *   imageMode?: string,
 *   imageSrcForHash?: Function,
 *   vectorSrcForId?: Function,
 *   svgSrcForId?: Function,
 * }} [options]
 */
function buildHtmlDocument(data, options = {}) {
  return generateHtmlDocument(data, {
    sourceLabel: options.sourceLabel || 'plugin-preview',
    imageMode: options.imageMode || 'inline',
    chrome: options.chrome || 'full',
    imageSrcForHash: options.imageSrcForHash,
    vectorSrcForId: options.vectorSrcForId,
    svgSrcForId: options.svgSrcForId,
  })
}

function exportHtmlInline(data, options = {}) {
  void options
  const {html, rootName} = buildHtmlDocument(data, {
    sourceLabel: 'plugin-export',
    imageMode: 'inline',
  })
  const filename = `${sanitizeFilename(rootName, 'preview')}.html`
  downloadText(filename, html, 'text/html;charset=utf-8')
  return {filename}
}

function makeUniqueDirName(name, used) {
  const base = sanitizeFilename(name, 'variant')
  let candidate = base
  let i = 2
  while (used.has(candidate)) {
    candidate = `${base}_${i}`
    i += 1
  }
  used.add(candidate)
  return candidate
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 多形态 ZIP 根目录导航页：侧边切换各子目录预览。
 * 有原稿对比时优先加载 contrast.html，否则回退到一比一 index.html。
 */
function buildBatchRouterHtml(variants, meta = {}) {
  const title = escapeHtml(meta.title || '页面预览')
  const count = variants.length
  const payload = JSON.stringify(
    variants.map((v) => ({
      dir: v.dir,
      label: v.label,
      width: v.width || 375,
      // 有 design.png / contrast 时导航进对比页；否则进一比一预览
      page: v.hasContrastHtml ? 'contrast.html' : 'index.html',
    })),
  )

  const navItems = variants
    .map(
      (v, i) =>
        `<button type="button" class="nav-item${i === 0 ? ' active' : ''}"` +
        ` data-index="${i}" data-dir="${escapeHtml(v.dir)}">` +
        `<span class="nav-label">${escapeHtml(v.label)}</span>` +
        `<span class="nav-dir">${escapeHtml(v.dir)}/</span>` +
        `</button>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · ${count} 个形态</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
        "Noto Sans SC", system-ui, sans-serif;
      background: #0d0d0d;
      color: #e8e8e8;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .router-bar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 20px;
      border-bottom: 1px solid rgba(255,255,255,.08);
      background: #141414;
    }
    .router-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .router-meta {
      font-size: 12px;
      opacity: 0.5;
      white-space: nowrap;
    }
    .router-open {
      font-size: 12px;
      color: #41b8f4;
      text-decoration: none;
      white-space: nowrap;
    }
    .router-open:hover { text-decoration: underline; }
    .router-body {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .router-nav {
      flex-shrink: 0;
      width: 220px;
      overflow-y: auto;
      border-right: 1px solid rgba(255,255,255,.08);
      background: #111;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
      transition: background .15s;
    }
    .nav-item:hover { background: rgba(255,255,255,.06); }
    .nav-item.active {
      background: rgba(65,184,244,.15);
      color: #41b8f4;
    }
    .nav-label {
      font-size: 13px;
      font-weight: 500;
      line-height: 1.3;
      word-break: break-word;
    }
    .nav-dir {
      font-size: 11px;
      opacity: 0.45;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .router-preview {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 8px 12px 12px;
      overflow: hidden;
      background: #0a0a0a;
    }
    .preview-hint {
      flex-shrink: 0;
      font-size: 12px;
      opacity: 0.45;
      margin-bottom: 8px;
      text-align: center;
    }
    .preview-frame-wrap {
      flex: 1;
      min-height: 0;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,.35);
      background: #111;
      overflow: hidden;
      border-radius: 8px;
    }
    .preview-frame-wrap iframe {
      display: block;
      border: none;
      width: 100%;
      height: 100%;
      background: #0d0d0d;
    }
    @media (max-width: 720px) {
      .router-body { flex-direction: column; }
      .router-nav {
        width: 100%;
        flex-direction: row;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        border-right: none;
        border-bottom: 1px solid rgba(255,255,255,.08);
        flex-shrink: 0;
        max-height: 120px;
      }
      .nav-item { flex-shrink: 0; min-width: 140px; }
      .router-preview { padding: 8px; }
    }
  </style>
</head>
<body>
  <header class="router-bar">
    <div class="router-title">${title}</div>
    <div class="router-meta">${count} 个形态 · Figma Export</div>
    <a class="router-open" id="open-tab" href="#" target="_blank" rel="noopener">新标签打开</a>
  </header>
  <div class="router-body">
    <nav class="router-nav" aria-label="页面形态">${navItems}</nav>
    <main class="router-preview">
      <p class="preview-hint" id="preview-hint"></p>
      <div class="preview-frame-wrap" id="frame-wrap">
        <iframe id="preview" title="页面预览"></iframe>
      </div>
    </main>
  </div>
  <script>
(function () {
  var variants = ${payload}
  var nav = document.querySelector('.router-nav')
  var iframe = document.getElementById('preview')
  var hint = document.getElementById('preview-hint')
  var openTab = document.getElementById('open-tab')
  var active = 0

  function pageFile(v) {
    return v.page || 'index.html'
  }

  function pageSrc(v) {
    return v.dir + '/' + pageFile(v)
  }

  function setActive(index) {
    if (index < 0 || index >= variants.length) return
    active = index
    var v = variants[index]
    var src = pageSrc(v)
    iframe.src = src
    openTab.href = src
    hint.textContent = v.label + ' · ' + v.dir + '/' + pageFile(v)
    nav.querySelectorAll('.nav-item').forEach(function (btn, i) {
      btn.classList.toggle('active', i === index)
    })
    try { history.replaceState(null, '', '#' + encodeURIComponent(v.dir)) } catch (e) {}
  }

  nav.addEventListener('click', function (e) {
    var btn = e.target.closest('.nav-item')
    if (!btn) return
    setActive(Number(btn.getAttribute('data-index')))
  })

  var hash = location.hash.slice(1)
  if (hash) {
    try {
      var decoded = decodeURIComponent(hash)
      var idx = variants.findIndex(function (v) { return v.dir === decoded })
      if (idx >= 0) active = idx
    } catch (e) {}
  }
  setActive(active)
})()
  </script>
</body>
</html>`
}

/**
 * 为单个根节点生成 ZIP 条目（可带 outputPrefix 放入子目录）。
 */
async function buildZipEntriesForData(data, options = {}) {
  const outputPrefix = options.outputPrefix || ''
  const allImages = data.images || {}
  const usedKeys = collectHtmlUsedImageKeys(data.nodes)
  const images = pickImageAssets(allImages, usedKeys)
  const exportables = Object.entries(images).filter(
    ([, asset]) => asset?.dataUrl && !asset.error,
  )
  const prunedCount = Object.keys(allImages).length - Object.keys(images).length

  const hashToPath = {}
  const vectorIdToPath = {}
  const zipFiles = []
  let index = 0
  const variantLabel = data.nodes?.[0]?.name || 'export'

  for (const [hash, asset] of exportables) {
    index += 1
    if (options.onProgress) {
      options.onProgress(
        `${variantLabel}：打包图片 ${index}/${exportables.length}…` +
          (prunedCount > 0 ? `（已跳过 ${prunedCount} 张未引用）` : ''),
      )
    }
    const pngBytes = await dataUrlToPngBytes(asset.dataUrl)
    const safeKey = hash.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)
    const rel = `${outputPrefix}images/${String(index).padStart(3, '0')}_${safeKey}.png`
    hashToPath[hash] = rel
    zipFiles.push({name: rel, data: pngBytes})
  }

  const encoder = new TextEncoder()
  const {svgs: svgPool, nodeIdToRef} = poolSvgAssets(data.nodes)
  const svgEntries = Object.entries(svgPool)
  const svgRefToPath = {}
  let svgIndex = 0
  for (const [key, asset] of svgEntries) {
    svgIndex += 1
    if (options.onProgress) {
      options.onProgress(
        `${variantLabel}：打包 SVG ${svgIndex}/${svgEntries.length}…`,
      )
    }
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)
    const rel = `${outputPrefix}svgs/${String(svgIndex).padStart(3, '0')}_${safeKey}.svg`
    svgRefToPath[key] = rel
    zipFiles.push({name: rel, data: encoder.encode(asset.source)})
  }

  function walkVectors(nodes) {
    for (const n of nodes || []) {
      if (n.visible === false) continue
      if (n.pngRef) {
        vectorIdToPath[n.id] = resolveAssetPath(images, hashToPath, n.pngRef)
      }
      if (n.children?.length && !n.flattened) walkVectors(n.children)
    }
  }
  walkVectors(data.nodes)

  const designPreview = options.designPreview
  let designSrc = null
  if (designPreview?.base64) {
    if (options.onProgress) {
      options.onProgress(`${variantLabel}：打包原稿 PNG…`)
    }
    const designBytes = base64ToBytes(designPreview.base64)
    designSrc = `${outputPrefix}design.png`
    zipFiles.push({name: designSrc, data: designBytes})
  }

  if (options.onProgress) {
    options.onProgress(`${variantLabel}：生成 index.html…`)
  }
  const prunedData = {...data, images, imageCount: exportables.length}
  const designSrcForHtml = assetPathInVariant(designSrc, outputPrefix)
  const {html, contrastHtml, rootName} = generateHtmlDocument(prunedData, {
    sourceLabel: 'plugin-zip',
    imageMode: 'external',
    imageSrcForHash: (hash) =>
      assetPathInVariant(
        resolveAssetPath(images, hashToPath, hash),
        outputPrefix,
      ),
    vectorSrcForId: (id) =>
      assetPathInVariant(vectorIdToPath[id], outputPrefix),
    svgSrcForId: (id) => {
      const ref = nodeIdToRef[id]
      return assetPathInVariant(ref ? svgRefToPath[ref] : null, outputPrefix)
    },
    compareDesignSrc: designSrcForHtml,
  })

  zipFiles.push({
    name: `${outputPrefix}index.html`,
    data: encoder.encode(html),
  })

  if (contrastHtml) {
    if (options.onProgress) {
      options.onProgress(`${variantLabel}：生成 contrast.html…`)
    }
    zipFiles.push({
      name: `${outputPrefix}contrast.html`,
      data: encoder.encode(contrastHtml),
    })
  }

  if (options.onProgress) {
    options.onProgress(`${variantLabel}：生成 JSON…`)
  }
  const jsonPayload = buildZipJsonPayload(
    prunedData,
    images,
    hashToPath,
    outputPrefix,
    {svgs: svgPool, svgRefToPath, nodeIdToRef},
  )
  if (designSrcForHtml) {
    jsonPayload.designPreview = {
      path: designSrcForHtml,
      scale: designPreview.scale || 2,
      nodeId: designPreview.nodeId,
      nodeName: designPreview.nodeName,
    }
  }
  const jsonName = `${sanitizeFilename(jsonPayload.nodes?.[0]?.name, rootName)}.json`
  zipFiles.push({
    name: `${outputPrefix}${jsonName}`,
    // ZIP 内用紧凑 JSON，避免 indent 空白把体积放大约 2～3 倍
    data: encoder.encode(JSON.stringify(jsonPayload)),
  })

  const schemaDocName = `${sanitizeFilename(
    jsonPayload.nodes?.[0]?.name,
    rootName,
  )}.md`
  if (options.onProgress) {
    options.onProgress(`${variantLabel}：生成说明文档…`)
  }
  zipFiles.push({
    name: `${outputPrefix}${schemaDocName}`,
    data: encoder.encode(getNodeJsonSchemaDoc()),
  })

  return {
    zipFiles,
    rootName,
    jsonFilename: jsonName,
    schemaDocFilename: schemaDocName,
    imageCount: exportables.length,
    svgCount: svgEntries.length,
    prunedImageCount: Math.max(0, prunedCount),
    hasDesignPreview: Boolean(designSrc),
    hasContrastHtml: Boolean(contrastHtml),
  }
}

async function exportHtmlZip(data, onProgress, options = {}) {
  const built = await buildZipEntriesForData(data, {...options, onProgress})
  if (onProgress) onProgress('打包 ZIP…')
  const zipBytes = createZipStore(built.zipFiles)
  const filename = `${sanitizeFilename(built.rootName, 'preview')}-html.zip`
  downloadBlob(filename, new Blob([zipBytes], {type: 'application/zip'}))
  return {
    filename,
    jsonFilename: built.jsonFilename,
    imageCount: built.imageCount,
    svgCount: built.svgCount,
    prunedImageCount: built.prunedImageCount,
    hasDesignPreview: built.hasDesignPreview,
    variantCount: 1,
  }
}

/**
 * 多选根节点：每个形态一个子目录，打成一个 ZIP。
 * @param {object} data 完整 inspect 结果（含多个 nodes）
 * @param {Record<string, object>} [designPreviewsByNodeId] nodeId → design preview file
 */
async function exportHtmlZipBatch(data, onProgress, options = {}) {
  const roots = data?.nodes || []
  if (!roots.length) throw new Error('没有可导出的节点')
  if (roots.length === 1) {
    return exportHtmlZip(sliceDataForNode(data, roots[0].id), onProgress, {
      ...options,
      designPreview: options.designPreviewsByNodeId?.[roots[0].id],
    })
  }

  const previews = options.designPreviewsByNodeId || {}
  const usedDirs = new Set()
  const allZipFiles = []
  const variantEntries = []
  let totalImages = 0
  let totalSvgs = 0
  let totalPruned = 0
  let previewCount = 0

  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i]
    if (onProgress) {
      onProgress(`形态 ${i + 1}/${roots.length}：${root.name || root.id}…`)
    }
    const sliced = sliceDataForNode(data, root.id)
    const dirName = makeUniqueDirName(root.name, usedDirs)
    const built = await buildZipEntriesForData(sliced, {
      ...options,
      outputPrefix: `${dirName}/`,
      designPreview: previews[root.id],
      onProgress,
    })
    variantEntries.push({
      dir: dirName,
      label: root.name || root.id,
      width: root.layout?.width || 375,
      hasContrastHtml: Boolean(built.hasContrastHtml),
    })
    allZipFiles.push(...built.zipFiles)
    totalImages += built.imageCount
    totalSvgs += built.svgCount || 0
    totalPruned += built.prunedImageCount
    if (built.hasDesignPreview) previewCount += 1
  }

  if (onProgress) onProgress('生成导航页…')
  const encoder = new TextEncoder()
  allZipFiles.unshift({
    name: 'index.html',
    data: encoder.encode(
      buildBatchRouterHtml(variantEntries, {title: data.page}),
    ),
  })

  if (onProgress) onProgress('打包 ZIP…')
  const zipBytes = createZipStore(allZipFiles)
  const pageLabel = sanitizeFilename(data.page, 'page')
  const filename = `${pageLabel}-${roots.length}variants-html.zip`
  downloadBlob(filename, new Blob([zipBytes], {type: 'application/zip'}))
  return {
    filename,
    variantCount: roots.length,
    imageCount: totalImages,
    svgCount: totalSvgs,
    prunedImageCount: totalPruned,
    hasDesignPreview: previewCount > 0,
    designPreviewCount: previewCount,
  }
}

const api = {
  exportJson,
  exportJsonSchemaDoc,
  buildHtmlDocument,
  exportHtmlInline,
  exportHtmlZip,
  exportHtmlZipBatch,
  downloadExportedImageFiles,
  attachListsToData,
  sliceDataForNode,
}

export default api

if (typeof window !== 'undefined') {
  window.FigmaExport = api
}
