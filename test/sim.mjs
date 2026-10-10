/**
 * dsh-facet 仿真测试台。
 *
 * 用假 ctx / 假 agent / 假 http 驱动全部宿主逻辑，不触网、不跑模型：
 *  1. 命令注册形状（名称合法性/输入提示/handler）
 *  2. slugify 全部路径（名称 / arXiv 链接 / arXiv 号 / 中文兜底哈希）
 *  3. cmdSearchModel：参数校验 / 目录与 meta 落盘 / followup 消息形状 / 提示词内容
 *  4. facet_ready 工具：非法 slug / 缺产物 / 产物就绪 / meta 状态 / 广播
 *  5. SSE：订阅 → ready 广播 → 收到事件 → 断开清理
 *  6. HTTP 路由：health / 索引页 / 文件伺服 / 路径穿越防御 / 非法 slug
 *  7. webServer 缺席时插件仍可加载（headless 几何）
 *
 * 运行：node test/sim.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as mod from '../src/index.mjs'

const {
  apply, cmdSearchModel, slugify, facetRoot, makeRouteHandler, buildWorkflowPrompt,
  STYLE_BLOCK, LAYOUT_BLOCK, SPEC_SCHEMA_BLOCK, COMMAND_NAME, ROUTE_PREFIX, SOURCE_KIND,
} = mod

let passed = 0
let failed = 0
function ok(label, cond) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed += 1; console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`) }
}
function section(title) { console.log(`\n═══ ${title}`) }

// ── 假驱动 ────────────────────────────────────────────────────────────────

const ROOT = path.join(os.homedir(), 'tmp', 'facet-sim')
fs.rmSync(ROOT, { recursive: true, force: true })

function makeRes() {
  const res = {
    status: null, headers: null, body: null, writes: [], ended: false, listeners: {},
    writeHead(s, h) { res.status = s; res.headers = h },
    write(c) { res.writes.push(String(c)) },
    end(c) { if (c !== undefined) res.body = c; res.ended = true },
    on(name, fn) { (res.listeners[name] ??= []).push(fn) },
  }
  return res
}

function makeEnv({ withWebServer = true } = {}) {
  const commands = []
  const tools = []
  const routes = []
  const logs = []
  const followups = []
  const scoped = {
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
    },
    effect: (fn) => { fn(); return () => {} },
  }
  const fakeAgent = {
    followup: (msg) => { followups.push(msg) },
  }
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
    },
    effect: (fn) => {
      const r = fn()
      if (r && typeof r.next === 'function') {
        let step = r.next()
        while (!step.done) step = r.next(step.value)
      }
      return () => {}
    },
    inject: (names, cb) => {
      if (!withWebServer) throw new Error('service unavailable: webServer')
      cb(scoped)
    },
    commands: { register: (def) => { commands.push(def); return () => {} } },
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, commands, tools, routes, logs, followups, fakeAgent, config: { homeDir: ROOT, readyPing: true } }
}

// ── ① 命令注册 ────────────────────────────────────────────────────────────

section('① 命令注册')
{
  const env = makeEnv()
  apply(env.ctx, env.config)
  eq('注册了且仅注册一条命令', env.commands.length, 1)
  const cmd = env.commands[0]
  eq('命令名', cmd.name, 'visualize')
  ok('命令名符合 DSH 正则 /^[a-z][a-z0-9_-]*$/', /^[a-z][a-z0-9_-]*$/.test(cmd.name))
  ok('带 input.hint 提示', typeof cmd.input?.hint === 'string' && cmd.input.hint.length > 0)
  eq('handler 是函数', typeof cmd.handler, 'function')
  ok('带 definitionId', cmd.definitionId !== undefined)

  section('①b 工具注册（facet_ready）')
  eq('注册了一个工具', env.tools.length, 1)
  const tool = env.tools[0]
  eq('工具名', tool.name, 'facet_ready')
  eq('execute 是函数', typeof tool.execute, 'function')

  section('①c 路由注册（有 webServer）')
  eq('注册了一条路由', env.routes.length, 1)
  eq('路由前缀', env.routes[0].path, ROUTE_PREFIX)
  eq('路由 kind', env.routes[0].kind, 'prefix')

  section('①d banner 日志')
  ok('启动横幅包含命令名', env.logs.some(([, msg]) => String(msg).includes('dsh-facet')))
}

// ── ② slugify ─────────────────────────────────────────────────────────────

section('② slugify')
eq('普通名称', slugify('Llama-3-8B'), 'llama-3-8b')
eq('arXiv 链接', slugify('https://arxiv.org/abs/2407.21783'), 'arxiv-2407-21783')
eq('arXiv 链接（PDF）', slugify('https://arxiv.org/pdf/2407.21783v2'), 'arxiv-2407-21783')
eq('裸 arXiv 号', slugify('2407.21783'), 'arxiv-2407-21783')
eq('带符号名称', slugify('Qwen3.5-0.8B_GDN2!'), 'qwen3-5-0-8b-gdn2')
eq('中文名称走哈希兜底', /^model-[0-9a-f]{8}$/.test(slugify('混元大模型')), true)
eq('中文兜底稳定（同输入同输出）', slugify('混元大模型'), slugify('混元大模型'))
ok('不同中文输入不撞车', slugify('混元大模型') !== slugify('文心一言'))
eq('空输入 → model', slugify('   '), 'model')
ok('超长截断 ≤64', slugify('a'.repeat(200)).length <= 64)

// ── ③ cmdSearchModel ──────────────────────────────────────────────────────

section('③ cmdSearchModel')
{
  const env = makeEnv()
  const inv = { rawInput: 'Llama-3-8B', agent: env.fakeAgent, signal: new AbortController().signal }
  const result = await cmdSearchModel(inv, { ctx: env.ctx, config: env.config, root: ROOT })
  eq('返回 success', result.kind, 'success')
  ok('提示语提到 slug', result.text.includes('llama-3-8b'))
  eq('followup 调用一次', env.followups.length, 1)
  const msg = env.followups[0]
  eq('消息 role', msg.role, 'user')
  eq('内容为首个 text 块', msg.content?.[0]?.type, 'text')
  const text = msg.content[0].text
  ok('提示词含查询名', text.includes('Llama-3-8B'))
  ok('提示词含产物目录绝对路径', text.includes(path.join(ROOT, 'llama-3-8b')))
  ok('提示词含风格铁律（hex）', text.includes('#E8590C') && text.includes('#FFFFFF'))
  ok('提示词含布局约定', text.includes('×N'))
  ok('提示词含 spec schema 关键词', text.includes('embedding') && text.includes('attention'))
  ok('提示词含 subagent 指引', text.includes('subagent'))
  ok('提示词含 subagent_ready 收尾指引', text.includes('facet_ready'))
  eq('消息 source.kind', msg.source?.kind, SOURCE_KIND)
  eq('消息 source.subtype', msg.source?.subtype, 'workflow')
  eq('消息 source.slug', msg.source?.slug, 'llama-3-8b')
  ok('目录已创建', fs.existsSync(path.join(ROOT, 'llama-3-8b')))
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'llama-3-8b', 'meta.json'), 'utf8'))
  eq('meta.query', meta.query, 'Llama-3-8B')
  eq('meta.status', meta.status, 'pending')
}
{
  const env = makeEnv()
  const result = await cmdSearchModel({ rawInput: '  ', agent: env.fakeAgent, signal: new AbortController().signal }, { ctx: env.ctx, config: env.config, root: ROOT })
  eq('空参数 → error', result.kind, 'error')
  eq('空参数不触发 followup', env.followups.length, 0)
}

// ── ④ facet_ready 工具 ─────────────────────────────────────────────────

section('④ facet_ready')
{
  const env = makeEnv()
  apply(env.ctx, env.config)
  const tool = env.tools[0]

  const r1 = await tool.execute({ slug: 'INVALID SLUG!' }, {})
  eq('非法 slug → ok:false', r1.ok, false)
  ok('非法 slug 提示原因', r1.message.includes('非法'))

  const r2 = await tool.execute({ slug: 'ready-test' }, {})
  eq('缺产物 → ok:false', r2.ok, false)
  eq('缺产物清单', r2.missing, ['2d.html', '3d.html'])

  const dir = path.join(ROOT, 'ready-test')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2d.html'), '<html>2d</html>')
  const r3 = await tool.execute({ slug: 'ready-test' }, {})
  eq('只有 2d → ok:false', r3.ok, false)
  eq('缺 3d', r3.missing, ['3d.html'])
  eq('已有 2d 时返回其路径', r3.twoD, `${ROUTE_PREFIX}/ready-test/2d.html`)

  fs.writeFileSync(path.join(dir, '3d.html'), '<html>3d</html>')
  const r4 = await tool.execute({ slug: 'ready-test' }, {})
  eq('齐全 → ok:true', r4.ok, true)
  eq('twoD 路径', r4.twoD, `${ROUTE_PREFIX}/ready-test/2d.html`)
  eq('threeD 路径', r4.threeD, `${ROUTE_PREFIX}/ready-test/3d.html`)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  eq('meta 状态 → ready', meta.status, 'ready')
}

// ── ⑤ SSE ────────────────────────────────────────────────────────────────

section('⑤ SSE 订阅与广播')
{
  const env = makeEnv()
  apply(env.ctx, env.config)
  const handler = env.routes[0].handler

  const res = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/events`, method: 'GET' }, res)
  eq('SSE 头 content-type', res.headers['content-type'], 'text/event-stream; charset=utf-8')
  ok('SSE 建立连接注释已写', res.writes.some((w) => w.includes('connected')))

  // 触发 ready 广播
  await env.tools[0].execute({ slug: 'ready-test' }, {})
  const payload = res.writes.join('')
  ok('收到 ready 事件', payload.includes('event: ready'))
  ok('事件含 slug', payload.includes('"slug":"ready-test"'))
  ok('事件含 twoD', payload.includes('ready-test/2d.html'))

  // 断开清理：重复广播不应再写入
  for (const fn of res.listeners.close ?? []) fn()
  const before = res.writes.length
  await env.tools[0].execute({ slug: 'ready-test' }, {})
  eq('断开后不再写入', res.writes.length, before)
  eq('日志记录产物就绪', env.logs.some(([, msg]) => String(msg).includes('产物就绪')), true)
}

// ── ⑥ HTTP 路由 ───────────────────────────────────────────────────────────

section('⑥ HTTP 路由')
{
  const handler = makeRouteHandler(ROOT)

  const h = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/health`, method: 'GET' }, h)
  eq('health 200', h.status, 200)
  ok('health 内容', String(h.body).includes('dsh-facet'))

  const idx = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/`, method: 'GET' }, idx)
  eq('索引页 200', idx.status, 200)
  ok('索引页包含 ready-test 链接', String(idx.body).includes('ready-test/2d.html'))

  const file = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/2d.html`, method: 'GET' }, file)
  eq('文件 200', file.status, 200)
  eq('文件 content-type', file.headers['content-type'], 'text/html; charset=utf-8')
  eq('文件内容', String(file.body), '<html>2d</html>')

  const miss = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/nope.html`, method: 'GET' }, miss)
  eq('缺失文件 404', miss.status, 404)

  const badSlug = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/UPPER/2d.html`, method: 'GET' }, badSlug)
  eq('非法 slug 404', badSlug.status, 404)

  const traversal = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/%2E%2E/meta.json`, method: 'GET' }, traversal)
  eq('路径穿越 404', traversal.status, 404)

  const landing = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test`, method: 'GET' }, landing)
  eq('目录 landing 200', landing.status, 200)
  ok('landing 列出文件', String(landing.body).includes('2d.html'))

  // debug 广播端点：订阅 → 广播 → 收到 → 非法 slug 400
  const sub = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/events`, method: 'GET' }, sub)
  const dbg = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/debug/broadcast?slug=ready-test`, method: 'GET' }, dbg)
  eq('debug 广播 200', dbg.status, 200)
  ok('debug 广播送达订阅者', sub.writes.join('').includes('"slug":"ready-test"'))
  ok('debug 广播带 twoD 链接', sub.writes.join('').includes('ready-test/2d.html'))
  const dbgBad = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/debug/broadcast?slug=BAD!`, method: 'GET' }, dbgBad)
  eq('debug 非法 slug 400', dbgBad.status, 400)
  for (const fn of sub.listeners.close ?? []) fn()
}

// ── ⑦ webServer 缺席 ──────────────────────────────────────────────────────

section('⑦ webServer 缺席（headless 几何）')
{
  const env = makeEnv({ withWebServer: false })
  let threw = false
  try {
    apply(env.ctx, env.config)
  } catch {
    threw = true
  }
  eq('apply 不抛异常', threw, false)
  eq('命令仍注册', env.commands.length, 1)
  eq('工具仍注册', env.tools.length, 1)
  eq('无路由注册', env.routes.length, 0)
  ok('有警告日志', env.logs.some(([level]) => level === 'warn'))
}

// ── ⑧ 常量完整性 ──────────────────────────────────────────────────────────

section('⑧ 风格/布局常量')
ok('STYLE_BLOCK 含全部关键色值', ['#7048E8', '#E8590C', '#1C7ED6', '#2F9E44', '#AE3EC9', '#343A40', '#ADB5BD', '#FA5252'].every((c) => STYLE_BLOCK.includes(c)))
ok('LAYOUT_BLOCK 含分组规则', LAYOUT_BLOCK.includes('×N') && LAYOUT_BLOCK.includes('自上而下'))
ok('SPEC_SCHEMA_BLOCK 含 type 枚举', SPEC_SCHEMA_BLOCK.includes('embedding') && SPEC_SCHEMA_BLOCK.includes('group'))
{
  const p = buildWorkflowPrompt({ query: 'X', slug: 'x', dir: '/d/x' })
  ok('提示词把风格块内联进子代理要求', p.includes('全文复制进每一份'))
  ok('提示词包含并行委派要求', p.includes('并行委派'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log(`\n════════════════════════════════════════`)
console.log(`  通过 ${passed} · 失败 ${failed}`)
console.log(`════════════════════════════════════════`)
process.exit(failed === 0 ? 0 : 1)
