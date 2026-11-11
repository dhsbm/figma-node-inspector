/**
 * UI 侧桥接入口（打包进 ui.html）。
 *
 * 与既有 window.onmessage 的关系：
 * 原文件是单点赋值，直接覆盖会破坏导出流程。
 * 所以这里采用「包装」：先保留原处理函数，再在同一个监听里转发桥接消息。
 */

import {createBridgeClient} from './client'
import {createBridgePanel} from './panel'

type PluginMessage = Record<string, unknown> & {type?: string}

const installBridge = () => {
  const root = document.getElementById('ni-bridge-root')
  if (!root) return

  const original = window.onmessage

  /** 导出进行中：轮询让路，避免和重活抢主线程 */
  let busyHint = false

  const client = createBridgeClient({
    post: (message) => {
      parent.postMessage({pluginMessage: message}, '*')
    },
    onChange: (status) => panel.render(status),
    shouldPause: () => busyHint,
  })

  const panel = createBridgePanel({
    root,
    onToggle: (next) => {
      if (next) client.start()
      else client.stop()
    },
  })

  /**
   * 先跑原处理，再处理桥接相关消息。
   * 用 try 隔离：桥接出错不能影响导出。
   */
  window.onmessage = function (event: MessageEvent) {
    const msg = (event.data && event.data.pluginMessage) as
      | PluginMessage
      | undefined

    if (typeof original === 'function') {
      try {
        original.call(window, event)
      } catch (e) {
        // 原处理抛错时仍要继续，否则桥接消息会被吞掉
        console.error('原有消息处理失败', e)
      }
    }

    if (!msg) return

    if (msg.type === 'bridge-result') {
      client.handleResult(
        msg.payload as {
          id: string
          ok: boolean
          result?: unknown
          error?: string
        },
      )
      return
    }

    if (msg.type === 'bridge-busy') {
      busyHint = Boolean(msg.busy)
      return
    }

    if (msg.type === 'bridge-document-changed') {
      // 文档被 agent 改过，让 Inspector 重读当前选区
      parent.postMessage({pluginMessage: {type: 'inspect'}}, '*')
    }
  }

  // 不自动连接。开关打开前零网络请求。
  parent.postMessage({pluginMessage: {type: 'bridge-hello'}}, '*')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installBridge)
} else {
  installBridge()
}