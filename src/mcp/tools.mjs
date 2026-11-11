/**
 * 工具清单：MCP 与插件两侧的唯一真相来源。
 *
 * 每条声明同时决定三件事：
 *   name    MCP 里暴露的工具名（snake_case，符合 MCP 惯例）
 *   op      插件侧 handler 的键（camelCase，对应 ops/index.js）
 *   schema  入参校验契约
 *
 * 两侧不再各写一份名字，避免"工具名对不上 handler"这类静默失败。
 */

const nodeId = {type: 'string', description: 'Figma 节点 id，如 12:34'}
const hex = {type: 'string', description: '十六进制颜色，如 #1A2B3C'}
const str = (description) => ({type: 'string', description})
const num = (description) => ({type: 'number', description})
const bool = (description) => ({type: 'boolean', description})

const nodeIdList = {
  type: 'array',
  items: {type: 'string'},
  description: '同一父节点下的节点 id 列表',
}

const input = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
})

const paintList = {type: 'array', items: {type: ['string', 'object']}}

const defs = [
  {
    name: 'figma_status',
    op: 'getBridgeStatus',
    description: '检查 Figma 桥是否在线：hub 端口、插件连接、队列与在途请求',
    input: input(),
  },
  {
    name: 'figma_get_file_info',
    op: 'getFileInfo',
    description: '读取当前文件名、fileKey、当前页与页面列表',
    input: input(),
  },
  {
    name: 'figma_get_selection',
    op: 'getSelection',
    description: '读取画布当前选区的节点摘要（含布局盒）',
    input: input(),
  },
  {
    name: 'figma_get_page_tree',
    op: 'getPageTree',
    description: '读取页面层级树，depth 控制展开层数',
    input: input({
      depth: num('展开层数，0=只看顶层摘要，默认 1'),
      pageId: str('可选，指定页面 id；不传则当前页'),
    }),
  },
  {
    name: 'figma_get_node',
    op: 'getNode',
    description: '读取单个节点（含子树），depth 控制展开层数',
    input: input({nodeId, depth: num('展开层数，默认 2')}, ['nodeId']),
  },
  {
    name: 'figma_group_nodes',
    op: 'groupNodes',
    description: '把同一父节点下的若干图层分组。必须显式给 nodeIds',
    input: input(
      {
        nodeIds: nodeIdList,
        name: str('新组名称'),
        index: num('插入到父级第几个位置，默认最上层'),
      },
      ['nodeIds'],
    ),
  },
  {
    name: 'figma_ungroup',
    op: 'ungroup',
    description: '解组，子层回到父级',
    input: input({nodeId}, ['nodeId']),
  },
  {
    name: 'figma_reorder_nodes',
    op: 'reorderNodes',
    description:
      '调整层级。批量精确插入用 nodeIds+index（可选 parentId）；' +
        '单节点逐级移动用 nodeId+position',
    input: input({
      nodeIds: nodeIdList,
      nodeId: str('单节点模式下的目标节点'),
      parentId: str('目标父节点 id，默认沿用现有父节点'),
      index: num('插入位置，0 为最底层'),
      position: {
        type: 'string',
        enum: ['front', 'back', 'forward', 'backward'],
        description: 'front=最上层，back=最底层',
      },
    }),
  },
  {
    name: 'figma_rename_node',
    op: 'renameNode',
    description: '重命名节点',
    input: input({nodeId, name: str('新名称')}, ['nodeId', 'name']),
  },
  {
    name: 'figma_move_node',
    op: 'moveNode',
    description: '移动节点：改 x/y，或用 parentId 换父级',
    input: input(
      {
        nodeId,
        x: num('目标 x'),
        y: num('目标 y'),
        parentId: str('可选，移动到该父节点下'),
      },
      ['nodeId'],
    ),
  },
  {
    name: 'figma_create_frame',
    op: 'createFrame',
    description: '创建 Frame，可指定父级、名称、位置尺寸、底色、Auto Layout',
    input: input({
      parentId: str('父节点 id，默认当前页'),
      name: str('名称'),
      x: num('x'),
      y: num('y'),
      width: num('宽'),
      height: num('高'),
      fill: hex,
      layoutMode: {type: 'string', enum: ['NONE', 'HORIZONTAL', 'VERTICAL']},
    }),
  },
  {
    name: 'figma_create_rectangle',
    op: 'createRectangle',
    description: '创建矩形',
    input: input({
      parentId: str('父节点 id，默认当前页'),
      name: str('名称'),
      x: num('x'),
      y: num('y'),
      width: num('宽'),
      height: num('高'),
      fill: hex,
      cornerRadius: num('圆角'),
    }),
  },
  {
    name: 'figma_create_text',
    op: 'createText',
    description: '创建文本节点（自动加载可用字体）',
    input: input(
      {
        parentId: str('父节点 id，默认当前页'),
        text: str('文本内容'),
        fontFamily: str('字体族，默认 Inter'),
        fontStyle: str('字重样式，默认 Regular'),
        fontSize: num('字号，默认 14'),
        fill: hex,
        x: num('x'),
        y: num('y'),
      },
      ['text'],
    ),
  },
  {
    name: 'figma_clone_node',
    op: 'cloneNode',
    description: '克隆节点（含子树）',
    input: input(
      {
        nodeId,
        parentId: str('可选，克隆后挂到该父节点'),
        x: num('x'),
        y: num('y'),
      },
      ['nodeId'],
    ),
  },
  {
    name: 'figma_set_style',
    op: 'setStyle',
    description: '设置 fills/strokes/描边宽度/圆角/透明度/混合模式/effects',
    input: input(
      {
        nodeId,
        fills: paintList,
        strokes: paintList,
        strokeWeight: num('描边宽度'),
        cornerRadius: num('圆角'),
        opacity: num('0~1'),
        blendMode: str('混合模式，如 MULTIPLY'),
        effects: {type: 'array', items: {type: 'object'}},
      },
      ['nodeId'],
    ),
  },
  {
    name: 'figma_set_layout',
    op: 'setLayout',
    description: '设置位置尺寸、旋转、约束、Auto Layout',
    input: input(
      {
        nodeId,
        x: num('x'),
        y: num('y'),
        width: num('宽'),
        height: num('高'),
        rotation: num('旋转角度，逆时针为正'),
        layoutMode: {
          type: 'string',
          enum: ['NONE', 'HORIZONTAL', 'VERTICAL'],
        },
        padding: num('四边 padding'),
        itemSpacing: num('子项间距'),
        primaryAxisAlignItems: str('MIN/CENTER/MAX/SPACE_BETWEEN'),
        counterAxisAlignItems: str('MIN/CENTER/MAX/BASELINE'),
        constraints: {type: 'object', description: '{horizontal, vertical}'},
      },
      ['nodeId'],
    ),
  },
  {
    name: 'figma_set_visible',
    op: 'setVisible',
    description: '显示/隐藏节点',
    input: input({nodeId, visible: bool('true=显示')}, ['nodeId', 'visible']),
  },
  {
    name: 'figma_set_locked',
    op: 'setLocked',
    description: '锁定/解锁节点',
    input: input({nodeId, locked: bool('true=锁定')}, ['nodeId', 'locked']),
  },
  {
    name: 'figma_set_text',
    op: 'setText',
    description: '修改文本内容（自动加载字体）',
    input: input({nodeId, text: str('新文本')}, ['nodeId', 'text']),
  },
  {
    name: 'figma_delete_node',
    op: 'deleteNode',
    description: '删除节点（含子树），不可撤销',
    input: input({nodeId}, ['nodeId']),
  },
]

/** MCP 侧使用的工具描述 */
export const tools = defs.map(({name, description, input: inputSchema}) => ({
  name,
  description,
  inputSchema,
}))

/** MCP 工具名 → 插件 op 名 */
export const opOf = Object.fromEntries(defs.map((d) => [d.name, d.op]))

/** 插件 ops 注册表应有的键（用于一致性检查） */
export const opNames = defs
  .map((d) => d.op)
  .filter((op) => op !== 'getBridgeStatus')