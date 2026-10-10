/**
 * dsh-facet — 模型架构可视化：/visualize → 结构化 spec → 双子代理 → 2D/3D。
 *
 * 工作流（全部由宿主侧编排，智能活交给 agent）：
 *  1. 用户输入 `/visualize <模型名 | arXiv 链接>`（命令处理器校验参数、
 *     生成 slug 与产物目录、写 v meta.json，然后把"工作流提示词"以 user 消息
 *     注入当前 agent —— 与官方 /goal 命令同款：invocation.agent.followup(
 *     createUserMessage(...))）。
 *  2. 主 agent（按提示词）调研架构 → 写 `$DSH_HOME/facet/<slug>/spec.json`
 *     → 用 subagent 工具并行派发两个独立子代理 → 分别生成 2d.html / 3d.html。
 *  3. 主 agent 调 `facet_ready` 工具：宿主校验产物、更新 meta、通过 SSE
 *     通知客户端浮窗自动弹出，并把两个访问路径返回给 agent 放进最终回复。
 *
 * 风格一致性（本插件的灵魂）：STYLE_BLOCK / LAYOUT_BLOCK 是**唯一来源**，
 * 整段注入工作流提示词，并要求主 agent 全文复制进两份子代理提示词——
 * 用具体 hex 色值而不是颜色词，避免每次生成的视觉风格漂移。
 *
 * HTTP（本机，经 ctx.webServer 可选挂载）：
 *  - GET /dsh-facet/              产物索引页
 *  - GET /dsh-facet/events        SSE：浮窗“ready”事件
 *  - GET /dsh-facet/health        健康检查
 *  - GET /dsh-facet/debug/broadcast?slug=X   本机调试：立刻广播一次 ready（不触碰 meta）
 *  - GET /dsh-facet/<slug>/<file> 产物文件（2d.html / 3d.html / spec.json 等）
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
// 风格常量（唯一来源 —— 同时注入 2D 与 3D 两份子代理提示词）

export const STYLE_BLOCK = `【风格铁律 · 只允许以下色值】
- 画布背景：#FFFFFF 纯白（无渐变、无纹理）
- 层类型配色（主色，用于填充或描边）：
  · embedding（嵌入/词表）＝ #7048E8
  · attention（注意力）＝ #E8590C
  · ffn / moe（前馈/专家）＝ #1C7ED6
  · norm（归一化）＝ #2F9E44
  · state / recurrent（循环·状态类：SSM、GDN、Mamba 等线性注意力）＝ #AE3EC9
  · head（输出头）＝ #343A40
  · other（其它）＝ #868E96
  · 连线与残差 ＝ #ADB5BD（1.5px）
  · 重复组外框 ＝ #DEE2E6
- 特殊标记：
  · spec 中 custom:true 的块：本层主色 + 2px 加粗描边 + 右上角 ★
  · spec 中 confidence:"low" 的字段：虚线边框 + 右上角 #FA5252 的 "?"
- 文字：层名 #212529；维度/变体标注 #868E96 且小一号
- 块：圆角 8px、内边距充足、线宽统一 1.5px；不用半透明；禁止渐变、阴影滥用、emoji、装饰图案`

export const LAYOUT_BLOCK = `【布局约定】
- 数据流自上而下：输入（Token Embedding）→ 重复块组 → 输出头（LM Head）
- 重复组（group 节点）：一个外框（#DEE2E6）包住代表性子层，右上角标 "×N"；不要逐层复制
- 残差/跳跃连接：画在右侧，浅灰弧线
- 维度标注格式：d=4096 · h=32 · kv=8（用 · 分隔）
- 页脚（右下角小字）：<模型名> · dsh-facet · 来源：<来源链接>`

export const SPEC_SCHEMA_BLOCK = `{
  "model": "Llama-3-8B",                    // 模型名
  "params": "8.03B",                        // 参数量字符串（未知填 "unknown"）
  "contextLength": 8192,                    // 可选
  "sources": ["https://arxiv.org/abs/..."], // 来源链接列表
  "confidence": "high",                     // 总体置信：high | medium | low
  "notes": "歧义/低置信说明（可选）",
  "stack": [                                // 自上而下的层堆叠
    { "type": "embedding", "label": "Token Embedding", "dims": "vocab=128256 · d=4096", "confidence": "high" },
    { "type": "group", "label": "Transformer Layer", "count": 32, "children": [
      { "type": "norm", "label": "RMSNorm" },
      { "type": "attention", "variant": "GQA", "label": "Self-Attention (GQA)", "dims": "h=32 · kv=8" },
      { "type": "ffn", "variant": "SwiGLU", "label": "FFN (SwiGLU)", "dims": "d_ff=14336" }
    ]},
    { "type": "head", "label": "LM Head", "dims": "vocab=128256" }
  ]
}
type 枚举：embedding | attention | ffn | moe | norm | state | head | other | group
可选字段：variant（变体名）、custom:true（非标准/自研块）、confidence:"low"（低置信字段）`

/**
 * 构建注入主 agent 的工作流提示词。
 * @param {{query: string, slug: string, dir: string}} p
 */
export function buildWorkflowPrompt({ query, slug, dir }) {
  return `【dsh-facet · /visualize 工作流】
用户请求：/visualize ${query}

你的任务：为「${query}」建立结构化架构描述（spec），并生成 2D 与 3D 两张架构图。严格按以下步骤执行：

1) 调研架构。是 arXiv 链接就优先读论文本身（abs 页/HTML 版）；否则用搜索工具找官方模型卡或技术报告。需要收集：
   · 堆叠结构：层数与重复方式
   · 每层类型与变体（注意力类型、FFN 变体、归一化位置）
   · 关键维度（d_model、头数、kv 头数、FFN 维度、词表大小）
   · 参数量 · 特殊/非标准设计 · 来源链接（arXiv 号、模型卡）
   名称有歧义→取最主流版本并在 notes 注明；查不到的字段禁止编造：填 "unknown" 并标 confidence:"low"。

2) 写出 ${dir}/spec.json（目录不存在先创建）。严格按此 schema（注释只是说明，不要写进文件）：
${SPEC_SCHEMA_BLOCK}

3) 在回复里给用户一行摘要（不要贴 JSON）：
   「已建模：<模型> · <层结构简述> · <参数量> · 来源=<来源>」，并点名低置信字段。

4) 在【同一条消息】里用 subagent 工具发起两个并行委派（独立上下文）。两份提示词必须完整自包含，并把下面【风格铁律】【布局约定】全文复制进每一份：
   · 子代理 A → 生成 ${dir}/2d.html：单文件 HTML、零外部依赖（内联 CSS + 手写内联 SVG），自上而下的分层架构图；先读 spec.json 再动手。
   · 子代理 B → 生成 ${dir}/3d.html：单文件 HTML，three.js 自包含页面（importmap 引 CDN：https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js 与 https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js）；3D 分层堆叠视图、白色背景、柔和环境光、块=圆角盒、重复组=半透明外框+×N 标签块、可旋转缩放（触摸可用）、加载后缓慢自转、右下角 HTML 页脚覆盖层；先读 spec.json 再动手。

5) 两个子代理都完成后调用工具 facet_ready（slug="${slug}"）——它会校验产物、返回两个访问路径并通知界面自动弹出窗口。最终回复里给出它返回的链接；不要粘贴 HTML 源码。

${STYLE_BLOCK}

${LAYOUT_BLOCK}
`
}

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
  if (s.length === 0) return 'model'
  const urlMatch = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(s)
  const bareMatch = /^(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(s)
  const arxivId = urlMatch !== null ? urlMatch[1] : (bareMatch !== null ? bareMatch[1] : undefined)
  if (arxivId !== undefined) return `arxiv-${arxivId.replace(/\./g, '-')}`
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
  if (slug.length === 0) {
    const hash = createHash('sha1').update(s).digest('hex').slice(0, 8)
    slug = `model-${hash}`
  }
  return slug
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
// SSE 枢纽（浮窗自动弹出的通知通道 —— 形态与 dsh-bite 的客户端轮询不同，
// 这里用 EventSource：无需客户端 bundle 参与即可被任意前端订阅）

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
    return { kind: 'error', text: '用法：/visualize <模型名 | arXiv 链接>（例：/visualize Llama-3-8B）' }
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

  const prompt = buildWorkflowPrompt({ query, slug, dir })
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: SOURCE_KIND, subtype: 'workflow', slug, query },
  }))

  return { kind: 'success', text: `dsh-facet 已就位：正在调研「${query}」，将生成 2D/3D 架构图（产物目录 facet/${slug}/）。` }
}

// ---------------------------------------------------------------------------
// 工具：facet_ready

function buildReadyTool(deps) {
  const { root, config, ctx } = deps
  return defineTool({
    name: 'facet_ready',
    description: '校验 dsh-facet 产物（2d.html / 3d.html）并通知界面自动弹出可视化窗口；返回两个访问路径。在 /visualize 工作流的两个子代理都完成后调用一次。',
    parameters: {
      slug: {
        type: 'string',
        required: true,
        description: '产物目录名（/visualize 命令输出的 slug，例如 llama-3-8b 或 arxiv-2407-21783）',
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
          twoD: { type: 'string' },
          threeD: { type: 'string' },
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
      const twoD = path.join(dir, '2d.html')
      const threeD = path.join(dir, '3d.html')
      const has2d = fs.existsSync(twoD)
      const has3d = fs.existsSync(threeD)
      const missing = []
      if (!has2d) missing.push('2d.html')
      if (!has3d) missing.push('3d.html')
      if (missing.length > 0) {
        return {
          ok: false,
          slug,
          message: `产物尚未就绪：缺少 ${missing.join('、')}。请确认两个子代理已完成并写入 ${dir}/，然后再次调用 facet_ready。`,
          missing,
          ...(has2d ? { twoD: `${ROUTE_PREFIX}/${slug}/2d.html` } : {}),
          ...(has3d ? { threeD: `${ROUTE_PREFIX}/${slug}/3d.html` } : {}),
        }
      }
      const meta = readMeta(dir) ?? { slug }
      writeMeta(dir, { ...meta, slug, updatedAt: new Date().toISOString(), status: 'ready' })
      if (config.readyPing) {
        sseBroadcast('ready', { slug, query: meta.query ?? slug, twoD: `${ROUTE_PREFIX}/${slug}/2d.html`, threeD: `${ROUTE_PREFIX}/${slug}/3d.html` })
      }
      try {
        ctx.logger.info(`[dsh-facet] 产物就绪：${slug}`)
      } catch {
        /* logger 不可用时忽略 */
      }
      return {
        ok: true,
        slug,
        message: `产物就绪并已通知界面。请把这两个链接放进最终回复：${ROUTE_PREFIX}/${slug}/2d.html（2D）与 ${ROUTE_PREFIX}/${slug}/3d.html（3D）。`,
        twoD: `${ROUTE_PREFIX}/${slug}/2d.html`,
        threeD: `${ROUTE_PREFIX}/${slug}/3d.html`,
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
      .filter((d) => d.isDirectory() && SAFE_SLUG.test(d.name))
      .map((d) => d.name)
  } catch {
    /* 目录不可读时给空列表 */
  }
  const items = names.map((slug) => {
    const dir = path.join(root, slug)
    const meta = readMeta(dir)
    const has2d = fs.existsSync(path.join(dir, '2d.html'))
    const has3d = fs.existsSync(path.join(dir, '3d.html'))
    const title = escapeHtml(meta?.query ?? slug)
    const links = [
      has2d ? `<a href="./${slug}/2d.html">2D</a>` : '2D…',
      has3d ? `<a href="./${slug}/3d.html">3D</a>` : '3D…',
      meta?.status === 'ready' ? '✅' : '⏳',
    ].join(' · ')
    return `<li><b>${title}</b> <small><code>${slug}</code></small> — ${links}</li>`
  }).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-facet</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#212529;margin:40px;max-width:760px;line-height:1.6}li{margin:8px 0}a{color:#1C7ED6}code{color:#868E96}</style></head><body><h1>dsh-facet</h1><p>已生成的模型架构图（在对话里用 <code>/visualize &lt;模型名 | arXiv 链接&gt;</code> 生成新的）：</p><ul>\n${items.length > 0 ? items : '<li>（空）</li>'}\n</ul></body></html>`
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
        const meta = readMeta(path.join(root, slug))
        sseBroadcast('ready', {
          slug,
          query: meta?.query ?? slug,
          twoD: `${ROUTE_PREFIX}/${slug}/2d.html`,
          threeD: `${ROUTE_PREFIX}/${slug}/3d.html`,
        })
        return sendJson(res, 200, { ok: true, broadcast: 'ready', slug })
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
      if (!SAFE_SLUG.test(slug)) {
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
      description: 'facet：调研模型架构并生成 2D/3D 可视化（接受模型名或 arXiv 链接）',
      input: { hint: '模型名或 arXiv 链接（例：Llama-3-8B / https://arxiv.org/abs/2407.21783）' },
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
    const banner = `[dsh-facet] 已加载（产物目录 ${root}，命令 /${COMMAND_NAME}）`
    ctx.logger.info(banner)
    console.log(banner)
    return () => ctx.logger.info('[dsh-facet] 已卸载')
  })
}
