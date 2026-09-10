/**
 * Node Inspector 导出 JSON 的结构说明（给人读 / 给 AI 做上下文）。
 * 单一来源：插件「JSON 说明」、exportJson 附带文件、docs/ 均可由此生成。
 */

export const NODE_JSON_SCHEMA_DOC_VERSION = '1.0.9'

export function getNodeJsonSchemaDoc() {
  return `# Node Inspector — 导出 JSON 结构说明

> 版本：${NODE_JSON_SCHEMA_DOC_VERSION}（本说明文档版本；与 \`package.json\` 插件版本号独立）
> 用途：说明插件导出的节点 JSON 字段含义与约定，便于二次开发、HTML 生成，以及作为 AI 分析/改写的上下文。

## 1. 文档与数据的关系

- 本说明描述的是**插件导出的 JSON 文件**（或剪贴板中的同构对象），不是 Figma REST API 原始响应。
- 数据由画布选区递归序列化得到；图片以 Data URL 或去重池引用形式内嵌。
- 生成侧脚本（\`generate-html\`）消费同一套结构。
- **插件 inspect**（\`code.ts\`）产出核心树与 \`images\`；**导出侧**（\`ui/export-api.mjs\`）在写 JSON/ZIP 时可能再附加 \`lists\`、\`svgs\`、\`designPreview\`、\`{name}.md\` 说明文档等。

## 2. 顶层对象（Root）

### 2.1 插件序列化始终包含

| 字段 | 类型 | 说明 |
|------|------|------|
| \`page\` | string | 当前 Figma 页面名 |
| \`selectedCount\` | number | 画布选区根节点数量 |
| \`totalNodeCount\` | number | 序列化后的节点总数（含子层） |
| \`imageCount\` | number | \`images\` 池中可用唯一图数量 |
| \`imageExportScale\` | number | 矢量/标记切图倍率（与插件「图片导出」配置一致；默认 **2**） |
| \`imageFillRefCount\` | number | 填充/描边中 IMAGE 引用次数 |
| \`imageFillUniqueCount\` | number | 填充图按像素去重后的唯一份数（\`hashes.length - mergedFillDupes\`） |
| \`imageMergedDuplicateCount\` | number | 因像素相同被合并的填充图数量 |
| \`vectorPngRefCount\` | number | 节点上 \`pngRef\` 引用次数 |
| \`vectorPngUniqueCount\` | number | 矢量 PNG 唯一份数 |
| \`svgCount\` / \`svgErrorCount\` | number | 成功/失败的 SVG 导出数 |
| \`pngCount\` / \`pngErrorCount\` | number | 成功/失败的矢量 PNG 数 |
| \`exportAsImageCount\` | number | 用户标记「按图片导出」的节点数 |
| \`htmlLayoutWarningCount\` | number | HTML 无法自动还原的布局标记数（如布尔减挖空） |
| \`htmlLayoutWarnings\` | object[]? | 需人工处理的布局清单（见 §3.3） |
| \`fontCount\` | number | \`fonts\` 数组长度 |
| \`fonts\` | FontRef[] | 去重后的字体列表 |
| \`images\` | Record<string, ImageAsset> | 图片资产池（见 §5） |
| \`nodes\` | NodeInfo[] | 根节点数组；每个元素是一棵树 |

### 2.2 仅导出侧附加

| 字段 | 类型 | 说明 |
|------|------|------|
| \`lists\` / \`listCount\` | ListMeta[] / number | **JSON / ZIP 导出时**由 \`attachListsToData\`（\`detect-lists.mjs\`）附加；插件内存 inspect 结果通常无此字段 |
| \`svgs\` | Record<string, SvgAsset>? | **ZIP** 的 SVG 文件池（见 §5.1）；纯 JSON 导出通常无此字段（SVG 仍内联在节点 \`svg\`） |
| \`svgFileCount\` | number? | \`svgs\` 池条目数（ZIP） |
| \`designPreview\` | object? | **ZIP 且含原稿对比**时：\`{path, scale, nodeId?, nodeName?}\`，\`path\` 多为 \`design.png\`。此时 ZIP 另含 \`contrast.html\`（对比页）；\`index.html\` 仍为一比一样式预览 |

**AI / 处理建议：** 先读 \`nodes[0]\` 作为主树；用 \`images\` 解析 \`pngRef\` / \`imageHash\`；忽略失败字段（\`*Error\`）除非在做诊断。

## 3. 节点 NodeInfo（递归）

每个节点至少包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| \`id\` | string | Figma 节点 ID（如 \`3370:2152\`） |
| \`name\` | string | 图层名 |
| \`type\` | string | Figma 类型：\`FRAME\` \`GROUP\` \`TEXT\` \`VECTOR\` \`INSTANCE\` \`BOOLEAN_OPERATION\` 等 |
| \`visible\` | boolean | 是否可见。\`false\` 时插件树仍可能保留该节点（便于管理），**HTML 生成应跳过**；隐藏节点 \`styles\` 为空且不导出资源 |
| \`locked\` | boolean | 是否锁定 |
| \`childCount\` | number | 子节点数量 |
| \`children\` | NodeInfo[]? | 子树；无子或已 \`flattened\` / \`exportAsImage\` 栅格化成功时可能缺省 |
| \`layout\` | object | 布局（见 §4） |
| \`styles\` | object | 样式（见 §6） |

### 3.1 可选视觉 / 导出字段

| 字段 | 说明 |
|------|------|
| \`opacity\` | 0–1 |
| \`blendMode\` | 混合模式字符串 |
| \`clipsContent\` | 是否裁剪溢出（≈ CSS \`overflow: hidden\`） |
| \`svg\` | SVG 字符串（矢量导出成功时；**纯 JSON / 插件内存**内联。ZIP 打包时外置为文件，见 \`svgRef\`） |
| \`svgRef\` | 指向顶层 \`svgs\` 的 key（如 \`s:a1b2c3d4\`）；**ZIP JSON** 使用，此时无内联 \`svg\` |
| \`svgError\` | SVG 导出失败原因 |
| \`png\` | PNG Data URL（未入池时的内联图） |
| \`pngRef\` | 指向顶层 \`images\` 的 key（如 \`v:505e504f\`、Instance 逻辑键 \`v:c…\`，或填充 hash） |
| \`pngError\` / \`pngByteLength\` | PNG 失败信息 / 字节数 |
| \`flattened\` | \`true\`：整颗视觉已烘焙为单图（含矢量切图成功）。生成侧**勿展开** \`children\`；若同时有 \`png\`/\`pngRef\`，旋转等变换已进像素，**勿再叠 CSS \`rotate\`** |
| \`exportAsImage\` | 用户标记按图片导出（节点 \`pluginData\`）；生成侧应输出 \`<img>\` |
| \`skipImageBake\` | 用户标记为非图片：跳过自动切图策略，展开子层 / CSS 还原 |
| \`exportInspectMode\` | Inspect 切图：\`full\`（宽 ≤ 页面宽，完整导出，layout 保留节点盒）/ \`cropped\`（宽 > 页面宽，原位裁切，layout 对齐 PNG） |
| \`booleanOperation\` | 仅 \`BOOLEAN_OPERATION\`：\`UNION\` / \`INTERSECT\` / \`SUBTRACT\` / \`EXCLUDE\` |
| \`htmlLayoutWarning\` | HTML 不支持的布局标记（见 §3.3）；生成 HTML 时应显著标注 |
| \`component\` | Instance 信息：\`isInstance\`、\`mainComponentName\`、\`mainComponentId\`、\`variantProperties\` |

### 3.2 坐标与 GROUP 约定

Figma 的 \`GROUP\` / \`BOOLEAN_OPERATION\` 与 \`FRAME\` 不同：子节点 \`layout.x/y\` **不是**相对父左上角，而是与父节点处在**同一画布坐标空间**。

\`x/y\` 保留 Figma 本地语义（见下表），**不要改、也不要假定它总是相对父盒**。新代码优先用归一化字段，不必再背「减不减父」：

| 字段 | 坐标系 | 用途 |
|------|--------|------|
| \`x\` \`y\` | Figma 本地（GROUP/BOOLEAN 未烘焙时与父同空间） | 兼容旧生成器；**不要**直接当 CSS \`left/top\` |
| \`parentX\` \`parentY\` | **始终**相对直接父盒；根为 \`0,0\` | 写 \`position:absolute\` 的 \`left/top\` |
| \`rootX\` \`rootY\` | 相对选区根（\`nodes[0]\`）左上角；根为 \`0,0\` | 钉位、对稿、截图裁区域 |

若必须从 \`x/y\` 自己换算（旧 JSON 无 \`parentX\`）：

| 节点状态 | 换算方式 |
|----------|----------|
| 普通父子（父非 GROUP/BOOLEAN） | 直接用 \`layout.x/y\` |
| GROUP/BOOLEAN 子节点，**未烘焙** | \`left = 子.x − 父.x\`，\`top = 子.y − 父.y\`（减的是父级**原点坐标**，不是布尔运算） |
| **已烘焙**（\`layout.bakedVisual\`，或已有 \`flattened\` / \`png\` / \`pngRef\` / \`svg\`） | 插件导出时已做过上述换算；**勿重复减父.x/父.y**，否则位置会偏 |

\`layout.bakedVisual === true\` 表示 layout 已按 \`absoluteBoundingBox\`（及切图像素）对齐。此时切图/像素里已含旋转，**勿再写 CSS \`transform: rotate()\`**。

> **术语提示：** 文档里的「减父级原点 / 减父.x」均指导出 GROUP 子节点时的**坐标换算**；与 \`BOOLEAN_OPERATION\` 的布尔**相减**（§3.3）、或 Auto Layout 里「padding 减描边宽」（§4）不是同一概念。

### 3.3 HTML 不支持的布局（\`htmlLayoutWarning\`）

Figma 布尔减（区域挖空、透视下层）等效果 **HTML/CSS 无等价实现**。插件对「大尺寸 Subtract（≥2 子层）」写入 \`htmlLayoutWarning\`（含 \`kind\` / \`message\` / \`suggestion\` / \`htmlSupported: false\`）。顶层 \`htmlLayoutWarnings[]\` 为扁平索引。HTML 侧对应 \`data-html-layout-warning\` 等属性。

## 4. layout

| 字段 | 说明 |
|------|------|
| \`x\` \`y\` \`width\` \`height\` | 位置与尺寸（px）。\`x/y\` 为 Figma 本地坐标（见 §3.2），语义不统一 |
| \`parentX\` \`parentY\` | **始终**相对直接父盒（px）。根为 \`0,0\`。写 CSS \`left/top\` 用这对字段，不必再按 baked / GROUP 分支减父 |
| \`rootX\` \`rootY\` | 相对选区根（\`nodes[0]\`）左上角（px）。根为 \`0,0\`。钉位/对稿用；**不要**当父级 \`left/top\` |
| \`rotation\` | Figma 角度（Plugin API，Y 向下时正角逆时针）。写 CSS \`rotate()\` 时取反。\`exportAsync\` 切图已含旋转，烘焙后清除。位图填充+旋转在导出侧会自动切图 |
| \`bakedVisual\` | 见 §3.2。为 \`true\` 时 layout 已是相对父盒偏移 + 切图对齐尺寸；切图像素已含旋转 → **勿重复减父.x/父.y**，**勿 CSS \`rotate\`** |
| \`constraints\` | 约束 \`{horizontal, vertical}\` |
| \`layoutMode\` | \`HORIZONTAL\` / \`VERTICAL\` → flex 方向 |
| \`primaryAxisAlignItems\` / \`counterAxisAlignItems\` | 主轴/交叉轴对齐 |
| \`primaryAxisSizingMode\` / \`counterAxisSizingMode\` | 轴尺寸模式 |
| \`padding\` | \`{top,right,bottom,left}\` |
| \`strokesIncludedInLayout\` | Auto Layout：描边是否计入布局；\`false\` 时 Figma 描边与 padding 区域重叠 → HTML 保留 \`border\`，**padding 各边减去 \`strokeWeight\`**（此处「减」指导 CSS 数值调整，见 §3.2 术语提示） |
| \`itemSpacing\` | 间距（SPACE_BETWEEN 时生成侧通常不写 gap） |
| \`layoutWrap\` | \`NO_WRAP\` / \`WRAP\` |
| \`counterAxisSpacing\` / \`counterAxisAlignContent\` | 换行相关 |
| \`layoutGrow\` \`layoutAlign\` \`layoutPositioning\` | flex 子项 / \`ABSOLUTE\` |

## 5. images 资产池

\`images\` 是 \`hash → ImageAsset\` 映射。

| ImageAsset 字段 | 说明 |
|-----------------|------|
| \`mime\` | 如 \`image/png\` |
| \`dataUrl\` | \`data:image/…;base64,…\`（插件内存 / 纯 JSON） |
| \`path\` | ZIP 内相对路径（如 \`images/001_….png\`）；有 \`path\` 时通常无 \`dataUrl\` |
| \`byteLength\` | 字节数 |
| \`contentHash\` | 像素内容指纹；填充图去重与矢量键均可能使用 |
| \`error\` | 导出失败时存在 |
| \`source\` | \`fill\` / \`vector\` / \`marked\` 等来源提示 |
| \`refCount\` | 被引用次数 |
| \`duplicateOf\` | 像素相同合并后，指向主 key；解析时需跟随链到真正含 \`dataUrl\`/\`path\` 的项 |

**解析顺序：** 节点 \`pngRef\` 或 fill \`imageHash\` → 查 \`images[key]\` → 若有 \`duplicateOf\` 则继续 → 取 \`dataUrl\`（或 ZIP 中的 \`path\`）。

**去重约定：** 填充图按 \`contentHash\` 合并为 \`duplicateOf\`；矢量 PNG 键以 \`v:\` 开头（Instance 用 \`v:c\` + 主组件 id + 归一化尺寸），**不参与**填充那套像素合并。

### 5.1 svgs 资产池（ZIP）

ZIP 导出时，节点内联 \`svg\` 会按内容 hash 去重写入 \`svgs/\` 目录，JSON 改为引用：

| SvgAsset 字段 | 说明 |
|---------------|------|
| \`mime\` | \`image/svg+xml\` |
| \`path\` | 相对 JSON / \`index.html\` / \`contrast.html\` 的路径，如 \`svgs/001_s_a1b2c3d4.svg\` |
| \`byteLength\` | 字节数 |
| \`contentHash\` | 内容指纹（FNV-1a hex）；池 key 形如 \`s:<contentHash>\` |
| \`source\` | 通常 \`vector\` |
| \`refCount\` | 被引用次数 |

**解析：** 节点 \`svgRef\` → \`svgs[key].path\` → 读文件或 HTML \`<img src>\`。插件内存 / 单独导出 JSON 时仍可能只有内联 \`svg\`，无 \`svgs\` 池。ZIP 内 JSON 为**紧凑无 indent**；已烘焙节点上的 IMAGE fill/stroke 可能被 strip。

## 6. styles

### 6.1 Paint（fills / strokes 元素）

| type | 主要字段 |
|------|----------|
| \`SOLID\` | \`color\`（#RGB/#RGBA）、\`opacity\`、\`visible\`、\`blendMode\` |
| \`GRADIENT_LINEAR\` / \`GRADIENT_RADIAL\` / \`GRADIENT_ANGULAR\` / \`GRADIENT_DIAMOND\` | \`stops[{position,color}]\`、\`gradientTransform\`；仅 **LINEAR** 另有 \`cssAngle\` 近似 |
| \`IMAGE\` | \`imageHash\`、\`scaleMode\`、\`imageTransform\`、\`rotation\`、\`scalingFactor\` 等 |

另有：\`strokeWeight\` \`strokeAlign\` \`strokeDashes\`、圆角 \`cornerRadius\` 或四角半径、\`effects\`，以及绑定样式：

- ID：\`fillStyleId\` / \`strokeStyleId\` / \`effectStyleId\` / \`textStyleId\`
- 名：\`fillStyleName\` / \`strokeStyleName\` / \`effectStyleName\` / \`textStyleName\`

### 6.2 Effect

常见：\`DROP_SHADOW\` \`INNER_SHADOW\` \`LAYER_BLUR\` \`BACKGROUND_BLUR\`；含 \`visible\` \`radius\` \`color\` \`offset\` \`spread\` \`blendMode\`。

切 PNG 时清空外阴影/模糊，保留 \`INNER_SHADOW\` 烘焙进像素（CSS \`inset\` 对 \`<img>\` 无效）；切 SVG 仍清空全部 effects。full 切图对 Outside/Center 描边扩 wrapper。外阴影：有实色/渐变背景时用 CSS \`box-shadow\`；透明 Group / 文字 / 切图用 \`filter: drop-shadow\`。有 \`png\`/\`pngRef\` 时 HTML 跳过 inset 与 \`border-radius\`。子层相对根 AABB 负向溢出时，生成 HTML 扩根画布并平移，避免对比框裁切描边。

### 6.3 text（TEXT 节点）

| 字段 | 说明 |
|------|------|
| \`characters\` | 文案 |
| \`segments\` | 字符级分段（混色等）；含 \`characters\` \`start\` \`end\` \`fills\`，以及可选 \`fontSize\` / \`fontName\` / \`fontWeight\`。整段 \`fills\` 为 mixed 时节点级 \`styles.fills\` 为空，以本字段为准 |
| \`fontSize\` \`fontWeight\` \`fontName{family,style}\` | 字体。序列化时 \`fontWeight\` **下限钳到 400**（PingFang SC Regular 等在 Figma 常报 300）；与顶层 \`fonts[].weight\`、生成侧 CSS 一致 |
| \`textAlignHorizontal\` / \`textAlignVertical\` | 对齐 |
| \`letterSpacing\` \`lineHeight\` | 字距/行高。\`lineHeight\` 为 \`{unit,value?}\`（\`PIXELS\` / \`PERCENT\` / \`AUTO\`）或 \`mixed\` |
| \`lineHeightPx\` | 仅当 \`lineHeight.unit === 'AUTO'\`（或 mixed 且可估算）时写入：插件用单行文案探针测得的像素行高（见下） |
| \`textCase\` \`textDecoration\` | 大小写/装饰 |
| \`textAutoResize\` | \`NONE\` / \`WIDTH_AND_HEIGHT\` / \`HEIGHT\` / \`TRUNCATE\` |
| \`textTruncation\` | \`DISABLED\` / \`ENDING\` |
| \`maxLines\` | 最大行数（截断时） |

**\`AUTO\` → \`lineHeightPx\`（插件测量 + 生成回退）：**

1. **插件（首选）**：克隆文本节点，设 \`WIDTH_AND_HEIGHT\` 并写入单字（原文首个非空白字符，否则 \`H\`），读盒高写入 \`lineHeightPx\`。
2. 测量失败时回退：单行 \`WIDTH_AND_HEIGHT\` → \`layout.height\`；含 \`\\n\` → \`height / 行数\`；定宽换行 → 在 \`[fontSize, fontSize×1.5]\` 内找能整除盒高的整数行高（优先最接近 \`fontSize×1.2\`）。
3. 生成 HTML 时对 \`AUTO\` **优先用 \`lineHeightPx\`**；若其≈多行 \`layout.height\`（探针未重排）或卡在 \`fontSize×1.2\` 且与整除反推不一致，改用盒高反推。

## 7. fonts

\`fonts[]\` 项大致为：

\`\`\`json
{ "family": "Poetsen One", "style": "Regular", "weight": 400, "provider": "google" }
\`\`\`

| 字段 | 说明 |
|------|------|
| \`family\` / \`style\` | Figma \`fontName\` |
| \`weight\` | 数字字重；与节点 \`fontWeight\` 相同规则，**下限 400** |
| \`provider\` | \`google\` \\| \`system\` \\| \`unknown\` |

生成 HTML 时：\`google\` 可外链 Google Fonts（\`wght\` 同样按下限 400 聚合）；系统字体勿外链。未命中内置 Google 映射且非系统字 → \`unknown\`。

## 8. 生成代码时的优先规则（摘要）

1. \`visible === false\` → 不输出 DOM。
2. 有可用 PNG（\`png\` / \`pngRef\` 能解析到 dataUrl 或 path）→ \`<img>\`，尺寸用 \`layout\`（HTML **优先 PNG**，再 SVG）。
3. 否则若有 \`svgRef\`（\`svgs[key].path\`）→ \`<img src="….svg">\`；若有内联 \`svg\` → 内联 SVG。
4. \`exportAsImage\` / \`flattened\` → 不要展开 \`children\`。
5. \`TEXT\` → 文本标签 + \`styles.text\`；有 \`segments\`（长度>1）时按段输出带色 \`span\`；注意多行与截断。\`font-weight\` 直接用 JSON 中已钳制的 \`fontWeight\`（≥400）。
6. 行高：\`PIXELS\` / \`PERCENT\` 直接换算；\`AUTO\` 优先 \`lineHeightPx\`（插件单行探针），若其≈多行盒高或卡在 \`fontSize×1.2\` 则按 §6.3 用 \`layout.height\` 反推。
7. 有 \`layoutMode\` → flex；子项 \`layoutPositioning === 'ABSOLUTE'\` 或父非 auto-layout → 绝对定位。
8. 绝对定位：优先 \`layout.parentX/parentY\` 作 CSS \`left/top\`。旧 JSON 无此字段时再按 §3.2 从 \`x/y\` 换算（已烘焙**勿重复减父**）。\`rootX/rootY\` 仅作根坐标系参考。
9. 有 \`lists\` 时 HTML 可为列表项加 \`data-list\` / \`data-list-item\` / \`data-slot\`。
10. 含 \`design.png\` 的 ZIP 同时产出两份 HTML：**\`index.html\`** 一比一样式预览（无对比 UI）；**\`contrast.html\`** 负责 HTML vs 原稿（并排 / 叠层 / 仅 HTML / 仅原稿）。长度单位固定为 **px**。关闭「ZIP 含原稿对比」则只有 \`index.html\`。
11. 含 \`htmlLayoutWarning\` 的节点：HTML 输出 \`data-html-layout-warning\` 等标记，**勿当作可直接上线的最终布局**；需按 \`suggestion\` 人工调层级或背景切图。
12. 有 \`png\`/\`pngRef\` 时：像素里已含 \`INNER_SHADOW\` 与圆角 → **勿再写** \`box-shadow: inset\` 或 \`border-radius\`（「勿再写」= 勿重复叠加，非坐标换算）；外阴影对切图/透明 Group/文字用 \`filter: drop-shadow\`，有背景的盒子仍可用 CSS \`box-shadow\`。
13. 子层盒相对根 AABB 负向溢出（外侧描边切图）：扩根画布并平移内容；对比页画布用扩后尺寸，但 \`design.png\` **按根帧宽度**对齐（勿拉满画布，否则长页会被放大）。
14. 未烘焙的 \`layout.rotation\` 是 Figma 角度（Y 向下正角逆时针）；写 CSS \`rotate()\` 时取反，绝对定位原点用 \`top left\`。
15. 渐变描边：CSS \`border-color\` 不支持 gradient。内侧描边输出 \`border: transparent\` + \`background-clip\`（填充 \`padding-box\`，描边 \`border-box\`）。
16. 行高 AUTO：\`lineHeightPx\` 若≈多行盒高（探针未重排），生成侧改用盒高反推，避免把整段高度写成 \`line-height\`。

## 9. 给 AI 的任务提示模板

将本说明与 JSON 一并提供时，可附加：

\`\`\`
你收到的是 Figma Node Inspector 导出 JSON。请：
1) 按「§8 生成规则」理解树与图片引用；
2) 不要臆造 JSON 中不存在的图层；
3) 隐藏节点（visible=false）不进入最终 UI；
4) flattened / exportAsImage 节点按单图处理；
5) 输出代码时优先语义化结构，样式对齐 layout/styles 数值；
6) 写 CSS left/top 用 layout.parentX/parentY；钉位/对稿用 rootX/rootY；不要直接用 x/y（GROUP/baked 语义不统一，见 §3.2）。
\`\`\`

## 10. 变更说明

字段可能随插件版本增减；以实际 JSON 为准。若某字段缺失，按可选处理，勿报错中断整树。

- **1.0.9**：对比页 \`design.png\` 按根帧宽度对齐（溢出画布不再拉伸原稿）；渐变描边用 \`background-clip\`；AUTO 行高在 \`lineHeightPx\`≈盒高时回退反推。
- **1.0.8**：每个节点 \`layout\` 增加 \`parentX\` / \`parentY\`（始终相对直接父盒，可直接当 CSS \`left/top\`）。\`x/y\` 旧语义不变。
- **1.0.7**：每个节点 \`layout\` 增加 \`rootX\` / \`rootY\`（相对选区根节点原点；根为 \`0,0\`）。
- **1.0.6**：未烘焙 \`layout.rotation\` 转 CSS \`rotate()\` 时取反（Figma 正角逆时针 ≠ CSS 正角顺时针）。
- **1.0.5**：澄清 §3.2「减父级原点」= GROUP 坐标换算（勿重复执行）；区分与布尔减、padding 减描边的不同「减」；统一「勿再叠 rotate / 勿再写 inset」等表述。
- **1.0.4**：ZIP 含原稿对比时同时产出 \`index.html\`（一比一样式预览）与 \`contrast.html\`（HTML vs \`design.png\`）；关闭对比则只有 \`index.html\`。ZIP 另附与 JSON 同名的 \`{name}.md\` 字段说明。
- **1.0.3**：\`fontWeight\` / \`fonts[].weight\` / CSS \`font-weight\` 统一下限 400；切 PNG 保留 \`INNER_SHADOW\` 烘焙进像素，有 \`png\`/\`pngRef\` 时 HTML 跳过 inset；烘焙图跳过 \`border-radius\`；透明 Group/文字/切图外阴影改 \`filter: drop-shadow\`；Outside 描边 full 切图扩盒；HTML 根画布按内容溢出扩容。
- **1.0.2**：说明文档版本与 \`package.json\` 插件版本独立编号。
- **1.0.1**：澄清 \`lists\`/\`designPreview\`/\`svgs\` 为导出侧附加；修正 \`imageFillUniqueCount\` 口径；补 \`contentHash\`/\`path\`、\`GRADIENT_ANGULAR|DIAMOND\`、\`scalingFactor\`、\`*StyleId\`、ZIP 紧凑 JSON 与对比强制 px。
- **行高 AUTO**：插件单行探针写入 \`lineHeightPx\`；生成侧优先采用；缺失时在 \`[fontSize, fontSize×1.5]\` 内整除反推。
- **ZIP SVG 外置**：ZIP 内 SVG 写入 \`svgs/*.svg\`，节点用 \`svgRef\` + 顶层 \`svgs\` 池；JSON 不再内联 \`svg\` 源码。
`
}

/** 默认下载文件名（须为 .md） */
export function getNodeJsonSchemaDocFilename(rootName) {
  const base = String(rootName || 'node-json')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return `${base || 'node-json'}.md`
}
