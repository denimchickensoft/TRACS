import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useSessionStore }   from '../../store/session.js'
import { sendChatMessage }   from '../../webrtc/client.js'
import './Messages.css'

const LS_POS     = 'tracs.msg.pos'
const LS_SIZE    = 'tracs.msg.size'
const LS_OPACITY = 'tracs.msg.opacity'

const DEFAULT_SIZE = { w: 380, h: 460 }
const MIN_W = 260
const MIN_H = 200
const OPACITY_STEP = 0.05
const OPACITY_MIN  = 0.2
const OPACITY_MAX  = 1.0

function loadLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

function makeResizer(dir, posRef, sizeRef, setPos, setSize, windowRef, rightInsetRef) {
  return (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const sp = { ...posRef.current }, ss = { ...sizeRef.current }
    const has = (d) => dir.includes(d)
    const onMove = (ev) => {
      const parent   = windowRef.current?.parentElement
      const maxRight = parent ? parent.clientWidth - rightInsetRef.current : Infinity
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      let { x, y } = sp, { w, h } = ss
      if (has('e')) w = Math.max(MIN_W, Math.min(ss.w + dx, maxRight - sp.x))
      if (has('s')) h = Math.max(MIN_H, ss.h + dy)
      if (has('w')) { const nw = Math.max(MIN_W, ss.w - dx); x = sp.x + (ss.w - nw); w = nw }
      if (has('n')) {
        const desiredY = sp.y + ss.h - Math.max(MIN_H, ss.h - dy)
        y = Math.max(0, desiredY)
        h = Math.max(MIN_H, sp.y + ss.h - y)
      }
      posRef.current  = { x, y }
      sizeRef.current = { w, h }
      setPos({ x, y })
      setSize({ w, h })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }
}

function formatTime(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function Messages({ visible, onClose, rightInset = 0 }) {
  const wheelDir = useWheelDirection()

  const messages        = useSessionStore((s) => s.controllerMessages)
  const openDmTabs      = useSessionStore((s) => s.openDmTabs)
  const activeMsgTab    = useSessionStore((s) => s.activeMsgTab)
  const unreadDm        = useSessionStore((s) => s.unreadDm)
  const activeModule    = useSessionStore((s) => s.activeModule)
  const markMessagesRead = useSessionStore((s) => s.markMessagesRead)
  const openDmTab       = useSessionStore((s) => s.openDmTab)
  const closeDmTab      = useSessionStore((s) => s.closeDmTab)
  const setActiveMsgTab = useSessionStore((s) => s.setActiveMsgTab)

  const [pos,         setPos]         = useState(() => loadLS(LS_POS, { x: 24, y: 56 }))
  const [size,        setSize]        = useState(() => loadLS(LS_SIZE, DEFAULT_SIZE))
  const [opacity,     setOpacity]     = useState(() => loadLS(LS_OPACITY, 1.0))
  const [opacityHint, setOpacityHint] = useState(false)
  const [input,       setInput]       = useState('')

  const posRef         = useRef(pos)
  const sizeRef        = useRef(size)
  const opacityHintRef = useRef(null)
  const windowRef      = useRef(null)
  const rightInsetRef  = useRef(rightInset)
  useEffect(() => {
    rightInsetRef.current = rightInset
    const parent = windowRef.current?.parentElement
    if (!parent) return
    const maxX = Math.max(0, parent.clientWidth - sizeRef.current.w - rightInset)
    if (posRef.current.x > maxX) {
      const next = { ...posRef.current, x: maxX }
      posRef.current = next
      setPos(next)
    }
  }, [rightInset])
  const bodyRef        = useRef(null)
  const inputRef       = useRef(null)

  useEffect(() => { posRef.current = pos;   localStorage.setItem(LS_POS,  JSON.stringify(pos))  }, [pos])
  useEffect(() => { sizeRef.current = size; localStorage.setItem(LS_SIZE, JSON.stringify(size)) }, [size])
  useEffect(() => { localStorage.setItem(LS_OPACITY, JSON.stringify(opacity)) }, [opacity])

  useLayoutEffect(() => {
    if (localStorage.getItem(LS_POS) !== null || !windowRef.current) return
    const parent = windowRef.current.parentElement
    if (!parent) return
    const x = Math.max(0, parent.offsetWidth - sizeRef.current.w - 20)
    posRef.current = { x, y: 40 }
    setPos({ x, y: 40 })
  }, []) // eslint-disable-line

  // Auto-scroll to bottom
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [messages, activeMsgTab])

  // Clear unread for the active tab while window is open
  useEffect(() => {
    if (visible) markMessagesRead(activeMsgTab)
  }, [visible, activeMsgTab, messages.length]) // eslint-disable-line

  // Focus input when window opens
  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  const handleDragStart = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const ox = e.clientX - posRef.current.x
    const oy = e.clientY - posRef.current.y
    const onMove = (ev) => {
      const parent = windowRef.current?.parentElement
      const maxX   = parent ? Math.max(0, parent.clientWidth  - sizeRef.current.w - rightInsetRef.current) : Infinity
      const maxY   = parent ? Math.max(0, parent.clientHeight - sizeRef.current.h) : Infinity
      const next   = {
        x: Math.max(0, Math.min(maxX, ev.clientX - ox)),
        y: Math.max(0, Math.min(maxY, ev.clientY - oy)),
      }
      posRef.current = next
      setPos(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  const handleOpacityWheel = useCallback((e) => {
    e.preventDefault()
    const dir = wheelDir(e)
    if (dir === null) return
    setOpacity((prev) => {
      const next = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN,
        parseFloat((prev - dir * OPACITY_STEP).toFixed(2))
      ))
      clearTimeout(opacityHintRef.current)
      setOpacityHint(true)
      opacityHintRef.current = setTimeout(() => setOpacityHint(false), 1200)
      return next
    })
  }, [wheelDir])

  const resizers = useMemo(() => {
    const make = (dir) => makeResizer(dir, posRef, sizeRef, setPos, setSize, windowRef, rightInsetRef)
    return {
      n: make('n'), s: make('s'), e: make('e'), w: make('w'),
      ne: make('ne'), nw: make('nw'), se: make('se'), sw: make('sw'),
    }
  }, [])

  const visibleMessages = useMemo(() => {
    if (activeMsgTab === 'main') return messages.filter((m) => !m.toPosition)
    return messages.filter((m) =>
      m.toPosition && (m.fromPosition === activeMsgTab || m.toPosition === activeMsgTab)
    )
  }, [messages, activeMsgTab])

  function handleSend() {
    const raw = input.trim()
    if (!raw) return
    setInput('')

    if (activeMsgTab !== 'main') {
      sendChatMessage({ text: raw, toPosition: activeMsgTab })
      return
    }

    if (raw.startsWith('.chat ')) {
      const target = raw.slice(6).trim()
      if (target) openDmTab(target)
      return
    }

    if (raw.startsWith('/')) {
      sendChatMessage({ text: raw.slice(1), broadcast: true })
      return
    }

    sendChatMessage({ text: raw })
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); handleSend() }
  }

  const moduleName = activeModule ?? 'CHAT'
  const tabs = ['main', ...openDmTabs]

  if (!visible) return null

  return (
    <div
      ref={windowRef}
      className="msg-window"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, opacity }}
    >
      <div className="msg-resize msg-resize--n"  onMouseDown={resizers.n}  />
      <div className="msg-resize msg-resize--s"  onMouseDown={resizers.s}  />
      <div className="msg-resize msg-resize--e"  onMouseDown={resizers.e}  />
      <div className="msg-resize msg-resize--w"  onMouseDown={resizers.w}  />
      <div className="msg-resize msg-resize--ne" onMouseDown={resizers.ne} />
      <div className="msg-resize msg-resize--nw" onMouseDown={resizers.nw} />
      <div className="msg-resize msg-resize--se" onMouseDown={resizers.se} />
      <div className="msg-resize msg-resize--sw" onMouseDown={resizers.sw} />

      <div className="msg-titlebar" onMouseDown={handleDragStart} onWheel={handleOpacityWheel}>
        <span className="msg-title">Messages</span>
        {opacityHint && <span className="msg-opacity-hint">{Math.round(opacity * 100)}%</span>}
        <button
          className="msg-btn"
          title="Close (Ctrl+M)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >×</button>
      </div>

      <div className="msg-tabs">
        {tabs.map((tab) => {
          const isActive = tab === activeMsgTab
          const label    = tab === 'main' ? moduleName : tab
          const badge    = tab === 'main' ? 0 : (unreadDm[tab] ?? 0)
          return (
            <div
              key={tab}
              className={`msg-tab${isActive ? ' msg-tab--active' : ''}`}
              onClick={() => (tab === 'main' ? setActiveMsgTab('main') : openDmTab(tab))}
            >
              <span className="msg-tab-label">{label}</span>
              {badge > 0 && <span className="msg-tab-badge">{badge}</span>}
              {tab !== 'main' && (
                <button
                  className="msg-tab-close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); closeDmTab(tab) }}
                >×</button>
              )}
            </div>
          )
        })}
      </div>

      <div ref={bodyRef} className="msg-body">
        {visibleMessages.length === 0 && (
          <div className="msg-empty">No messages</div>
        )}
        {visibleMessages.map((msg) => (
          <div
            key={msg.id}
            className={`msg-row${msg.broadcast ? ' msg-row--broadcast' : ''}${msg.toPosition ? ' msg-row--dm' : ''}`}
          >
            <span className="msg-time">[{formatTime(msg.timestamp)}]</span>
            {msg.broadcast && <span className="msg-broadcast-tag">[ALL]</span>}
            <span className="msg-from">{msg.from}:</span>
            <span className="msg-text">{msg.text}</span>
          </div>
        ))}
      </div>

      <div className="msg-input-row">
        <input
          ref={inputRef}
          className="msg-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeMsgTab !== 'main'
              ? `DM ${activeMsgTab}`
              : `${moduleName}  |  / broadcast all  |  .chat POSITION`
          }
          spellCheck={false}
        />
        <button className="msg-send-btn" onClick={handleSend}>→</button>
      </div>
    </div>
  )
}
