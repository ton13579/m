// ==UserScript==
// @name         Perplexity AI Task Worker (WebSocket)
// @namespace    http://tampermonkey.net/
// @version      6.0.0
// @description  Listen to backend via WebSocket and use Perplexity web UI
// @author       Velo
// @match        https://www.perplexity.ai/*
// @grant        GM_notification
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ton13579/m/main/perplexity/perplexity-5.user.js
// @updateURL    https://raw.githubusercontent.com/ton13579/m/main/perplexity/perplexity-5.user.js
// ==/UserScript==

;(function () {
  'use strict'

  const CONFIG = {
    WS_URL: 'ws://localhost:3003/ws/monkey',
    API_KEY: 'velo-monkey-2024',
    WORKER_ID: 'perplexity-5',
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
      #gemini-worker-panel {
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
      #gemini-worker-panel .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        font-weight: 600;
        font-size: 14px;
      }
      #gemini-worker-panel .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #4ade80;
        animation: gw-pulse 2s infinite;
      }
      #gemini-worker-panel .status-dot.busy { background: #fbbf24; }
      #gemini-worker-panel .status-dot.error { background: #ef4444; animation: none; }
      #gemini-worker-panel .status-dot.stopped { background: #6b7280; animation: none; }
      #gemini-worker-panel .status-dot.connected { background: #4ade80; }
      @keyframes gw-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      #gemini-worker-panel .info-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      #gemini-worker-panel .info-label { color: rgba(255,255,255,0.6); }
      #gemini-worker-panel .info-value { color: #4ade80; font-family: monospace; }
      #gemini-worker-panel .btn {
        margin-top: 12px;
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.2s;
        width: 100%;
      }
      #gemini-worker-panel .btn-stop { background: #ef4444; color: white; }
      #gemini-worker-panel .btn-start { background: #4ade80; color: #1a1a2e; }
      #gemini-worker-panel .log {
        margin-top: 12px;
        max-height: 120px;
        overflow-y: auto;
        font-size: 11px;
        background: rgba(0,0,0,0.3);
        padding: 8px;
        border-radius: 6px;
        font-family: monospace;
      }
      #gemini-worker-panel .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      #gemini-worker-panel .log-entry.error { color: #ef4444; }
      #gemini-worker-panel .log-entry.success { color: #4ade80; }
      #gemini-worker-panel .log-entry.info { color: #60a5fa; }
    `
    document.head.appendChild(style)

    const panel = document.createElement('div')
    panel.id = 'gemini-worker-panel'

    const header = document.createElement('div')
    header.className = 'header'

    const statusDot = document.createElement('div')
    statusDot.className = 'status-dot'
    statusDot.id = 'status-dot'

    const title = document.createElement('span')
    title.textContent = 'Perplexity Worker (WS)'

    header.appendChild(statusDot)
    header.appendChild(title)

    const statusRow = document.createElement('div')
    statusRow.className = 'info-row'
    const statusLabel = document.createElement('span')
    statusLabel.className = 'info-label'
    statusLabel.textContent = 'Status:'
    const statusValue = document.createElement('span')
    statusValue.className = 'info-value'
    statusValue.id = 'worker-status'
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
    tasksValue.id = 'tasks-done'
    tasksValue.textContent = '0'
    tasksRow.appendChild(tasksLabel)
    tasksRow.appendChild(tasksValue)

    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'btn btn-stop'
    toggleBtn.id = 'toggle-btn'
    toggleBtn.textContent = 'Stop'
    toggleBtn.addEventListener('click', toggleWorker)

    const logDiv = document.createElement('div')
    logDiv.className = 'log'
    logDiv.id = 'worker-log'

    panel.appendChild(header)
    panel.appendChild(statusRow)
    panel.appendChild(tasksRow)
    panel.appendChild(toggleBtn)
    panel.appendChild(logDiv)

    document.body.appendChild(panel)
  }

  function updateUI(status, state = 'idle') {
    const statusEl = document.getElementById('worker-status')
    const dotEl = document.getElementById('status-dot')
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
    const logEl = document.getElementById('worker-log')
    if (!logEl) return
    const entry = document.createElement('div')
    entry.className = `log-entry ${type}`
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
    logEl.insertBefore(entry, logEl.firstChild)
    if (logEl.children.length > 30) logEl.removeChild(logEl.lastChild)
  }

  function incrementTasksDone() {
    tasksDone++
    const el = document.getElementById('tasks-done')
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
        console.error('[WS] Parse error:', e)
      }
    }

    ws.onerror = (error) => {
      addLog('WebSocket error', 'error')
      updateUI('Error', 'error')
      console.error('[WS] Error:', error)
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
    console.log('[WS] Message:', msg)

    if (msg.type === 'connected') {
      addLog(`Connected as ${msg.workerId}`, 'success')
    }

    if (msg.type === 'task') {
      addLog(`Task: ${msg.taskId.slice(0, 12)}...`, 'info')
      processTask(msg.taskId, msg.prompt)
    }

    if (msg.type === 'pong') {
      console.log('[WS] Pong received')
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
      '#ask-input',
      '[data-lexical-editor="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-placeholder*="Ask"]',
      'textarea[placeholder*="Ask"]',
      'textarea',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) {
        console.log('[Monkey] Found input:', sel, el)
        return el
      }
    }
    console.log('[Monkey] No input found')
    return null
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label="Submit"]',
      'button[aria-label="提交"]',
      'button[type="submit"]',
      'button svg[data-icon="arrow-right"]',
      'button svg path[d*="M4.5 11"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el) {
        const btn = el.tagName === 'BUTTON' ? el : el.closest('button')
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          console.log('[Monkey] Found send button:', sel)
          return btn
        }
      }
    }
    const allBtns = document.querySelectorAll('button')
    for (const btn of allBtns) {
      if (
        btn.offsetParent !== null &&
        btn.querySelector('svg') &&
        !btn.disabled
      ) {
        const rect = btn.getBoundingClientRect()
        if (rect.width > 20 && rect.width < 60) {
          console.log('[Monkey] Found send button by shape')
          return btn
        }
      }
    }
    return null
  }

  function extractJsonFromPage(text) {
    if (!text) return null
    const trimmed = text.trim()
    console.log(
      '[Monkey] extractJson input:',
      trimmed.slice(0, 200),
      '...END:',
      trimmed.slice(-50)
    )

    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        JSON.parse(trimmed)
        return trimmed
      } catch (e) {
        console.log('[Monkey] Direct parse failed:', e.message)
      }
    }

    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlock) {
      try {
        const parsed = codeBlock[1].trim()
        JSON.parse(parsed)
        console.log('[Monkey] Found JSON in code block')
        return parsed
      } catch {}
    }

    const objMatch = trimmed.match(/\{[\s\S]*"p1"\s*:\s*\[[\s\S]*\}/)
    if (objMatch) {
      try {
        JSON.parse(objMatch[0])
        return objMatch[0]
      } catch (e) {
        console.log('[Monkey] objMatch parse failed:', e.message)
      }
    }
    const arrMatch = trimmed.match(/\[[\s\S]*\]/)
    if (arrMatch) {
      try {
        JSON.parse(arrMatch[0])
        return arrMatch[0]
      } catch (e) {
        console.log('[Monkey] arrMatch parse failed:', e.message)
      }
    }

    const cleanedText = trimmed.replace(/\s*\[\d+\]\s*/g, '').trim()
    if (cleanedText !== trimmed) {
      console.log(
        '[Monkey] Trying cleaned (removed footnotes):',
        cleanedText.slice(0, 100)
      )
      if (
        (cleanedText.startsWith('{') && cleanedText.endsWith('}')) ||
        (cleanedText.startsWith('[') && cleanedText.endsWith(']'))
      ) {
        try {
          JSON.parse(cleanedText)
          return cleanedText
        } catch {}
      }
      const cleanObj = cleanedText.match(/\{[\s\S]*"p1"\s*:\s*\[[\s\S]*\}/)
      if (cleanObj) {
        try {
          JSON.parse(cleanObj[0])
          return cleanObj[0]
        } catch {}
      }
    }

    console.log('[Monkey] extractJson: no valid JSON found')
    return null
  }

  async function getLatestResponse() {
    const markdownContainers = document.querySelectorAll(
      '[id^="markdown-content-"]'
    )
    if (markdownContainers.length > 0) {
      const lastContainer = markdownContainers[markdownContainers.length - 1]
      const proseEl = lastContainer.querySelector('.prose') || lastContainer
      const text = proseEl.textContent?.trim()
      console.log('[Monkey] Found markdown-content:', text?.slice(0, 100))
      const json = extractJsonFromPage(text)
      if (json) return json
    }

    const proseEls = document.querySelectorAll('div.prose')
    for (let i = proseEls.length - 1; i >= 0; i--) {
      const text = proseEls[i].textContent?.trim()
      const json = extractJsonFromPage(text)
      if (json) {
        console.log('[Monkey] Found JSON in prose:', json.slice(0, 100))
        return json
      }
    }

    const allText = document.body.innerText
    const json = extractJsonFromPage(allText)
    if (json) {
      console.log('[Monkey] Found JSON in body:', json.slice(0, 100))
      return json
    }

    console.log('[Monkey] No response found in page')
    return null
  }

  function isGenerating() {
    const stopBtn = document.querySelector('button[aria-label*="Stop"]')
    if (stopBtn && stopBtn.offsetParent !== null && !stopBtn.disabled)
      return true
    const typingIndicator = document.querySelector(
      '[class*="typing"], [class*="streaming"]'
    )
    if (typingIndicator && typingIndicator.offsetParent !== null) return true
    const copyBtn = document.querySelector('button[aria-label="Copy"]')
    if (copyBtn && copyBtn.offsetParent !== null) return false
    return false
  }

  async function waitForResponse(timeout = CONFIG.RESPONSE_TIMEOUT) {
    const startTime = Date.now()
    let lastContent = await getLatestResponse()
    let stableCount = 0

    addLog('Waiting for Perplexity...', 'info')

    while (Date.now() - startTime < timeout) {
      await sleep(2000)
      if (isGenerating()) {
        stableCount = 0
        continue
      }
      const current = await getLatestResponse()
      if (current && current === lastContent && current.length > 10) {
        stableCount++
        if (stableCount >= 2) {
          addLog('Response ready', 'success')
          return current
        }
      } else {
        lastContent = current
        stableCount = 0
      }
    }
    throw new Error('Response timeout')
  }

  async function submitPrompt(prompt) {
    addLog('Sending prompt...', 'info')
    const input = findInputArea()
    if (!input) throw new Error('Input not found')

    console.log(
      '[Monkey] Input element:',
      input.tagName,
      input.id,
      input.className.slice(0, 50)
    )

    input.focus()
    await sleep(200)

    const isLexical =
      input.hasAttribute('data-lexical-editor') || input.id === 'ask-input'

    if (isLexical) {
      console.log('[Monkey] Lexical editor detected')
      input.innerHTML = ''
      await sleep(100)

      const p = document.createElement('p')
      p.className = 'PlaygroundEditorTheme__paragraph'
      p.innerHTML = `<span>${prompt}</span>`
      input.appendChild(p)

      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: prompt,
        })
      )
    } else if (input.tagName === 'TEXTAREA') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      nativeInputValueSetter.call(input, prompt)
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    } else {
      input.textContent = prompt
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: prompt,
        })
      )
    }

    await sleep(500)

    let sendBtn = findSendButton()
    console.log('[Monkey] Send button:', sendBtn)

    if (sendBtn) {
      addLog('Clicking send button...', 'info')
      sendBtn.click()
    } else {
      addLog('Using Enter key...', 'info')
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
      input.dispatchEvent(enterEvent)
    }
    await sleep(500)
  }

  async function waitForNewResponse(
    beforeContent,
    beforeCount,
    timeout = CONFIG.RESPONSE_TIMEOUT
  ) {
    const startTime = Date.now()
    addLog('Waiting for new response...', 'info')
    let stableCount = 0
    let lastContent = null

    while (Date.now() - startTime < timeout) {
      await sleep(1500)

      if (isGenerating()) {
        stableCount = 0
        continue
      }

      const containers = document.querySelectorAll('[id^="markdown-content-"]')
      console.log(
        '[Monkey] Count:',
        containers.length,
        'before:',
        beforeCount,
        'generating:',
        isGenerating()
      )

      if (containers.length > 0) {
        const lastContainer = containers[containers.length - 1]
        const proseEl = lastContainer.querySelector('.prose') || lastContainer
        const text = proseEl.textContent?.trim()
        const json = extractJsonFromPage(text)

        if (json) {
          console.log('[Monkey] Found JSON:', json.slice(0, 80))

          if (json !== beforeContent) {
            if (json === lastContent) {
              stableCount++
              if (stableCount >= 2) {
                addLog('Response ready', 'success')
                return json
              }
            } else {
              lastContent = json
              stableCount = 1
            }
          }
        }
      }
    }
    throw new Error('Response timeout')
  }

  async function processTask(taskId, prompt) {
    if (isProcessing) {
      addLog('Already processing, queued', 'info')
      return
    }

    isProcessing = true
    currentTask = taskId
    updateUI('Processing...', 'busy')
    addLog(`Processing ${taskId.slice(0, 12)}...`, 'info')

    try {
      const containers = document.querySelectorAll('[id^="markdown-content-"]')
      const beforeCount = containers.length
      const beforeContent = await getLatestResponse()
      console.log(
        '[Monkey] Before submit:',
        beforeCount,
        'elements, content:',
        beforeContent?.slice(0, 50)
      )

      await submitPrompt(prompt)

      const response = await waitForNewResponse(beforeContent, beforeCount)
      if (!response) {
        throw new Error('No new response')
      }

      sendResult(taskId, response)
      incrementTasksDone()
      addLog('Done ✓', 'success')

      GM_notification({
        title: 'Perplexity Worker',
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
    const btn = document.getElementById('toggle-btn')
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
    console.log('[Perplexity Worker] v6.0.0 (WebSocket)')
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
