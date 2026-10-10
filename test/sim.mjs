/**
 * dsh-facet 仿真测试台 v2。
 *
 * 用假 ctx / 假 agent / 假 http 驱动全部宿主逻辑，不触网、不跑模型：
 *  ① 命令注册（/visualize）与工具注册（facet_ready）
 *  ② slugify（arxiv / kebab / 中文兜底 req- 前缀）
 *  ③ cmdSearchModel：自由输入 / 提示词 v2（模式表/视图词表/spec v2/自造模式）/ 自定义模式注入
 *  ④ facet_ready v2：views 校验（未知 kind/超限/缺文件）、meta 回退、扫描回退、legacy 回退
 *  ⑤ SSE：订阅 → ready 广播（载荷含 views）→ 断开清理
 *  ⑥ HTTP 路由：health / 索引（视图链+模式标记）/ 文件 / 穿越防御 / debug 广播（含 views）
 *  ⑦ webServer 缺席时仍可加载
 *  ⑧ 常量完整性（词表 5 种 / 模式 5 个 / 色板 / 提示词组装）
 *
 * 运行：node test/sim.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as mod from '../src/index.mjs'

const {
  apply, cmdSearchModel, slugify, facetRoot, makeRouteHandler, resolveViews, loadCustomModes,
  buildWorkflowPrompt, STYLE_BLOCK, VIEW_KINDS, MODES, SPEC_BLOCK,
  COMMAND_NAME, ROUTE_PREFIX, SOURCE_KIND,
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

function writeDemoDir(slug, files) {
  const dir = path.join(ROOT, slug)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

// ── ① 命令与工具注册 ──────────────────────────────────────────────────────

section('① 命令注册')
{
  const env = makeEnv()
  apply(env.ctx, env.config)
  eq('注册了且仅注册一条命令', env.commands.length, 1)
  const cmd = env.commands[0]
  eq('命令名', cmd.name, 'visualize')
  ok('命令名符合 DSH 正则', /^[a-z][a-z0-9_-]*$/.test(cmd.name))
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
  ok('启动横幅含模式数', env.logs.some(([, msg]) => String(msg).includes('模式 5 个')))
}

// ── ② slugify ─────────────────────────────────────────────────────────────

section('② slugify')
eq('普通名称', slugify('Llama-3-8B'), 'llama-3-8b')
eq('arXiv 链接', slugify('https://arxiv.org/abs/2407.21783'), 'arxiv-2407-21783')
eq('arXiv 链接（PDF）', slugify('https://arxiv.org/pdf/2407.21783v2'), 'arxiv-2407-21783')
eq('裸 arXiv 号', slugify('2407.21783'), 'arxiv-2407-21783')
eq('带符号名称', slugify('Qwen3.5-0.8B_GDN2!'), 'qwen3-5-0-8b-gdn2')
eq('纯中文需求走哈希兜底（req- 前缀）', /^req-[0-9a-f]{8}$/.test(slugify('把训练流程画出来')), true)
eq('中英混合保留拉丁词干', slugify('把 GRPO 的训练流程画出来'), 'grpo')
eq('中文兜底稳定', slugify('把训练流程画出来'), slugify('把训练流程画出来'))
ok('不同中文输入不撞车', slugify('红蓝关系') !== slugify('训练管线'))
eq('空输入 → req', slugify('   '), 'req')
ok('超长截断 ≤64', slugify('a'.repeat(200)).length <= 64)

// ── ③ cmdSearchModel（自由输入 + 提示词 v2） ──────────────────────────────

section('③ cmdSearchModel')
{
  const env = makeEnv()
  const query = '把 GRPO 的 RL 训练流程画出来 https://arxiv.org/abs/2402.03300'
  const inv = { rawInput: query, agent: env.fakeAgent, signal: new AbortController().signal }
  const result = await cmdSearchModel(inv, { ctx: env.ctx, config: env.config, root: ROOT })
  eq('返回 success', result.kind, 'success')
  ok('提示语提到图谱计划', result.text.includes('图谱计划'))
  eq('followup 调用一次', env.followups.length, 1)
  const msg = env.followups[0]
  eq('消息 role', msg.role, 'user')
  const text = msg.content[0].text
  ok('提示词含查询原文', text.includes('GRPO'))
  ok('提示词含产物目录绝对路径', text.includes(path.join(ROOT, 'arxiv-2402-03300')))
  ok('提示词含 5 个模式名', ['model-architecture', 'rl-training', 'red-team', 'workflow', 'generic'].every((m) => text.includes(m)))
  ok('提示词含 5 种视图 kind', ['diagram', 'tower', 'network', 'flow', 'timeline'].every((k) => text.includes(k)))
  ok('提示词含 spec v2 关键词', text.includes('"nodes"') && text.includes('"edges"') && text.includes('"groups"'))
  ok('提示词含摘要行格式', text.includes('将生成 N 张图'))
  ok('提示词含自造模式规范', text.includes('自造模式规范'))
  ok('提示词含 facet_ready 收尾指引', text.includes('facet_ready'))
  ok('提示词含等待子代理返回结果的要求', text.includes('等待子代理返回结果'))
  ok('提示词含标注语言规则', text.includes('标注语言'))
  ok('要求复制布局约定进子代理', text.includes('原文复制'))
  ok('提示词含风格铁律（hex）', text.includes('#E8590C') && text.includes('#FFFFFF'))
  eq('消息 source.kind', msg.source?.kind, SOURCE_KIND)
  eq('消息 source.subtype', msg.source?.subtype, 'workflow')
  eq('消息 source.slug', msg.source?.slug, 'arxiv-2402-03300')
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'arxiv-2402-03300', 'meta.json'), 'utf8'))
  eq('meta.status', meta.status, 'pending')
}
{
  const env = makeEnv()
  const result = await cmdSearchModel({ rawInput: '  ', agent: env.fakeAgent, signal: new AbortController().signal }, { ctx: env.ctx, config: env.config, root: ROOT })
  eq('空参数 → error', result.kind, 'error')
  ok('用法提示提到 /visualize', result.text.includes('/visualize'))
}

section('③b 自定义模式（OOD 自造）加载与注入')
{
  const modesDir = path.join(ROOT, 'modes')
  fs.mkdirSync(modesDir, { recursive: true })
  fs.writeFileSync(path.join(modesDir, 'crypto-protocol.json'), JSON.stringify({
    name: 'crypto-protocol', label: '密码协议', views: ['flow', 'timeline'], colors: { '密钥交换': '#1C7ED6' },
  }))
  fs.writeFileSync(path.join(modesDir, 'BAD NAME.json'), JSON.stringify({ name: 'BAD NAME!', views: ['flow'] }))
  fs.writeFileSync(path.join(modesDir, 'empty-views.json'), JSON.stringify({ name: 'empty-views', views: ['nope'] }))
  fs.writeFileSync(path.join(modesDir, 'broken.json'), '{ not json')
  const loaded = loadCustomModes(ROOT)
  eq('只加载合法模式', loaded.map((m) => m.name), ['crypto-protocol'])
  const env = makeEnv()
  await cmdSearchModel({ rawInput: '设计一个握手协议', agent: env.fakeAgent, signal: new AbortController().signal }, { ctx: env.ctx, config: env.config, root: ROOT })
  const text = env.followups[0].content[0].text
  ok('提示词注入自定义模式名', text.includes('crypto-protocol'))
  ok('提示词注入自定义模式中文名', text.includes('密码协议'))
  ok('提示词标注自定义分组', text.includes('自定义模式'))
}

// ── ④ facet_ready v2 ──────────────────────────────────────────────────────

section('④ facet_ready')
{
  const env = makeEnv()
  apply(env.ctx, env.config)
  const tool = env.tools[0]

  const r0 = await tool.execute({ slug: 'INVALID SLUG!' }, {})
  eq('非法 slug → ok:false', r0.ok, false)
  ok('非法 slug 提示原因', r0.message.includes('非法'))

  const r1 = await tool.execute({ slug: 'ready-test', views: [{ kind: 'hologram' }] }, {})
  eq('未知 kind → ok:false', r1.ok, false)
  ok('未知 kind 提示', r1.message.includes('未知 kind'))

  const r2 = await tool.execute({ slug: 'ready-test', views: [{ kind: 'diagram' }, { kind: 'tower' }, { kind: 'flow' }, { kind: 'timeline' }] }, {})
  eq('超 3 视图 → ok:false', r2.ok, false)
  ok('超限提示', r2.message.includes('最多 3 个'))

  const r3 = await tool.execute({ slug: 'ready-test', views: [{ kind: 'diagram' }, { kind: 'tower' }] }, {})
  eq('缺文件 → ok:false', r3.ok, false)
  eq('缺文件清单', r3.missing, ['diagram.html', 'tower.html'])

  const dir = writeDemoDir('ready-test', { 'diagram.html': '<html>d</html>' })
  const r4 = await tool.execute({ slug: 'ready-test', views: [{ kind: 'diagram' }, { kind: 'tower' }] }, {})
  eq('只缺一个 → ok:false', r4.ok, false)
  eq('缺 tower', r4.missing, ['tower.html'])

  fs.writeFileSync(path.join(dir, 'tower.html'), '<html>t</html>')
  const r5 = await tool.execute({ slug: 'ready-test', mode: 'rl-training', views: [{ kind: 'diagram' }, { kind: 'tower', title: '3D 塔视图' }] }, {})
  eq('齐全 → ok:true', r5.ok, true)
  eq('urls 数量', r5.urls.length, 2)
  eq('url kind', r5.urls.map((u) => u.kind), ['diagram', 'tower'])
  eq('自定义标题生效', r5.urls[1].title, '3D 塔视图')
  eq('url 路径', r5.urls[0].url, `${ROUTE_PREFIX}/ready-test/diagram.html`)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  eq('meta.views 落盘', meta.views.map((v) => v.file), ['diagram.html', 'tower.html'])
  eq('meta.mode 落盘', meta.mode, 'rl-training')
  eq('meta.status', meta.status, 'ready')

  const r6 = await tool.execute({ slug: 'ready-test' }, {})
  eq('不带 views 时按 meta 回退 → ok:true', r6.ok, true)
  eq('回退后 urls 数量', r6.urls.length, 2)
  eq('回退后 urls kind', r6.urls.map((u) => u.kind), ['diagram', 'tower'])
}
{
  // 扫描回退：目录里只有 flow.html；legacy 回退：只有 2d/3d
  const env = makeEnv()
  apply(env.ctx, env.config)
  const tool = env.tools[0]
  writeDemoDir('scan-test', { 'flow.html': '<html>f</html>' })
  const r = await tool.execute({ slug: 'scan-test' }, {})
  eq('扫描回退 → ok:true', r.ok, true)
  eq('扫描回退到 flow', r.urls.map((u) => u.kind), ['flow'])
  writeDemoDir('legacy-test', { '2d.html': '<html>2</html>', '3d.html': '<html>3</html>' })
  const r2 = await tool.execute({ slug: 'legacy-test' }, {})
  eq('legacy 回退 → ok:true', r2.ok, true)
  eq('legacy urls 指向 2d/3d', r2.urls.map((u) => u.url.split('/').pop()), ['2d.html', '3d.html'])
}

section('④b resolveViews 三跳')
{
  writeDemoDir('rv-meta', { 'flow.html': '<html>1</html>' })
  fs.writeFileSync(path.join(ROOT, 'rv-meta', 'meta.json'), JSON.stringify({ views: [{ kind: 'flow', file: 'flow.html', title: '流程' }] }))
  eq('meta 优先', resolveViews(ROOT, 'rv-meta').map((v) => v.title), ['流程'])
  writeDemoDir('rv-scan', { 'timeline.html': '<html>2</html>' })
  eq('扫描其次', resolveViews(ROOT, 'rv-scan').map((v) => v.kind), ['timeline'])
  writeDemoDir('rv-legacy', { '2d.html': '<html>3</html>', '3d.html': '<html>4</html>' })
  eq('legacy 最后', resolveViews(ROOT, 'rv-legacy').map((v) => v.file), ['2d.html', '3d.html'])
  eq('目录不存在 → 空', resolveViews(ROOT, 'nope-nope'), [])
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

  await env.tools[0].execute({ slug: 'ready-test' }, {})
  const payload = res.writes.join('')
  ok('收到 ready 事件', payload.includes('event: ready'))
  ok('事件含 slug', payload.includes('"slug":"ready-test"'))
  ok('事件载荷含 views 数组', payload.includes('"views":['))
  ok('事件视图含 kind', payload.includes('"kind":"diagram"'))
  ok('事件视图含 url', payload.includes('ready-test/diagram.html'))

  for (const fn of res.listeners.close ?? []) fn()
  const before = res.writes.length
  await env.tools[0].execute({ slug: 'ready-test' }, {})
  eq('断开后不再写入', res.writes.length, before)
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
  ok('索引页含视图链接', String(idx.body).includes('ready-test/diagram.html'))
  ok('索引页含模式标记', String(idx.body).includes('[rl-training]'))
  ok('索引页含自定义模式行', String(idx.body).includes('密码协议'))
  ok('索引页不把 modes 当产物列出', !String(idx.body).includes('<code>modes</code>'))

  const file = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/diagram.html`, method: 'GET' }, file)
  eq('文件 200', file.status, 200)
  eq('文件内容', String(file.body), '<html>d</html>')

  const miss = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/nope.html`, method: 'GET' }, miss)
  eq('缺失文件 404', miss.status, 404)

  const badSlug = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/UPPER/2d.html`, method: 'GET' }, badSlug)
  eq('非法 slug 404', badSlug.status, 404)

  const modesBlocked = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/modes/crypto-protocol.json`, method: 'GET' }, modesBlocked)
  eq('modes 目录路由屏蔽 404', modesBlocked.status, 404)

  const traversal = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test/%2E%2E/meta.json`, method: 'GET' }, traversal)
  eq('路径穿越 404', traversal.status, 404)

  const landing = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/ready-test`, method: 'GET' }, landing)
  eq('目录 landing 200', landing.status, 200)
  ok('landing 列出文件', String(landing.body).includes('diagram.html'))

  // debug 广播：订阅 → 广播 → 收到（含 views）→ 非法 slug 400 → 无视图 404
  const sub = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/events`, method: 'GET' }, sub)
  const dbg = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/debug/broadcast?slug=ready-test`, method: 'GET' }, dbg)
  eq('debug 广播 200', dbg.status, 200)
  const dbgBody = JSON.parse(String(dbg.body))
  ok('debug 响应带 views 清单', Array.isArray(dbgBody.views) && dbgBody.views.length === 2)
  const dbgPayload = sub.writes.join('')
  ok('debug 广播送达订阅者（含 views）', dbgPayload.includes('"views":['))
  ok('debug 广播含视图 url', dbgPayload.includes('ready-test/tower.html'))
  const dbgBad = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/debug/broadcast?slug=BAD!`, method: 'GET' }, dbgBad)
  eq('debug 非法 slug 400', dbgBad.status, 400)
  const dbgEmpty = makeRes()
  await handler({ url: `${ROUTE_PREFIX}/debug/broadcast?slug=no-such-thing`, method: 'GET' }, dbgEmpty)
  eq('debug 无视图 404', dbgEmpty.status, 404)
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

section('⑧ 词表与提示词常量')
{
  eq('视图词表共 5 种', Object.keys(VIEW_KINDS).sort(), ['diagram', 'flow', 'network', 'timeline', 'tower'])
  eq('每种视图文件名为 <kind>.html', Object.entries(VIEW_KINDS).every(([k, v]) => v.file === `${k}.html`), true)
  eq('模式表共 5 个', Object.keys(MODES).sort(), ['generic', 'model-architecture', 'red-team', 'rl-training', 'workflow'])
  ok('模式视图均在词表内', Object.values(MODES).every((m) => m.views.every((v) => VIEW_KINDS[v] !== undefined)))
  ok('workflow 是单视图模式（1 视图=1 子代理）', MODES.workflow.views.length === 1)
  ok('STYLE_BLOCK 含全部色板色值', ['#7048E8', '#E8590C', '#1C7ED6', '#2F9E44', '#AE3EC9', '#343A40', '#868E96', '#ADB5BD', '#DEE2E6', '#FA5252'].every((c) => STYLE_BLOCK.includes(c)))
  ok('SPEC_BLOCK 含通用图结构', SPEC_BLOCK.includes('"nodes"') && SPEC_BLOCK.includes('"edges"') && SPEC_BLOCK.includes('"groups"'))
  const p = buildWorkflowPrompt({
    query: 'X', slug: 'x', dir: '/d/x', modesDir: '/d/x/modes',
    customModes: [{ name: 'zeta', label: 'Z 模式', views: ['flow'], colors: { '甲': '#1C7ED6' } }],
  })
  ok('提示词含自定义模式行', p.includes('zeta（Z 模式，自定义）'))
  ok('提示词含自定义配色', p.includes('甲 #1C7ED6'))
  ok('提示词含视图文件名指引', p.includes('diagram.html') && p.includes('timeline.html'))
  ok('提示词含自造模式保存路径', p.includes('/d/x/modes/<name>.json'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log(`\n════════════════════════════════════════`)
console.log(`  通过 ${passed} · 失败 ${failed}`)
console.log(`════════════════════════════════════════`)
process.exit(failed === 0 ? 0 : 1)
