// ==UserScript==
// @name         Qwen AI Task Worker (WebSocket)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Listen to backend via WebSocket and use Qwen web UI to generate comments
// @author       Velo
// @match        https://chat.qwen.ai/*
// @grant        GM_notification
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ton13579/m/main/qwen/qwen-10.user.js
// @updateURL    https://raw.githubusercontent.com/ton13579/m/main/qwen/qwen-10.user.js
// ==/UserScript==

;(function () {
  'use strict'

  const CONFIG = {
    WS_URL: 'ws://localhost:3003/ws/monkey',
    API_KEY: 'velo-monkey-2024',
    WORKER_ID: 'qwen-10',
    RESPONSE_TIMEOUT: 15000,
    RECONNECT_DELAY: 3000,
  }

  let ws = null
  let isProcessing = false
  let tasksDone = 0
  let workerActive = true
  let currentTask = null

  function createControlPanel() {
    const style = document.createElement('style')
    style.textContent = `
      #qwen-worker-panel {
        position: fixed;
        top: 10px;
        right: 10px;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        color: #fff;
        padding: 16px;
        border-radius: 12px;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        min-width: 220px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
      }
      #qwen-worker-panel .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        font-weight: 600;
        font-size: 14px;
      }
      #qwen-worker-panel .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #4ade80;
        animation: qw-pulse 2s infinite;
      }
      #qwen-worker-panel .status-dot.busy { background: #fbbf24; }
      #qwen-worker-panel .status-dot.error { background: #ef4444; animation: none; }
      #qwen-worker-panel .status-dot.stopped { background: #6b7280; animation: none; }
      #qwen-worker-panel .status-dot.connected { background: #4ade80; }
      @keyframes qw-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      #qwen-worker-panel .info-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      #qwen-worker-panel .info-label { color: rgba(255,255,255,0.6); }
      #qwen-worker-panel .info-value { color: #7c5cfc; font-family: monospace; }
      #qwen-worker-panel .btn {
        margin-top: 12px;
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.2s;
        width: 100%;
      }
      #qwen-worker-panel .btn-stop { background: #ef4444; color: white; }
      #qwen-worker-panel .btn-start { background: #4ade80; color: #1a1a2e; }
      #qwen-worker-panel .log {
        margin-top: 12px;
        max-height: 120px;
        overflow-y: auto;
        font-size: 11px;
        background: rgba(0,0,0,0.3);
        padding: 8px;
        border-radius: 6px;
        font-family: monospace;
      }
      #qwen-worker-panel .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      #qwen-worker-panel .log-entry.error { color: #ef4444; }
      #qwen-worker-panel .log-entry.success { color: #4ade80; }
      #qwen-worker-panel .log-entry.info { color: #60a5fa; }
    `
    document.head.appendChild(style)

    const panel = document.createElement('div')
    panel.id = 'qwen-worker-panel'

    const header = document.createElement('div')
    header.className = 'header'

    const statusDot = document.createElement('div')
    statusDot.className = 'status-dot'
    statusDot.id = 'qw-status-dot'

    const title = document.createElement('span')
    title.textContent = 'Qwen Worker (WS)'

    header.appendChild(statusDot)
    header.appendChild(title)

    const statusRow = document.createElement('div')
    statusRow.className = 'info-row'
    const statusLabel = document.createElement('span')
    statusLabel.className = 'info-label'
    statusLabel.textContent = 'Status:'
    const statusValue = document.createElement('span')
    statusValue.className = 'info-value'
    statusValue.id = 'qw-worker-status'
    statusValue.textContent = 'Connecting...'
    statusRow.appendChild(statusLabel)
    statusRow.appendChild(statusValue)

    const tasksRow = document.createElement('div')
    tasksRow.className = 'info-row'
    const tasksLabel = document.createElement('span')
    tasksLabel.className = 'info-label'
    tasksLabel.textContent = 'Tasks Done:'
    const tasksValue = document.createElement('span')
    tasksValue.className = 'info-value'
    tasksValue.id = 'qw-tasks-done'
    tasksValue.textContent = '0'
    tasksRow.appendChild(tasksLabel)
    tasksRow.appendChild(tasksValue)

    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'btn btn-stop'
    toggleBtn.id = 'qw-toggle-btn'
    toggleBtn.textContent = 'Stop'
    toggleBtn.addEventListener('click', toggleWorker)

    const logDiv = document.createElement('div')
    logDiv.className = 'log'
    logDiv.id = 'qw-worker-log'

    panel.appendChild(header)
    panel.appendChild(statusRow)
    panel.appendChild(tasksRow)
    panel.appendChild(toggleBtn)
    panel.appendChild(logDiv)

    document.body.appendChild(panel)
  }

  function updateUI(status, state = 'idle') {
    const statusEl = document.getElementById('qw-worker-status')
    const dotEl = document.getElementById('qw-status-dot')
    if (statusEl) statusEl.textContent = status
    if (dotEl) {
      dotEl.classList.remove('busy', 'error', 'stopped', 'connected')
      if (state === 'busy') dotEl.classList.add('busy')
      else if (state === 'error') dotEl.classList.add('error')
      else if (state === 'stopped') dotEl.classList.add('stopped')
      else if (state === 'connected') dotEl.classList.add('connected')
    }
  }

  function addLog(message, type = 'info') {
    const logEl = document.getElementById('qw-worker-log')
    if (!logEl) return
    const entry = document.createElement('div')
    entry.className = `log-entry ${type}`
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
    logEl.insertBefore(entry, logEl.firstChild)
    if (logEl.children.length > 30) logEl.removeChild(logEl.lastChild)
  }

  function incrementTasksDone() {
    tasksDone++
    const el = document.getElementById('qw-tasks-done')
    if (el) el.textContent = tasksDone
  }

  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return

    addLog('Connecting to WebSocket...', 'info')
    updateUI('Connecting...', 'idle')

    const url = `${CONFIG.WS_URL}?key=${CONFIG.API_KEY}&workerId=${CONFIG.WORKER_ID}`
    ws = new WebSocket(url)

    ws.onopen = () => {
      addLog('WebSocket connected', 'success')
      updateUI('Connected', 'connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleMessage(msg)
      } catch (e) {
        console.error('[QW-WS] Parse error:', e)
      }
    }

    ws.onerror = (error) => {
      addLog('WebSocket error', 'error')
      updateUI('Error', 'error')
      console.error('[QW-WS] Error:', error)
    }

    ws.onclose = () => {
      addLog('WebSocket closed', 'info')
      updateUI('Disconnected', 'error')
      ws = null
      if (workerActive) {
        setTimeout(connectWebSocket, CONFIG.RECONNECT_DELAY)
      }
    }
  }

  function handleMessage(msg) {
    console.log('[QW-WS] Message:', msg)

    if (msg.type === 'connected') {
      addLog(`Connected as ${msg.workerId}`, 'success')
    }

    if (msg.type === 'task') {
      addLog(`Task: ${msg.taskId.slice(0, 12)}...`, 'info')
      processTask(msg.taskId, msg.prompt)
    }

    if (msg.type === 'pong') {
      console.log('[QW-WS] Pong received')
    }
  }

  function sendResult(taskId, response, error = null) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'result',
          taskId,
          response,
          error,
        })
      )
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function findInputArea() {
    const selectors = [
      'textarea.message-input-textarea',
      'textarea[placeholder*="幫您"]',
      'textarea[placeholder*="help"]',
      'textarea',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) {
        console.log('[QW-Monkey] Found input:', sel)
        return el
      }
    }
    console.log('[QW-Monkey] No input found')
    return null
  }

  function findSendButton() {
    const btn = document.querySelector('button.send-button:not(.disabled)')
    if (btn && btn.offsetParent !== null) {
      console.log('[QW-Monkey] Found send button')
      return btn
    }
    const allSend = document.querySelectorAll('button.send-button')
    for (const b of allSend) {
      if (b.offsetParent !== null && !b.disabled) return b
    }
    return null
  }

  function getAssistantMessages() {
    return document.querySelectorAll('.qwen-chat-message-assistant')
  }

  function getLatestResponseText() {
    const msgs = getAssistantMessages()
    if (msgs.length === 0) return null
    const lastMsg = msgs[msgs.length - 1]
    const markdown = lastMsg.querySelector('.custom-qwen-markdown')
    if (markdown) {
      return markdown.textContent?.trim() || null
    }
    const content = lastMsg.querySelector('.response-message-content')
    if (content) {
      return content.textContent?.trim() || null
    }
    return null
  }

  function extractJsonFromText(text) {
    if (!text) return null
    const trimmed = text.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed)
        return trimmed
      } catch (e) {}
    }
    const objMatch = trimmed.match(/\{[\s\S]*"p1"\s*:\s*\[[\s\S]*\}/)
    if (objMatch) {
      try {
        JSON.parse(objMatch[0])
        return objMatch[0]
      } catch (e) {}
    }
    const arrMatch = trimmed.match(/\[[\s\S]*\]/)
    if (arrMatch) {
      try {
        JSON.parse(arrMatch[0])
        return arrMatch[0]
      } catch (e) {}
    }
    return null
  }

  function isGenerating() {
    const sendBtn = document.querySelector('button.send-button')
    if (!sendBtn) return false
    const hasStopClass =
      sendBtn.classList.contains('stop') ||
      sendBtn.classList.contains('loading')
    if (hasStopClass) return true
    const stopIcon = sendBtn.querySelector(
      '.icon-stop, [class*="stop"], [class*="square"]'
    )
    if (stopIcon) return true
    const thinkingEl = document.querySelector(
      '.response-message-content.phase-thinking'
    )
    if (thinkingEl) return true
    const searchEl = document.querySelector(
      '.response-message-content.phase-search'
    )
    if (searchEl) return true
    const streamingCursor = document.querySelector(
      '.custom-qwen-markdown .cursor, .custom-qwen-markdown .blinking-cursor'
    )
    if (streamingCursor) return true
    return false
  }

  async function submitPrompt(prompt) {
    addLog('Sending prompt...', 'info')

    const input = findInputArea()
    if (!input) throw new Error('Input not found')

    input.focus()
    await sleep(300)

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    ).set
    nativeSetter.call(input, prompt)
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))

    await sleep(500)

    let sendBtn = findSendButton()
    if (sendBtn) {
      addLog('Clicking send button...', 'info')
      sendBtn.click()
    } else {
      addLog('Using Enter key...', 'info')
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      )
    }
    await sleep(500)
  }

  async function waitForNewResponse(
    beforeCount,
    beforeContent,
    timeout = CONFIG.RESPONSE_TIMEOUT
  ) {
    const startTime = Date.now()
    addLog('Waiting for Qwen response...', 'info')
    let stableCount = 0
    let lastContent = null
    let wasGenerating = false

    while (Date.now() - startTime < timeout) {
      await sleep(1500)

      if (isGenerating()) {
        wasGenerating = true
        stableCount = 0
        continue
      }

      const msgs = getAssistantMessages()
      const currentCount = msgs.length
      const text = getLatestResponseText()
      const isNewTurn = currentCount > beforeCount
      const isNewContent = text && text !== beforeContent
      const generationJustEnded = wasGenerating

      if (
        text &&
        text.length > 5 &&
        (isNewTurn || isNewContent || generationJustEnded)
      ) {
        const lastMsg = msgs[msgs.length - 1]
        const phaseEl = lastMsg?.querySelector('.response-message-content')
        const isAnswer = phaseEl?.classList.contains('phase-answer')

        if (!isAnswer && !generationJustEnded) {
          stableCount = 0
          continue
        }

        const json = extractJsonFromText(text)
        const content = json || text

        if (content === lastContent) {
          stableCount++
          if (stableCount >= 2) {
            addLog(
              json ? 'Response ready (JSON)' : 'Response ready (text)',
              'success'
            )
            return content
          }
        } else {
          lastContent = content
          stableCount = 1
        }
      }
    }
    throw new Error('Response timeout')
  }

  async function processTask(taskId, prompt) {
    if (isProcessing) {
      addLog('Already processing, skip', 'info')
      return
    }

    isProcessing = true
    currentTask = taskId
    updateUI('Processing...', 'busy')
    addLog(`Processing ${taskId.slice(0, 12)}...`, 'info')

    try {
      const beforeCount = getAssistantMessages().length
      const beforeContent = getLatestResponseText()

      await submitPrompt(prompt)

      const response = await waitForNewResponse(beforeCount, beforeContent)
      if (!response) {
        throw new Error('No response from Qwen')
      }

      sendResult(taskId, response)
      incrementTasksDone()
      addLog('Done ✓', 'success')

      GM_notification({
        title: 'Qwen Worker',
        text: 'Task completed',
        timeout: 2000,
      })
    } catch (err) {
      addLog(`Error: ${err.message}`, 'error')
      sendResult(taskId, null, err.message)
      await startNewChat()
    } finally {
      isProcessing = false
      currentTask = null
      updateUI('Connected', 'connected')
    }
  }

  function toggleWorker() {
    const btn = document.getElementById('qw-toggle-btn')
    if (workerActive) {
      workerActive = false
      if (ws) {
        ws.close()
        ws = null
      }
      updateUI('Stopped', 'stopped')
      addLog('Stopped', 'info')
      btn.textContent = 'Start'
      btn.className = 'btn btn-start'
    } else {
      workerActive = true
      btn.textContent = 'Stop'
      btn.className = 'btn btn-stop'
      addLog('Starting...', 'info')
      connectWebSocket()
    }
  }

  function startHeartbeat() {
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 15000)
  }

  function init() {
    console.log('[Qwen Worker] v1.0.0 (WebSocket)')
    createControlPanel()
    addLog(`ID: ${CONFIG.WORKER_ID}`, 'info')
    setTimeout(connectWebSocket, 1000)
    startHeartbeat()
  }

  if (document.readyState === 'complete') {
    init()
  } else {
    window.addEventListener('load', init)
  }
})()
