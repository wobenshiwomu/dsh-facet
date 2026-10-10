/**
 * dsh-facet — 内容到图谱：/visualize → 生成计划（模式+视图）→ N 子代理 → 浮窗。
 *
 * 工作流（宿主侧只做确定性编排，智能活交给 agent）：
 *  1. 用户输入 `/visualize <模型名 | arXiv 链接 | 一句话需求>`：命令处理器校验参数、
 *     生成 slug 与产物目录、写 meta.json(pending)，读取自定义模式（modes/*.json），
 *     然后把"工作流提示词"（含模式表/视图词表/spec 规范/风格铁律）以 user 消息
 *     注入当前 agent —— 与官方 /goal 命令同款：invocation.agent.followup(
 *     createUserMessage(...))。
 *  2. 主 agent 按提示词：理解内容 → 调研 → 定「生成计划」{mode, views:[…]} →
 *     写 `$DSH_HOME/facet/<slug>/spec.json` → 用 subagent 工具为**每个视图**并行
 *     派发一个独立子代理 → 生成 `<kind>.html`（diagram/tower/network/flow/timeline）。
 *  3. 主 agent 调 `facet_ready` 工具：宿主校验视图文件、写 meta.views、通过 SSE
 *     广播浮窗事件（载荷含 views），并把各视图访问链接回给 agent 放进最终回复。
 *
 * 设计纪律（与 prompts.mjs 同源）：**渲染层封闭**（视图词表 5 种 + 固定色板，
 * 风格永不崩）、**语义层开放**（模式/schema/映射可生长；OOD 时可用 generic 兜底，
 * 或按【自造模式规范】现场合成新模式存入 modes/ 供复用——"框架自己长大"）。
 *
 * HTTP（本机，经 ctx.webServer 可选挂载）：
 *  - GET /dsh-facet/              产物索引页（按视图清单出链）
 *  - GET /dsh-facet/events        SSE：浮窗“ready”事件（载荷含 views）
 *  - GET /dsh-facet/health        健康检查
 *  - GET /dsh-facet/debug/broadcast?slug=X   本机调试：立刻广播一次 ready（不触碰 meta）
 *  - GET /dsh-facet/<slug>/<file> 产物文件（diagram.html / tower.html / spec.json 等）
 *
 * @module dsh-facet
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { STYLE_BLOCK, VIEW_KINDS, MODES, SPEC_BLOCK, buildWorkflowPrompt } from './prompts.mjs'

// 提示词常量经本模块再导出（测试与外部消费的稳定入口）
export { STYLE_BLOCK, VIEW_KINDS, MODES, SPEC_BLOCK, buildWorkflowPrompt }

export const name = 'dsh-facet'
// webServer 刻意不放进顶层 inject：headless 等没有 web 服务的几何下，
// 强依赖会让整个插件卡在 pending（dsh-bite 实测过的坑）。命令与工具是核心能力。
export const inject = ['commands', 'tools']

export const Config = Schema.object({
  homeDir: Schema.string().default('').description('产物根目录（默认 $DSH_HOME/facet）'),
  readyPing: Schema.boolean().default(true).description('产物就绪后向客户端推送"弹出浮窗"事件（无客户端时静默跳过）'),
})

export const ROUTE_PREFIX = '/dsh-facet'
export const SOURCE_KIND = 'dsh-facet'
export const COMMAND_NAME = 'visualize'

/** 产物目录名安全规则（同时用于路由防穿越）。 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

// ---------------------------------------------------------------------------
// 工具函数

/** 产物根目录：config.homeDir > $DSH_HOME/facet > ~/.dsh/facet */
export function facetRoot(config) {
  if (config !== undefined && typeof config.homeDir === 'string' && config.homeDir.trim().length > 0) {
    return config.homeDir.trim()
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'facet')
}

/**
 * 从查询生成 slug：arXiv 链接/编号 → arxiv-<id>；其余转 kebab-case；
 * 纯中文等无法转写时用内容哈希兜底（保证不同查询不互相覆盖）。
 */
export function slugify(input) {
  const s = String(input ?? '').trim()
  if (s.length === 0) return 'req'
  const urlMatch = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(s)
  const bareMatch = /^(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(s)
  const arxivId = urlMatch !== null ? urlMatch[1] : (bareMatch !== null ? bareMatch[1] : undefined)
  if (arxivId !== undefined) return `arxiv-${arxivId.replace(/\./g, '-')}`
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
  if (slug.length === 0) {
    const hash = createHash('sha1').update(s).digest('hex').slice(0, 8)
    slug = `req-${hash}`
  }
  return slug
}

/**
 * 读取自定义模式（OOD 自造，存于 <root>/modes/*.json）。
 * 约束：name 小写 kebab（2-32）；views ⊆ 视图词表（1-3 个）；colors 只做展示。
 * 坏文件静默跳过（框架不被一颗坏 JSON 卡死）。
 */
export function loadCustomModes(root) {
  const dir = path.join(root, 'modes')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const modeName = String(m?.name ?? '').trim()
      if (!/^[a-z0-9-]{2,32}$/.test(modeName)) continue
      const views = Array.isArray(m?.views) ? m.views.filter((v) => typeof v === 'string' && VIEW_KINDS[v] !== undefined).slice(0, 3) : []
      if (views.length === 0) continue
      const colors = m?.colors !== undefined && typeof m.colors === 'object' && m.colors !== null ? m.colors : {}
      out.push({ name: modeName, label: String(m?.label ?? modeName), views, colors })
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out
}

/**
 * 解析某产物的视图清单（三跳回退）：
 *  1. meta.views（ready 写入的标准路径）
 *  2. 目录扫描视图词表文件名（diagram.html / tower.html / ...）
 *  3. 旧版 2d.html / 3d.html（向后兼容）
 * @returns {Array<{kind: string, file: string, title: string}>}
 */
export function resolveViews(root, slug) {
  const dir = path.join(root, slug)
  const meta = readMeta(dir)
  if (Array.isArray(meta?.views) && meta.views.length > 0) {
    const out = []
    for (const v of meta.views) {
      const kind = String(v?.kind ?? '')
      if (kind.length === 0) continue
      const file = typeof v.file === 'string' && v.file.length > 0 ? v.file : (VIEW_KINDS[kind]?.file ?? '')
      if (file.length === 0) continue
      const title = typeof v.title === 'string' && v.title.length > 0 ? v.title : (VIEW_KINDS[kind]?.title ?? kind)
      out.push({ kind, file, title })
    }
    if (out.length > 0) return out
  }
  const scanned = []
  for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
    if (fs.existsSync(path.join(dir, spec.file))) scanned.push({ kind, file: spec.file, title: spec.title })
  }
  if (scanned.length > 0) return scanned
  const legacy = []
  if (fs.existsSync(path.join(dir, '2d.html'))) legacy.push({ kind: 'diagram', file: '2d.html', title: '2D 结构图' })
  if (fs.existsSync(path.join(dir, '3d.html'))) legacy.push({ kind: 'tower', file: '3d.html', title: '3D 视图' })
  return legacy
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(html)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

function contentTypeFor(fp) {
  return CONTENT_TYPES[path.extname(fp).toLowerCase()] ?? 'application/octet-stream'
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function writeMeta(dir, meta) {
  try {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  } catch {
    /* 元数据写失败不阻断主流程 */
  }
}

// ---------------------------------------------------------------------------
// SSE 枢纽（浮窗自动弹出的通知通道）

const sseClients = new Set()

export function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of [...sseClients]) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

function sseCloseAll() {
  for (const res of [...sseClients]) {
    try {
      res.end()
    } catch {
      /* 客户端已断开 */
    }
  }
  sseClients.clear()
}

// ---------------------------------------------------------------------------
// 命令：/visualize

export async function cmdSearchModel(invocation, deps) {
  const query = String(invocation.rawInput ?? '').trim()
  if (query.length === 0) {
    return { kind: 'error', text: '用法：/visualize <模型名 | arXiv 链接 | 一句话需求>（例：/visualize Llama-3-8B，或 /visualize 把 GRPO 的训练流程画出来）' }
  }
  const slug = slugify(query)
  if (!SAFE_SLUG.test(slug)) {
    return { kind: 'error', text: `无法为「${query}」生成安全的目录名（slug=${slug}），换个写法再试。` }
  }
  const dir = path.join(deps.root, slug)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { kind: 'error', text: `产物目录创建失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const meta = readMeta(dir)
  writeMeta(dir, {
    slug,
    query,
    createdAt: meta?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending',
  })

  let customModes = []
  try {
    customModes = loadCustomModes(deps.root)
  } catch {
    /* 坏模式目录不阻断 */
  }
  const prompt = buildWorkflowPrompt({
    query,
    slug,
    dir,
    modesDir: path.join(deps.root, 'modes'),
    customModes,
  })
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: SOURCE_KIND, subtype: 'workflow', slug, query },
  }))

  return { kind: 'success', text: `dsh-facet 已就位：正在调研「${query}」并生成图谱计划（产物目录 facet/${slug}/）。` }
}

// ---------------------------------------------------------------------------
// 工具：facet_ready

function buildReadyTool(deps) {
  const { root, config, ctx } = deps
  const kindList = Object.keys(VIEW_KINDS).join(' | ')
  return defineTool({
    name: 'facet_ready',
    description: `校验 dsh-facet 产物视图（按视图词表 ${kindList} 对应的 <kind>.html）并通知界面自动弹出可视化窗口；返回各视图访问链接。在 /visualize 工作流的所有子代理完成后调用一次。`,
    parameters: {
      slug: {
        type: 'string',
        required: true,
        description: '产物目录名（/visualize 命令输出的 slug，例如 llama-3-8b / arxiv-2407-21783 / req-1a2b3c4d）',
      },
      mode: {
        type: 'string',
        description: '生成计划里的模式名（如 model-architecture / rl-training / red-team / workflow / generic 或自定义模式名；仅用于记录）',
      },
      views: {
        type: 'array',
        description: `生成计划的视图清单：每项 = 一个已生成的视图（kind 取自词表 ${kindList}；title 可自定义）。缺省时回退读取 meta.views 或扫描目录。最多 3 项。`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, description: `视图种类（${kindList}）` },
            title: { type: 'string', description: '窗口标题（缺省用词表标题）' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
          message: { type: 'string', required: true },
          urls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
          missing: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const slug = String(args.slug ?? '').trim()
      if (!SAFE_SLUG.test(slug)) {
        return { ok: false, slug, message: `slug "${slug}" 非法：只允许小写字母/数字/中划线（≤64 字符）。请用 /visualize 输出的 slug 重试。` }
      }
      const dir = path.join(root, slug)

      // 解析视图清单：参数 > meta > 目录扫描（含 legacy 回退）
      let views = []
      if (Array.isArray(args.views) && args.views.length > 0) {
        const badKinds = []
        for (const v of args.views) {
          const kind = String(v?.kind ?? '').trim()
          if (VIEW_KINDS[kind] === undefined) {
            badKinds.push(kind.length > 0 ? kind : '(空)')
            continue
          }
          if (views.some((x) => x.kind === kind)) continue
          const title = String(v?.title ?? '').trim()
          views.push({ kind, file: VIEW_KINDS[kind].file, title: title.length > 0 ? title : VIEW_KINDS[kind].title })
        }
        if (badKinds.length > 0) {
          return { ok: false, slug, message: `views 里出现未知 kind：${badKinds.join('、')}。只允许：${kindList}。` }
        }
        if (views.length > 3) {
          return { ok: false, slug, message: 'views 最多 3 个（视图数 = 子代理数上限）。' }
        }
      }
      if (views.length === 0) views = resolveViews(root, slug)
      if (views.length === 0) {
        return {
          ok: false,
          slug,
          message: `目录 ${dir} 下没有找到任何视图文件（按词表 ${kindList} 或 legacy 2d.html/3d.html 扫描）。请先让子代理产出，再调用 facet_ready。`,
        }
      }

      const missing = views.filter((v) => !fs.existsSync(path.join(dir, v.file))).map((v) => v.file)
      if (missing.length > 0) {
        return {
          ok: false,
          slug,
          message: `产物尚未就绪：缺少 ${missing.join('、')}。请确认对应子代理已完成并写入 ${dir}/，然后再次调用 facet_ready。`,
          missing,
        }
      }

      const meta = readMeta(dir) ?? { slug }
      const mode = typeof args.mode === 'string' && args.mode.trim().length > 0
        ? args.mode.trim().slice(0, 64)
        : (typeof meta.mode === 'string' && meta.mode.length > 0 ? meta.mode : undefined)
      writeMeta(dir, {
        ...meta,
        slug,
        ...(mode !== undefined ? { mode } : {}),
        views,
        updatedAt: new Date().toISOString(),
        status: 'ready',
      })
      const urls = views.map((v) => ({ kind: v.kind, title: v.title, url: `${ROUTE_PREFIX}/${slug}/${v.file}` }))
      if (config.readyPing) {
        sseBroadcast('ready', {
          slug,
          query: meta.query ?? slug,
          mode: mode ?? null,
          views: urls,
        })
      }
      try {
        ctx.logger.info(`[dsh-facet] 产物就绪：${slug}（${views.map((v) => v.kind).join(' + ')}）`)
      } catch {
        /* logger 不可用时忽略 */
      }
      const linkText = urls.map((u) => `${u.url}（${u.title}）`).join(' 与 ')
      return {
        ok: true,
        slug,
        message: `产物就绪并已通知界面。请把链接放进最终回复：${linkText}。`,
        urls,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// HTTP 路由

function renderIndexPage(root) {
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'modes' && SAFE_SLUG.test(d.name))
      .map((d) => d.name)
  } catch {
    /* 目录不可读时给空列表 */
  }
  const items = names.map((slug) => {
    const meta = readMeta(path.join(root, slug))
    const views = resolveViews(root, slug)
    const title = escapeHtml(meta?.query ?? slug)
    const links = views.length > 0
      ? views.map((v) => `<a href="./${slug}/${encodeURIComponent(v.file)}">${escapeHtml(v.title)}</a>`).join(' · ')
      : '（无产物）'
    const status = meta?.status === 'ready' ? '✅' : '⏳'
    const modeTag = typeof meta?.mode === 'string' && meta.mode.length > 0 ? ` <small>[${escapeHtml(meta.mode)}]</small>` : ''
    return `<li><b>${title}</b> <small><code>${slug}</code></small>${modeTag} — ${links} ${status}</li>`
  }).join('\n')
  const customModes = loadCustomModes(root)
  const modesLine = customModes.length > 0
    ? `<p><small>自定义模式：${customModes.map((m) => `${escapeHtml(m.name)}（${escapeHtml(m.label)}）`).join(' · ')}</small></p>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-facet</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#212529;margin:40px;max-width:760px;line-height:1.6}li{margin:8px 0}a{color:#1C7ED6}code{color:#868E96}</style></head><body><h1>dsh-facet</h1><p>已生成的图谱（在对话里用 <code>/visualize &lt;名字 | arXiv 链接 | 一句话需求&gt;</code> 生成新的）：</p><ul>\n${items.length > 0 ? items : '<li>（空）</li>'}\n</ul>${modesLine}</body></html>`
}

export function makeRouteHandler(root) {
  return async function routeHandler(req, res) {
    try {
      const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
      const route = url.pathname

      if (route === `${ROUTE_PREFIX}/health`) {
        return sendJson(res, 200, { ok: true, plugin: 'dsh-facet' })
      }

      // 本机调试：立刻广播一次 ready（供浮窗链路活体验证用，不触碰 meta）
      if (route === `${ROUTE_PREFIX}/debug/broadcast` && req.method === 'GET') {
        const slug = url.searchParams.get('slug') ?? ''
        if (!SAFE_SLUG.test(slug)) return sendJson(res, 400, { ok: false, code: 'bad-slug' })
        const views = resolveViews(root, slug)
        if (views.length === 0) return sendJson(res, 404, { ok: false, code: 'no-views' })
        const meta = readMeta(path.join(root, slug))
        sseBroadcast('ready', {
          slug,
          query: meta?.query ?? slug,
          mode: meta?.mode ?? null,
          views: views.map((v) => ({ kind: v.kind, title: v.title, url: `${ROUTE_PREFIX}/${slug}/${v.file}` })),
        })
        return sendJson(res, 200, { ok: true, broadcast: 'ready', slug, views: views.map((v) => v.file) })
      }

      if (route === `${ROUTE_PREFIX}/events`) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': dsh-facet connected\n\n')
        sseClients.add(res)
        const cleanup = () => sseClients.delete(res)
        if (typeof res.on === 'function') {
          res.on('close', cleanup)
          res.on('error', cleanup)
        }
        return
      }

      if (route === ROUTE_PREFIX || route === `${ROUTE_PREFIX}/`) {
        return sendHtml(res, 200, renderIndexPage(root))
      }

      if (!route.startsWith(`${ROUTE_PREFIX}/`)) {
        return sendJson(res, 404, { ok: false, code: 'not-found' })
      }
      const rest = route.slice(ROUTE_PREFIX.length + 1)
      const segs = rest.split('/').map((s) => decodeURIComponent(s))
      const slug = segs[0] ?? ''
      if (!SAFE_SLUG.test(slug) || slug === 'modes') {
        return sendJson(res, 404, { ok: false, code: 'bad-slug' })
      }
      const dir = path.join(root, slug)
      if (segs.length === 1) {
        // 目录级 landing：列出可用文件
        let files = []
        try {
          files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
        } catch {
          return sendJson(res, 404, { ok: false, code: 'no-dir' })
        }
        const lis = files.map((f) => `<li><a href="./${slug}/${escapeHtml(f)}">${escapeHtml(f)}</a></li>`).join('\n')
        return sendHtml(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(slug)}</title></head><body style="font-family:system-ui;background:#fff;color:#212529;margin:40px"><h1>${escapeHtml(slug)}</h1><ul>\n${lis}\n</ul></body></html>`)
      }
      const rel = segs.slice(1).join('/')
      if (rel.includes('..') || rel.startsWith('/') || rel.length === 0) {
        return sendJson(res, 404, { ok: false, code: 'bad-path' })
      }
      const fp = path.normalize(path.join(dir, rel))
      if (!fp.startsWith(dir + path.sep)) {
        return sendJson(res, 404, { ok: false, code: 'bad-path' })
      }
      let stat
      try {
        stat = fs.statSync(fp)
      } catch {
        return sendJson(res, 404, { ok: false, code: 'not-found' })
      }
      if (!stat.isFile()) {
        return sendJson(res, 404, { ok: false, code: 'not-found' })
      }
      res.writeHead(200, { 'content-type': contentTypeFor(fp), 'content-length': stat.size, 'cache-control': 'no-cache' })
      res.end(fs.readFileSync(fp))
    } catch (error) {
      try {
        sendJson(res, 500, { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) })
      } catch {
        /* 响应头已发出时忽略 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 插件入口

export function apply(ctx, config) {
  const root = facetRoot(config)
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    ctx.logger.warn(`[dsh-facet] 产物目录创建失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const deps = { ctx, config, root }

  // 斜杠命令
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('dsh-facet/visualize'),
      name: COMMAND_NAME,
      description: 'facet：调研内容并生成 2D/3D 图谱（模型名 / arXiv 链接 / 一句话需求皆可）',
      input: { hint: '模型名、arXiv 链接或一句需求（例：Llama-3-8B / https://arxiv.org/abs/2407.21783 / 把 GRPO 训练流程画出来）' },
      handler: (invocation) => cmdSearchModel(invocation, deps),
    })
  }, 'dsh-facet: commands')

  // 就绪工具
  ctx.effect(function* () {
    yield ctx.tools.register(buildReadyTool(deps))
  }, 'dsh-facet: ready tool')

  // HTTP 路由（webServer 可选：headless 等几何下不存在，跳过即可）
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        const dispose = scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: makeRouteHandler(root),
        })
        return () => {
          sseCloseAll()
          dispose()
        }
      }, 'dsh-facet: routes')
    })
  } catch (error) {
    ctx.logger.warn(`[dsh-facet] 路由注册失败（无 web 服务时忽略）: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => {
    const banner = `[dsh-facet] 已加载（产物目录 ${root}，命令 /${COMMAND_NAME}，模式 ${Object.keys(MODES).length} 个）`
    ctx.logger.info(banner)
    console.log(banner)
    return () => ctx.logger.info('[dsh-facet] 已卸载')
  })
}
