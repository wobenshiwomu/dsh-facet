/**
 * dsh-facet — 提示词与模板常量（单一来源）。
 *
 * 本文件是"内容 → 图谱"管线的语义中枢，全部设计集中在这里：
 *  - VIEW_KINDS：视图词表（5 种）。文件名一律 `<kind>.html`——前端/ready 只认
 *    meta 里的 views，词表保证"渲染层封闭"：无论什么内容，画出来都是自家风格。
 *  - MODES：模式表（识别线索不显式列出——主 agent 按 label/views/配色自行判断）。
 *    每个模式 = { label, views(视图清单), colors(语义→色板映射) }。
 *    views 是模式模板固定声明的：视图数 = 子代理数（一视图一代理）。
 *  - STYLE_BLOCK：风格铁律（白底/圆角/线宽/特殊标记/页脚）+ 唯一色板。
 *  - SPEC_BLOCK：spec.json v2 —— 通用图结构（nodes/edges/groups），
 *    任何模式共用一套 schema（也是未来"架构工坊"GraphSpec 的种子）。
 *  - buildWorkflowPrompt：把以上全部组装成注入主 agent 的工作流提示词。
 *
 * 设计纪律（改这里之前先读）：
 *  渲染层封闭（视图词表 + 色板不可被 agent 扩展）、语义层开放
 *  （模式/映射可生长：自造模式只能组合既有 kind 与既有色值）。
 *
 * @module dsh-facet/prompts
 */

export const STYLE_BLOCK = `【风格铁律 · 只允许以下色值】
- 画布背景：#FFFFFF 纯白（无渐变、无纹理）
- 唯一色板（语义映射见【模式表】；不得把色板用于映射之外的语义）：
  #7048E8 紫 · #E8590C 橙 · #1C7ED6 蓝 · #2F9E44 绿 · #AE3EC9 藤紫
  #343A40 深灰 · #868E96 中灰 · #ADB5BD 浅灰（连线/边界，1.5px） · #DEE2E6 组框灰 · #FA5252 问号红
- 特殊标记：
  · custom:true 的要素 = 本语义主色 + 2px 加粗描边 + 右上角 ★
  · confidence:"low" 的字段 = 虚线边框 + 右上角 #FA5252 的 "?"
- 文字：主标签 #212529；维度/注释 #868E96（小一号）
- 要素块：圆角 8px、内边距充足、线宽统一 1.5px；不用半透明（重复组外框除外）
- 禁止：渐变、阴影滥用、emoji、装饰性图案
- 页脚（右下角小字）：<标题> · dsh-facet · 来源：<来源>`

/** 视图词表：文件名一律 `<kind>.html`；tech=svg（内联 SVG 单文件）或 three（three.js 单文件）。 */
export const VIEW_KINDS = {
  diagram: {
    file: 'diagram.html',
    title: '2D 结构图',
    tech: 'svg',
    layout: '2D 结构/关系图：自上而下分层；重复组=外框(#DEE2E6)包住代表性子层+右上角 "×N"（不要逐层复制）；旁路/残差走侧边浅灰弧线；维度标注格式 d=4096 · h=32 · kv=8',
  },
  tower: {
    file: 'tower.html',
    title: '3D 视图',
    tech: 'three',
    layout: '3D 分层堆叠：节点=圆角盒；重复组=半透明外框+×N 标签；白色背景、柔和环境光+主光；OrbitControls 触摸可用；加载后缓慢自转',
  },
  network: {
    file: 'network.html',
    title: '关系网络',
    tech: 'three',
    layout: '3D 关系网络：力导向布局（节点=实体、边=带方向的关系）；按模式配色语义上色；重要节点带标签牌；OrbitControls 触摸可用；缓慢自转；攻击路径用对比色突出',
  },
  flow: {
    file: 'flow.html',
    title: '流程管线图',
    tech: 'svg',
    layout: '2D 数据流/管线：阶段从左到右排列（超过 6 个可折行）；箭头连接；循环用带回边的弧线（如 reward→rollout）；阶段内节点纵向排布；标注数据/信号流向',
  },
  timeline: {
    file: 'timeline.html',
    title: '时间线',
    tech: 'svg',
    layout: '2D 时间线：横向时间轴（左→右）；阶段分块（浅灰分隔）；关键事件标注落在轴上；需要时用泳道（如 红队/蓝队、训练/评测）',
  },
}

/** 模式表：views=视图清单（=子代理数）；colors=语义→色板映射（只允许色板色值）。 */
export const MODES = {
  'model-architecture': {
    label: '模型架构',
    views: ['diagram', 'tower'],
    colors: '嵌入/词表 #7048E8 · 注意力 #E8590C · FFN/专家 #1C7ED6 · 归一化 #2F9E44 · 循环/状态类（SSM、GDN…）#AE3EC9 · 输出头 #343A40 · 其他 #868E96',
  },
  'rl-training': {
    label: 'RL / Agent 训练管线',
    views: ['flow', 'timeline'],
    colors: '采样/Rollout #7048E8 · 奖励/评价 #E8590C · 优化/更新 #1C7ED6 · 数据/缓冲/回放 #2F9E44 · 环境/任务 #AE3EC9 · 其他 #868E96',
  },
  'red-team': {
    label: '攻防 / 红蓝关系',
    views: ['network', 'timeline'],
    colors: '攻击方/攻击路径 #E8590C · 防守方/防线 #1C7ED6 · 资产/目标/数据 #7048E8 · 工具/手段 #2F9E44 · 信任边界/隔离 #ADB5BD（虚线） · 中立/观察 #868E96',
  },
  workflow: {
    label: '论文工作流 / 流程',
    views: ['flow'],
    colors: '步骤 #1C7ED6 · 决策 #E8590C · 输入/输出 #7048E8 · 循环/反馈 #AE3EC9 · 其他 #868E96',
  },
  generic: {
    label: '通用图谱（兜底）',
    views: ['diagram', 'flow'],
    colors: '自行把实体按语义归类（同类同色），只用色板；并在页脚注明「类型→颜色」简表',
  },
}

/** spec.json v2：通用图结构（任何模式共用；未来 GraphSpec 的种子）。 */
export const SPEC_BLOCK = `{
  "request": "用户原话（简写）",
  "mode": "rl-training",
  "title": "内容标题",
  "summary": "一句话概括",
  "sources": ["https://arxiv.org/abs/..."],
  "confidence": "high",
  "notes": "歧义/低置信说明（可选）",
  "views": ["flow", "timeline"],
  "nodes": [
    { "id": "rollout", "type": "rollout", "label": "Rollout 采样", "dims": "可选", "note": "可选", "custom": false, "confidence": "high", "group": "loop" }
  ],
  "edges": [
    { "from": "rollout", "to": "reward", "kind": "flow", "label": "" }
  ],
  "groups": [
    { "id": "loop", "label": "训练循环", "count": null, "members": ["rollout", "reward", "update"] }
  ]
}
- node.type = 该模式的语义类型（对照【模式表】配色）；node.group = 所属组 id（可空字符串或 null）
- node.custom:true = 非标准/自研要素（画成加粗描边+★）；node.confidence:"low" = 不确定（画成虚线+?）
- edges.kind 词表：flow | loop | read | write | attack | defend | feedback | ref
- groups.count = 重复数（如 28 层填 28）；非重复填 null`

/**
 * 组装注入主 agent 的工作流提示词。
 * @param {{query: string, slug: string, dir: string, modesDir: string, customModes?: Array<{name:string,label:string,views:string[],colors?:Record<string,string>}>}} p
 */
export function buildWorkflowPrompt({ query, slug, dir, modesDir, customModes = [] }) {
  const modeLines = Object.entries(MODES).map(
    ([name, m]) => `- ${name}（${m.label}）：views = ${m.views.join(' + ')}\n    语义配色：${m.colors}`,
  )
  const customLines = customModes.map((m) => {
    const colors = m.colors !== undefined && Object.keys(m.colors).length > 0
      ? `\n    语义配色：${Object.entries(m.colors).map(([k, v]) => `${k} ${v}`).join(' · ')}`
      : ''
    return `- ${m.name}（${m.label}，自定义）：views = ${m.views.join(' + ')}${colors}`
  })
  const modeList = [
    ...modeLines,
    ...(customLines.length > 0 ? ['- —— 自定义模式（前人新造，可直接选用）——', ...customLines] : []),
  ]
  const layoutLines = Object.entries(VIEW_KINDS).map(
    ([kind, v]) => `- ${kind}（${v.title}，文件名 ${v.file}，${v.tech === 'three' ? 'three.js' : '内联 SVG'}）：${v.layout}`,
  )
  const kindNames = Object.keys(VIEW_KINDS).join(' | ')

  return `【dsh-facet · /visualize 工作流】
用户请求：/visualize ${query}

任务：弄清用户想看什么 → 调研 → 定「生成计划」（模式 + 视图清单）→ 每个视图派一个独立子代理并行出图 → 收尾。严格按步骤执行：

1) 理解与调研
   · 先判断内容类型：模型架构 / RL·Agent 训练 / 攻防·红蓝关系 / 论文工作流 / 其他。
   · arXiv 链接是特权来源：优先精读论文本身（abs 页 / HTML 版）；否则用搜索工具找官方资料。
   · 收集：实体与关系、阶段与流程、关键维度/参数、来源链接。
   · 标注语言：跟随用户请求的语言——中文请求以中文标注为主、技术专名保留英文（首次出现可中英对照，如 Self-Attention（自注意力））；英文请求用英文；用户显式指定语言时从其指定。
   · 查不到的字段禁止编造：填 "unknown" 并标 confidence:"low"；名称有歧义时取最主流版本并写进 notes。

2) 定「生成计划」
   · 从【模式表】选最合适的模式；都不像时首选 generic 兜底。
   · 仅当你确信内容值得一个新模式、且现有模式确实装不下时，才按【自造模式规范】设计并保存（新造模式必须在摘要行标注）。
   · 计划 = { mode, views:[…] }；视图数 = 子代理数：1 个视图派 1 个子代理，2 个视图派 2 个（最多 3 个）。

3) 写出 ${dir}/spec.json（目录不存在先创建；注释只是说明，不要写进文件）：
${SPEC_BLOCK}

4) 在回复里给用户一行摘要（不要贴 JSON）：
   「将生成 N 张图（kind1 + kind2）· 来源：<来源>」
   · 低置信字段点名；新造模式时加「（新造模式 <name>）」。

5) 在【同一条消息】里用 subagent 工具发起 N 个并行委派（每个子代理只负责一个视图，独立上下文）。**必须等待子代理返回结果**：委派用前台/阻塞模式（若工具有 background 参数则设为 false——要"等结果"，不要"后台运行"）；你的下一步（facet_ready）依赖它们产出的文件，**不要在子代理运行中结束回合去等通知**。每份提示词必须完整自包含：
   · 先读 ${dir}/spec.json，再生成 ${dir}/<视图文件>（文件名以【视图布局约定】为准）；
   · 把【风格铁律】与该视图的【布局约定】原文复制进每一份；
   · 技术栈：diagram / flow / timeline = 单文件 HTML、零外部依赖（内联 CSS + 手写内联 SVG）；tower / network = 单文件 HTML，three.js（importmap 引 CDN：https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js 与 https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js），白色背景、可旋转缩放（触摸可用）、加载后缓慢自转；
   · 子代理不要越界画别的视图。

6) 确认全部子代理的产物文件都已写出（可快速列目录核对；若缺文件，让对应子代理补齐后再继续），然后调用工具 facet_ready：
   facet_ready({ "slug": "${slug}", "mode": "<模式名>", "views": [{ "kind": "<kind>", "title": "<标题>" }, …] })
   它会校验产物文件、写 meta、广播浮窗，并返回各视图的访问链接；把链接放进最终回复；不要粘贴 HTML 源码。

【模式表】（views = 要生成的图；"语义→颜色"只允许使用色板里的色值）
${modeList.join('\n')}

【视图布局约定】（文件名以这里为准）
${layoutLines.join('\n')}

【自造模式规范】（OOD 且确信值得时；默认先用 generic，真要新造再动手）
- 生成一个 JSON 保存到 ${modesDir}/<name>.json：
  { "name": "<小写kebab>", "label": "<中文名>", "views": ["<kind>", …], "colors": { "<语义>": "<色板色值>", … } }
- 限制：name 2-32 字符（小写字母/数字/中划线）；views 只能取自词表（${kindNames}）；颜色只能用色板色值；整份 JSON ≤50 行、简单直白；禁止发明新的视图种类或新的色值。
- 保存后本次即按它执行；以后同类内容会被自动复用——这是框架"长大"的方式。

${STYLE_BLOCK}
`
}
