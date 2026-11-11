/**
 * 桥接面板：一个状态灯 + 一个开关。
 *
 * 刻意做得很小。Node Inspector 的主界面是检查树和导出，
 * 桥接只是附加通道，不该占据视觉重心。
 */

export type PanelStatus = {
  state: 'off' | 'connecting' | 'idle' | 'busy' | 'error'
  detail: string
  calls: number
  lastOp: string | null
}

const LABEL: Record<PanelStatus['state'], string> = {
  off: '关闭',
  connecting: '连接中',
  idle: '已连接',
  busy: '执行中',
  error: '未连接',
}

export const createBridgePanel = ({
  root,
  onToggle,
}: {
  root: HTMLElement
  onToggle: (next: boolean) => void
}) => {
  let enabled = false

  root.innerHTML = `
    <span class="ni-bridge-dot" data-state="off"></span>
    <span class="ni-bridge-text">Agent</span>
    <button type="button" class="ni-bridge-toggle" aria-pressed="false">
      开启
    </button>
  `

  const dot = root.querySelector('.ni-bridge-dot') as HTMLElement
  const text = root.querySelector('.ni-bridge-text') as HTMLElement
  const button = root.querySelector('.ni-bridge-toggle') as HTMLButtonElement

  button.addEventListener('click', () => {
    enabled = !enabled
    button.textContent = enabled ? '关闭' : '开启'
    button.setAttribute('aria-pressed', String(enabled))
    onToggle(enabled)
  })

  const render = (status: PanelStatus) => {
    dot.dataset.state = status.state
    const count = status.calls > 0 ? ` · ${status.calls}` : ''
    text.textContent = `Agent ${LABEL[status.state]}${count}`
    text.title = status.detail
  }

  render({state: 'off', detail: '未启用', calls: 0, lastOp: null})

  return {render}
}