// dsh-facet — 浏览器半区（浮窗）。
//
// 订阅宿主 SSE（/dsh-facet/events）：主 agent 调用 facet_ready 后，
// 宿主广播 {slug, query, twoD, threeD}；本组件在 `shell.overlay`（全局浮层）
// 上弹出可视化窗口：
//  · 桌面：每个产物两扇窗（2D / 3D）左右并排，各自可拖动/最大化/刷新/关闭
//  · 手机（<720px）：单窗 + 2D/3D 标签切换
//
// 窗口只负责“壳”：内容一律 iframe 指到宿主路由（/dsh-facet/<slug>/2d.html），
// 与回复里的链接是同一个地址——关掉窗口后从消息链接照样能再开。
import { useEffect, useMemo, useRef, useState } from 'react'

const ROUTE = '/dsh-facet'
const EVENTS_URL = `${ROUTE}/events`
const Z_BASE = 900000

function isMobileWidth() {
  return (typeof window !== 'undefined' ? window.innerWidth : 1280) < 720
}

function clampPos(x, y, w) {
  const vw = (typeof window !== 'undefined' ? window.innerWidth : 1280)
  const vh = (typeof window !== 'undefined' ? window.innerHeight : 800)
  const nx = Math.min(Math.max(x, 40 - w), vw - 120)
  const ny = Math.min(Math.max(y, 0), vh - 48)
  return { x: nx, y: ny }
}

function defaultRect(kind, index) {
  const vw = (typeof window !== 'undefined' ? window.innerWidth : 1280)
  const vh = (typeof window !== 'undefined' ? window.innerHeight : 800)
  const offset = index * 26
  if (vw < 720) {
    const w = Math.round(vw * 0.94)
    return { x: Math.round((vw - w) / 2), y: 56 + offset, w, h: Math.round(Math.min(vh * 0.76, 760)) }
  }
  const w = kind === '3d' ? Math.min(680, Math.round(vw * 0.5)) : Math.min(500, Math.round(vw * 0.4))
  const h = Math.min(Math.round(vh * 0.72), 680)
  const x = kind === '3d'
    ? Math.min(vw - w - 12, Math.round(vw * 0.5 + 20))
    : Math.max(12, Math.round(vw * 0.5 - w - 20))
  return { x, y: 68 + offset, w, h }
}

// ── 单扇浮窗 ──────────────────────────────────────────────────────────────

function WindowFrame({ wid, title, accent, rect, z, onClose, onFocus, children }) {
  const [pos, setPos] = useState(rect)
  const [maximized, setMaximized] = useState(false)
  const drag = useRef(null)
  const frameRef = useRef(null)

  function refresh() {
    try {
      frameRef.current?.contentWindow?.location?.reload()
    } catch {
      /* 跨源等场景忽略 */
    }
  }

  function onPointerDown(e) {
    onFocus()
    if (maximized) return
    drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e) {
    const d = drag.current
    if (d === null) return
    const next = clampPos(d.x + e.clientX - d.px, d.y + e.clientY - d.py, pos.w)
    setPos((p) => ({ ...p, x: next.x, y: next.y }))
  }

  function onPointerUp() {
    drag.current = null
  }

  const style = maximized
    ? { left: '3vw', top: '4vh', width: '94vw', height: '88vh', zIndex: z }
    : { left: pos.x, top: pos.y, width: pos.w, height: pos.h, zIndex: z }

  return (
    <div className="facet-win" style={style} onPointerDown={onFocus}>
      <div
        className="facet-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="facet-dot" style={{ background: accent }} />
        <span className="facet-title">{title}</span>
        <span className="facet-actions">
          <button className="facet-btn" title="刷新" onClick={refresh}>↻</button>
          <button className="facet-btn" title={maximized ? '还原' : '最大化'} onClick={() => setMaximized((m) => !m)}>
            {maximized ? '⤡' : '⤢'}
          </button>
          <button className="facet-btn facet-close" title="关闭" onClick={onClose}>✕</button>
        </span>
      </div>
      <div className="facet-body">{children}</div>
    </div>
  )
}

// ── 浮层主组件 ────────────────────────────────────────────────────────────

function FacetWindows() {
  const [artifacts, setArtifacts] = useState([]) // [{slug, query, ts}]（最新在后）
  const [closedIds, setClosedIds] = useState([])
  const [order, setOrder] = useState([])
  const [mobile, setMobile] = useState(isMobileWidth)

  useEffect(() => {
    const onResize = () => setMobile(isMobileWidth())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let es
    try {
      es = new EventSource(EVENTS_URL)
      es.addEventListener('ready', (e) => {
        try {
          const data = JSON.parse(e.data)
          if (typeof data?.slug !== 'string' || data.slug === '') return
          setArtifacts((prev) => {
            const next = prev.filter((a) => a.slug !== data.slug)
            next.push({ slug: data.slug, query: typeof data.query === 'string' ? data.query : data.slug, ts: Date.now() })
            return next.slice(-2)
          })
        } catch {
          /* 忽略坏帧 */
        }
      })
    } catch {
      /* 非浏览器/路由缺席时静默 */
    }
    return () => {
      try {
        es?.close()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const descriptors = useMemo(() => {
    const out = []
    artifacts.forEach((a, i) => {
      if (mobile) {
        out.push({
          key: `${a.slug}:${a.ts}:single`,
          kind: 'single',
          artifact: a,
          title: `${a.query} · 架构可视化`,
          index: i,
        })
      } else {
        out.push({ key: `${a.slug}:${a.ts}:2d`, kind: '2d', artifact: a, title: `${a.query} · 2D`, index: i * 2 })
        out.push({ key: `${a.slug}:${a.ts}:3d`, kind: '3d', artifact: a, title: `${a.query} · 3D`, index: i * 2 + 1 })
      }
    })
    return out
  }, [artifacts, mobile])

  useEffect(() => {
    const ids = descriptors.map((d) => d.key)
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      if (kept.length === prev.length && added.length === 0) return prev
      return [...kept, ...added]
    })
  }, [descriptors])

  const live = descriptors.filter((d) => !closedIds.includes(d.key))
  if (live.length === 0) return null

  const zOf = (id) => Z_BASE + Math.max(0, order.indexOf(id)) * 10
  const focus = (id) => setOrder((prev) => [...prev.filter((x) => x !== id), id])
  const close = (id) => setClosedIds((prev) => [...prev, id])

  return (
    <div className="facet-layer">
      {live.map((d) => (
        <WindowFrame
          key={d.key}
          wid={d.key}
          title={d.title}
          accent={d.kind === '2d' ? '#E8590C' : '#1C7ED6'}
          rect={defaultRect(d.kind, d.index)}
          z={zOf(d.key)}
          onClose={() => close(d.key)}
          onFocus={() => focus(d.key)}
        >
          {d.kind === 'single'
            ? <TabbedViewer artifact={d.artifact} />
            : (
              <iframe
                className="facet-frame"
                src={`${ROUTE}/${d.artifact.slug}/${d.kind}.html`}
                sandbox="allow-scripts allow-same-origin allow-popups"
                title={d.title}
              />
            )}
        </WindowFrame>
      ))}
    </div>
  )
}

function TabbedViewer({ artifact }) {
  const [tab, setTab] = useState('2d')
  return (
    <div className="facet-tabwrap">
      <div className="facet-tabbar">
        <button className="facet-tab" data-active={tab === '2d' || undefined} onClick={() => setTab('2d')}>2D 结构图</button>
        <button className="facet-tab" data-active={tab === '3d' || undefined} onClick={() => setTab('3d')}>3D 视图</button>
      </div>
      <iframe
        key={tab}
        className="facet-frame"
        src={`${ROUTE}/${artifact.slug}/${tab}.html`}
        sandbox="allow-scripts allow-same-origin allow-popups"
        title={`${artifact.query} ${tab}`}
      />
    </div>
  )
}

// ── 样式（注入一次） ─────────────────────────────────────────────────────

const CSS = `
.facet-layer{position:fixed;inset:0;pointer-events:none}
.facet-win{position:fixed;pointer-events:auto;display:flex;flex-direction:column;background:#fff;color:#212529;
  border:1px solid #DEE2E6;border-radius:12px;overflow:hidden;box-shadow:0 14px 40px rgba(15,23,42,.22);
  font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.facet-bar{display:flex;align-items:center;gap:8px;height:38px;padding:0 10px;background:#fff;border-bottom:1px solid #DEE2E6;
  cursor:grab;user-select:none;touch-action:none;flex:none}
.facet-bar:active{cursor:grabbing}
.facet-dot{width:10px;height:10px;border-radius:50%;flex:none}
.facet-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#212529}
.facet-actions{display:flex;align-items:center;gap:2px;flex:none}
.facet-btn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;
  border-radius:7px;color:#868E96;cursor:pointer;font-size:13px;line-height:1}
.facet-btn:hover{background:#F1F3F5;color:#212529}
.facet-close:hover{background:#FFF0F0;color:#FA5252}
.facet-body{flex:1;min-height:0;display:flex;background:#fff}
.facet-frame{flex:1;width:100%;height:100%;border:0;background:#fff}
.facet-tabwrap{flex:1;display:flex;flex-direction:column;min-height:0}
.facet-tabbar{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #DEE2E6;background:#FAFAFA;flex:none}
.facet-tab{border:1px solid #DEE2E6;background:#fff;color:#495057;border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer}
.facet-tab[data-active]{border-color:#E8590C;color:#E8590C;font-weight:600}
`

// ── 插件体 ───────────────────────────────────────────────────────────────

const inject = ['slots']

async function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.id = 'dsh-facet-style'
    tag.dataset.plugin = 'dsh-facet'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'dsh-facet: styles')

  ctx.slots.inject('shell.overlay', () => {
    const dispose = ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-facet.windows',
      },
      FacetWindows,
    )
    return () => dispose()
  })
}

export { apply, inject }
