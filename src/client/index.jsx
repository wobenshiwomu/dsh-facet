// dsh-facet — 浏览器半区（浮窗）。
//
// 订阅宿主 SSE（/dsh-facet/events）：主 agent 调用 facet_ready 后，宿主广播
// {slug, query, mode, views:[{kind,title,url}]}；本组件在 `shell.overlay`
// （全局浮层）上按**视图清单**弹出可视化窗口：
//  · 手机（<720px）：单窗 + N 个视图标签
//  · 桌面：1 视图=单窗；2 视图=双窗并排；≥3 视图=单窗标签栏（标签栏自己长出来）
//
// 窗口只负责"壳"：内容一律 iframe 指到宿主路由（view.url），与回复里的链接
// 是同一个地址——关掉窗口后从消息链接照样能再开。
import { useEffect, useMemo, useRef, useState } from 'react'

const ROUTE = '/dsh-facet'
const EVENTS_URL = `${ROUTE}/events`
const Z_BASE = 900000

const KIND_ACCENT = {
  diagram: '#E8590C',
  tower: '#1C7ED6',
  network: '#AE3EC9',
  flow: '#2F9E44',
  timeline: '#7048E8',
}

/** 词汇表外的视图（或旧版载荷）回退：旧 2d/3d 产物。 */
function fallbackViews(slug) {
  return [
    { kind: 'diagram', title: '2D 结构图', url: `${ROUTE}/${slug}/2d.html` },
    { kind: 'tower', title: '3D 视图', url: `${ROUTE}/${slug}/3d.html` },
  ]
}

function normalizeViews(data) {
  const slug = String(data?.slug ?? '')
  if (slug === '') return []
  if (Array.isArray(data.views) && data.views.length > 0) {
    const out = []
    for (const v of data.views) {
      const kind = String(v?.kind ?? '')
      const title = String(v?.title ?? kind)
      const url = typeof v?.url === 'string' && v.url.length > 0
        ? v.url
        : `${ROUTE}/${slug}/${typeof v?.file === 'string' && v.file.length > 0 ? v.file : `${kind}.html`}`
      if (kind.length === 0) continue
      out.push({ kind, title, url })
    }
    if (out.length > 0) return out
  }
  return fallbackViews(slug)
}

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
  if (kind === 'tabs') {
    const w = Math.min(880, Math.round(vw * 0.7))
    const h = Math.min(Math.round(vh * 0.74), 700)
    return { x: Math.round((vw - w) / 2), y: 62 + offset, w, h }
  }
  const wide = kind === 'tower' || kind === 'network'
  const w = wide ? Math.min(680, Math.round(vw * 0.5)) : Math.min(500, Math.round(vw * 0.4))
  const h = Math.min(Math.round(vh * 0.72), 680)
  const x = wide
    ? Math.min(vw - w - 12, Math.round(vw * 0.5 + 20))
    : Math.max(12, Math.round(vw * 0.5 - w - 20))
  return { x, y: 68 + offset, w, h }
}

// ── 单扇浮窗 ──────────────────────────────────────────────────────────────

function WindowFrame({ title, accent, rect, z, onClose, onFocus, children }) {
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

function TabbedViewer({ views }) {
  const [tab, setTab] = useState(0)
  const active = views[Math.min(tab, Math.max(views.length - 1, 0))]
  if (active === undefined) return null
  return (
    <div className="facet-tabwrap">
      <div className="facet-tabbar">
        {views.map((v, i) => (
          <button
            key={`${v.kind}-${i}`}
            className="facet-tab"
            data-active={i === tab || undefined}
            onClick={() => setTab(i)}
          >
            {v.title}
          </button>
        ))}
      </div>
      <iframe
        key={active.url}
        className="facet-frame"
        src={active.url}
        sandbox="allow-scripts allow-same-origin allow-popups"
        title={active.title}
      />
    </div>
  )
}

// ── 浮层主组件 ────────────────────────────────────────────────────────────

function FacetWindows() {
  const [artifacts, setArtifacts] = useState([]) // [{slug, query, views, ts}]（最新在后）
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
          const views = normalizeViews(data)
          if (views.length === 0) return
          setArtifacts((prev) => {
            const next = prev.filter((a) => a.slug !== data.slug)
            next.push({
              slug: data.slug,
              query: typeof data.query === 'string' ? data.query : data.slug,
              views,
              ts: Date.now(),
            })
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
      const views = a.views
      if (mobile || views.length >= 3) {
        out.push({
          key: `${a.slug}:${a.ts}:tabs`,
          type: 'tabs',
          views,
          title: views.length > 1 ? `${a.query}（${views.length} 视图）` : a.query,
          accent: '#868E96',
          index: i,
        })
      } else if (views.length === 2) {
        views.forEach((v, j) => {
          out.push({
            key: `${a.slug}:${a.ts}:${v.kind}`,
            type: 'single',
            view: v,
            title: `${a.query} · ${v.title}`,
            accent: KIND_ACCENT[v.kind] ?? '#868E96',
            index: i * 2 + j,
          })
        })
      } else {
        const v = views[0]
        out.push({
          key: `${a.slug}:${a.ts}:${v.kind}`,
          type: 'single',
          view: v,
          title: `${a.query} · ${v.title}`,
          accent: KIND_ACCENT[v.kind] ?? '#868E96',
          index: i,
        })
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
          title={d.title}
          accent={d.accent}
          rect={defaultRect(d.type === 'tabs' ? 'tabs' : d.view.kind, d.index)}
          z={zOf(d.key)}
          onClose={() => close(d.key)}
          onFocus={() => focus(d.key)}
        >
          {d.type === 'tabs'
            ? <TabbedViewer views={d.views} />
            : (
              <iframe
                className="facet-frame"
                src={d.view.url}
                sandbox="allow-scripts allow-same-origin allow-popups"
                title={d.title}
              />
            )}
        </WindowFrame>
      ))}
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
.facet-tab[data-active]{border-color:#1C7ED6;color:#1C7ED6;font-weight:600}
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
