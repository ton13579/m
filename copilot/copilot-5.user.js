// ==UserScript==
// @name         Copilot AI Task Worker (WebSocket)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Listen to backend via WebSocket and use Microsoft Copilot web UI to generate comments
// @author       Velo
// @match        https://copilot.microsoft.com/*
// @grant        GM_notification
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ton13579/m/main/copilot/copilot-5.user.js
// @updateURL    https://raw.githubusercontent.com/ton13579/m/main/copilot/copilot-5.user.js
// ==/UserScript==

;(function () {
  'use strict'

  const CONFIG = {
    WS_URL: 'ws://localhost:3003/ws/monkey',
    API_KEY: 'velo-monkey-2024',
    WORKER_ID: 'copilot-5',
    RESPONSE_TIMEOUT: 15000,
    RECONNECT_DELAY: 3000,
    CAPTCHA_CHECK_INTERVAL: 2000,
  }

  let ws = null
  let isProcessing = false
  let tasksDone = 0
  let workerActive = true
  let currentTask = null
  let captchaObserver = null

  function createControlPanel() {
    const style = document.createElement('style')
    style.textContent = `
      #copilot-worker-panel {
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
      #copilot-worker-panel .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        font-weight: 600;
        font-size: 14px;
      }
      #copilot-worker-panel .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #4ade80;
        animation: cp-pulse 2s infinite;
      }
      #copilot-worker-panel .status-dot.busy { background: #fbbf24; }
      #copilot-worker-panel .status-dot.error { background: #ef4444; animation: none; }
      #copilot-worker-panel .status-dot.stopped { background: #6b7280; animation: none; }
      #copilot-worker-panel .status-dot.connected { background: #4ade80; }
      @keyframes cp-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      #copilot-worker-panel .info-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      #copilot-worker-panel .info-label { color: rgba(255,255,255,0.6); }
      #copilot-worker-panel .info-value { color: #60a5fa; font-family: monospace; }
      #copilot-worker-panel .btn {
        margin-top: 12px;
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.2s;
        width: 100%;
      }
      #copilot-worker-panel .btn-stop { background: #ef4444; color: white; }
      #copilot-worker-panel .btn-start { background: #4ade80; color: #1a1a2e; }
      #copilot-worker-panel .log {
        margin-top: 12px;
        max-height: 120px;
        overflow-y: auto;
        font-size: 11px;
        background: rgba(0,0,0,0.3);
        padding: 8px;
        border-radius: 6px;
        font-family: monospace;
      }
      #copilot-worker-panel .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      #copilot-worker-panel .log-entry.error { color: #ef4444; }
      #copilot-worker-panel .log-entry.success { color: #4ade80; }
      #copilot-worker-panel .log-entry.info { color: #60a5fa; }
    `
    document.head.appendChild(style)

    const panel = document.createElement('div')
    panel.id = 'copilot-worker-panel'

    const header = document.createElement('div')
    header.className = 'header'

    const statusDot = document.createElement('div')
    statusDot.className = 'status-dot'
    statusDot.id = 'cp-status-dot'

    const title = document.createElement('span')
    title.textContent = 'Copilot Worker (WS)'

    header.appendChild(statusDot)
    header.appendChild(title)

    const statusRow = document.createElement('div')
    statusRow.className = 'info-row'
    const statusLabel = document.createElement('span')
    statusLabel.className = 'info-label'
    statusLabel.textContent = 'Status:'
    const statusValue = document.createElement('span')
    statusValue.className = 'info-value'
    statusValue.id = 'cp-worker-status'
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
    tasksValue.id = 'cp-tasks-done'
    tasksValue.textContent = '0'
    tasksRow.appendChild(tasksLabel)
    tasksRow.appendChild(tasksValue)

    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'btn btn-stop'
    toggleBtn.id = 'cp-toggle-btn'
    toggleBtn.textContent = 'Stop'
    toggleBtn.addEventListener('click', toggleWorker)

    const logDiv = document.createElement('div')
    logDiv.className = 'log'
    logDiv.id = 'cp-worker-log'

    panel.appendChild(header)
    panel.appendChild(statusRow)
    panel.appendChild(tasksRow)
    panel.appendChild(toggleBtn)
    panel.appendChild(logDiv)

    document.body.appendChild(panel)
  }

  function updateUI(status, state = 'idle') {
    const statusEl = document.getElementById('cp-worker-status')
    const dotEl = document.getElementById('cp-status-dot')
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
    const logEl = document.getElementById('cp-worker-log')
    if (!logEl) return
    const entry = document.createElement('div')
    entry.className = `log-entry ${type}`
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
    logEl.insertBefore(entry, logEl.firstChild)
    if (logEl.children.length > 30) logEl.removeChild(logEl.lastChild)
  }

  function incrementTasksDone() {
    tasksDone++
    const el = document.getElementById('cp-tasks-done')
    if (el) el.textContent = tasksDone
  }

  // --- CAPTCHA auto-click ---
  function tryCaptchaClick() {
    const labels = document.querySelectorAll('label, span, div')
    for (const el of labels) {
      const text = el.textContent?.trim().toLowerCase() || ''
      if (
        text === 'verify you are human' ||
        text.includes('verify you are human')
      ) {
        const checkbox =
          el.closest('label')?.querySelector('input[type="checkbox"]') ||
          el.parentElement?.querySelector('input[type="checkbox"]') ||
          el.previousElementSibling
        if (checkbox && checkbox.tagName === 'INPUT' && !checkbox.checked) {
          addLog('CAPTCHA detected, clicking...', 'info')
          checkbox.click()
          return true
        }
        const clickTarget =
          el.closest('[role="checkbox"]') || el.closest('label') || el
        const rect = clickTarget.getBoundingClientRect()
        if (rect.width > 0) {
          addLog('CAPTCHA detected, clicking area...', 'info')
          clickTarget.click()
          return true
        }
      }
    }

    const iframes = document.querySelectorAll('iframe')
    for (const iframe of iframes) {
      const src = (iframe.src || '').toLowerCase()
      const title = (iframe.title || '').toLowerCase()
      if (
        src.includes('captcha') ||
        src.includes('turnstile') ||
        src.includes('challenge') ||
        title.includes('verify') ||
        title.includes('captcha') ||
        title.includes('human')
      ) {
        const rect = iframe.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          addLog('CAPTCHA iframe found, simulating click...', 'info')
          const clickX = rect.left + 30
          const clickY = rect.top + rect.height / 2
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clickX,
            clientY: clickY,
          })
          iframe.dispatchEvent(clickEvent)
          return true
        }
      }
    }
    return false
  }

  function startCaptchaWatcher() {
    captchaObserver = setInterval(() => {
      tryCaptchaClick()
    }, CONFIG.CAPTCHA_CHECK_INTERVAL)
  }

  function stopCaptchaWatcher() {
    if (captchaObserver) {
      clearInterval(captchaObserver)
      captchaObserver = null
    }
  }

  // --- WebSocket ---
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
        console.error('[CP-WS] Parse error:', e)
      }
    }

    ws.onerror = (error) => {
      addLog('WebSocket error', 'error')
      updateUI('Error', 'error')
      console.error('[CP-WS] Error:', error)
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
    console.log('[CP-WS] Message:', msg)

    if (msg.type === 'connected') {
      addLog(`Connected as ${msg.workerId}`, 'success')
    }

    if (msg.type === 'task') {
      addLog(`Task: ${msg.taskId.slice(0, 12)}...`, 'info')
      processTask(msg.taskId, msg.prompt)
    }

    if (msg.type === 'pong') {
      console.log('[CP-WS] Pong received')
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

  // --- DOM interaction ---
  function findInputArea() {
    const selectors = [
      '#userInput',
      'textarea[data-testid="composer-input"]',
      'textarea[placeholder*="Message Copilot"]',
      'textarea[placeholder*="Message"]',
      'textarea[role="textbox"]',
      'textarea',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) {
        console.log('[CP-Monkey] Found input:', sel)
        return el
      }
    }
    console.log('[CP-Monkey] No input found')
    return null
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="submit-button"]',
      'button[aria-label="Submit message"]',
      'button[aria-label="Submit"]',
      'button[aria-label="Send"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null && !el.disabled) {
        console.log('[CP-Monkey] Found send button:', sel)
        return el
      }
    }
    return null
  }

  function findNewChatButton() {
    const selectors = [
      'button[data-testid="sidebar-new-conversation-button"]',
      'button[aria-label="Start new chat"]',
      'button[aria-label="New chat"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) return el
    }
    return null
  }

  function getResponseTurns() {
    const selectors = [
      '[data-testid*="response"]',
      '[data-testid*="assistant-message"]',
      '[data-testid*="bot-message"]',
      '[data-testid*="turn-"][data-testid*="-response"]',
      '.response-turn',
      '[data-content="ai-message"]',
    ]
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel)
      if (els.length > 0) return els
    }
    const allTestIds = document.querySelectorAll('[data-testid]')
    const responseTurns = []
    allTestIds.forEach((el) => {
      const tid = el.getAttribute('data-testid') || ''
      if (
        (tid.includes('response') ||
          tid.includes('assistant') ||
          tid.includes('bot-message')) &&
        !tid.includes('button') &&
        !tid.includes('submit')
      ) {
        responseTurns.push(el)
      }
    })
    if (responseTurns.length > 0) return responseTurns
    return []
  }

  function getLatestResponseText() {
    const turns = getResponseTurns()
    if (turns.length === 0) {
      const proseEls = document.querySelectorAll(
        '[class*="prose"], [class*="markdown"], [class*="rendered"]'
      )
      for (let i = proseEls.length - 1; i >= 0; i--) {
        const text = proseEls[i].textContent?.trim()
        if (text && text.length > 5) return text
      }
      return null
    }
    const lastTurn = turns[turns.length - 1]
    const text = lastTurn.textContent?.trim()
    return text || null
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
    const stopBtn = document.querySelector(
      'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]'
    )
    if (stopBtn && stopBtn.offsetParent !== null) return true
    const submitBtn = document.querySelector(
      'button[data-testid="submit-button"]'
    )
    if (submitBtn) {
      const label = (submitBtn.getAttribute('aria-label') || '').toLowerCase()
      if (label.includes('stop')) return true
    }
    const streaming = document.querySelector(
      '[class*="streaming"], [class*="typing"], [class*="loading-indicator"], [class*="cursor-blink"]'
    )
    if (streaming && streaming.offsetParent !== null) return true
    return false
  }

  async function startNewChat() {
    addLog('Starting new chat...', 'info')
    const newBtn = findNewChatButton()
    if (newBtn) {
      newBtn.click()
      await sleep(1500)
      let waited = 0
      while (waited < 8000) {
        const input = findInputArea()
        if (input) return true
        await sleep(500)
        waited += 500
      }
    }
    window.location.href = 'https://copilot.microsoft.com/'
    await sleep(2500)
    let waited = 0
    while (waited < 10000) {
      const input = findInputArea()
      if (input) return true
      await sleep(500)
      waited += 500
    }
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

    await sleep(600)

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
    addLog('Waiting for Copilot response...', 'info')
    let stableCount = 0
    let lastContent = null
    let wasGenerating = false

    while (Date.now() - startTime < timeout) {
      await sleep(2000)

      if (isGenerating()) {
        wasGenerating = true
        stableCount = 0
        continue
      }

      const currentTurns = getResponseTurns().length
      const text = getLatestResponseText()
      const isNewTurn = currentTurns > beforeCount
      const isNewContent = text !== beforeContent
      const generationJustEnded = wasGenerating

      if (
        text &&
        text.length > 5 &&
        (isNewTurn || isNewContent || generationJustEnded)
      ) {
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
      const beforeCount = getResponseTurns().length
      const beforeContent = getLatestResponseText()

      await submitPrompt(prompt)

      const response = await waitForNewResponse(beforeCount, beforeContent)
      if (!response) {
        throw new Error('No response from Copilot')
      }

      sendResult(taskId, response)
      incrementTasksDone()
      addLog('Done ✓', 'success')

      GM_notification({
        title: 'Copilot Worker',
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
    const btn = document.getElementById('cp-toggle-btn')
    if (workerActive) {
      workerActive = false
      if (ws) {
        ws.close()
        ws = null
      }
      stopCaptchaWatcher()
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
      startCaptchaWatcher()
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
    console.log('[Copilot Worker] v1.0.0 (WebSocket)')
    createControlPanel()
    addLog(`ID: ${CONFIG.WORKER_ID}`, 'info')
    setTimeout(connectWebSocket, 1000)
    startHeartbeat()
    startCaptchaWatcher()
  }

  if (document.readyState === 'complete') {
    init()
  } else {
    window.addEventListener('load', init)
  }
})()
