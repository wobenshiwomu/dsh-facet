# dsh-facet

> DeepSeek Harness 插件：**切面 —— 任意内容进，结构化图谱出。**
> 在对话里输入 `/visualize <模型名 | arXiv 链接 | 一句话需求>`，主 agent 自动调研、
> 定「生成计划」（模式 + 视图清单），为每个视图派一个独立子代理并行画出图谱，
> 窗口直接在界面上弹出。

## 特点

- **一句话 → 一组图谱**：模型架构 / RL·Agent 训练管线 / 攻防·红蓝关系 / 论文工作流……
  自动识别内容类型并选模板；都不像时先用通用兜底（generic），必要时还能按规范**现场"造"一个新模式**（存起来，下次同类内容自动复用——框架自己长大）。
- **视图词表（文件名即约定）**：`diagram`（2D 结构图）/ `tower`（3D 层塔）/ `network`（3D 关系网络）/ `flow`（流程管线）/ `timeline`（时间线）。
  渲染层封闭（视图只有这几种 + 固定色板，风格永不崩），语义层开放（模式可生长）。
- **浮窗自动弹出**：产物就绪经 SSE 通知界面——桌面 1 视图=单窗、2 视图=双窗并排、≥3 视图=标签栏；手机单窗多标签。窗口可拖动/最大化/刷新/关闭。
- **风格铁律（视觉一致性）**：固定 10 色色板（hex 单源）；低置信字段＝虚线 + `?`；非标准/自研要素＝加粗描边 + `★`；页脚含来源——同一个插件画出来的图长得像一家人。
- **可分享的产物**：所有视图都是**单文件 HTML**（2D 类内联 SVG 零依赖；3D 类引 jsdelivr CDN 的 three.js，手机浏览器直接能转能缩）。
- **复核友好**：回复里只有一行人类摘要（不贴 JSON）；全量 `spec.json` 静默落盘，随查随看。

## 安装

```sh
dsh plugin --profile web add 'https://codeload.github.com/wobenshiwomu/dsh-facet/tar.gz/v0.2.0'
```

或在图形界面：侧栏「插件」→ 添加插件 → 填上面这条 URL。装完重启 DSH 生效。
URL 末段的 `v0.2.0` 是版本标签；升级时换成本仓库的新版本标签重装即可。

## 使用

在任意对话里输入（名字、论文链接、或者一句大白话都行）：

```
/visualize Qwen3-0.6B
/visualize https://arxiv.org/abs/2407.21783
/visualize 把 GRPO 的训练流程画出来
```

接下来自动发生：

1. 主 agent 理解内容类型并调研（arXiv 链接优先精读论文；否则走搜索）
2. 你收到一行摘要：`将生成 N 张图（kind1 + kind2）· 来源：…`
3. 每个视图派一个独立子代理，**并行**生成 `<kind>.html`
4. **浮窗自动弹出**；最终回复里同时给出各视图直链

直链形如（关掉浮窗后依然可用）：

```
http://127.0.0.1:3080/dsh-facet/<slug>/diagram.html
http://127.0.0.1:3080/dsh-facet/<slug>/tower.html
```

产物索引页：`http://127.0.0.1:3080/dsh-facet/`

## 模式与视图

内置模式（主 agent 自动识别选用）：

| 模式 | 视图清单 | 语义配色（节选） |
|---|---|---|
| `model-architecture` 模型架构 | diagram + tower | 注意力橙 / FFN 蓝 / 嵌入紫 / 归一化绿 / 循环·状态藤紫 |
| `rl-training` RL·Agent 训练管线 | flow + timeline | 采样紫 / 奖励橙 / 更新蓝 / 缓冲绿 / 环境藤紫 |
| `red-team` 攻防·红蓝关系 | network + timeline | 攻击橙 / 防守蓝 / 资产紫 / 工具绿 / 边界虚线灰 |
| `workflow` 论文工作流 | flow（单视图示例） | 步骤蓝 / 决策橙 / 输入输出紫 / 循环藤紫 |
| `generic` 通用兜底 | diagram + flow | 自行按语义归类（同类同色），页脚注明映射 |

视图词表（文件名 = `<kind>.html`）：

| kind | 是什么 | 技术 |
|---|---|---|
| `diagram` | 2D 结构/关系图（自上而下分层、重复组 ×N） | 内联 SVG |
| `tower` | 3D 分层堆叠视图 | three.js |
| `network` | 3D 关系网络（力导向） | three.js |
| `flow` | 流程/管线图（含循环回边） | 内联 SVG |
| `timeline` | 时间线（可带泳道） | 内联 SVG |

## 自造模式（OOD 一点点魔法）

内容不属于任何内置模式时：先用 `generic` 兜底；若主 agent 确信值得一个新模式，
它会写一个 ≤50 行的 JSON 到 `$DSH_HOME/facet/modes/<name>.json`：

```json
{ "name": "crypto-protocol", "label": "密码协议",
  "views": ["flow", "timeline"],
  "colors": { "密钥交换": "#1C7ED6", "验证": "#E8590C" } }
```

限制：`views` 只能取自词表、颜色只能用色板、名字小写 kebab——**渲染层封闭、语义层开放**。
保存后本次即按它执行，以后同类内容自动复用（索引页会标出自定义模式）。

## 产物结构

```
$DSH_HOME/facet/<slug>/
├── spec.json      # 通用图结构：nodes / edges / groups + 来源与置信度
├── diagram.html   # 视图文件（文件名 = <kind>.html）
├── tower.html     # …每个视图一个单文件 HTML
└── meta.json      # 生成元数据（query / mode / views / 状态）

$DSH_HOME/facet/modes/<name>.json   # 自造模式（OOD 时生成，可复用）
```

## 配置（可选配置 · 不配置即默认）

**默认开箱即用**，无需任何配置。仅当要改默认值时才需要：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（示例）
- id: dsh-facet
  config:
    homeDir: ''      # 产物根目录，默认 $DSH_HOME/facet
    readyPing: true  # 产物就绪后推送浮窗事件（默认开）
```

## 工作机制（给好奇的人）

- 命令处理器只做确定性的事：校验参数 → 生成 slug → 建目录写 `meta.json(pending)` → 读取自定义模式 → 把**工作流提示词**（含模式表、视图词表、spec 规范、风格铁律、自造模式规范）以 user 消息注入当前 agent（与官方 `/goal` 同款 `agent.followup` 通路）。
- 智能的事交给 agent：识别内容 → 调研 → 写成通用图结构的 `spec.json` → 用内置 `subagent` 工具**为每个视图并行派发独立子代理**。
- 收尾走 `facet_ready` 工具：校验视图文件 → 写 `meta.views` → SSE 广播（载荷含 `views:[{kind,title,url}]`）→ 界面浮窗弹出；各视图直链同时回给 agent 放进最终回复。
- HTTP 路由（`/dsh-facet/*`）挂在 webServer 上（可选依赖——无 web 服务的几何下插件照常工作，仅少了浮窗与直链）。

## 已知边界

- 浮窗由**实时事件**触发：页面刷新后浮窗不还原（用消息里的直链即可再开）。
- 一次 `/visualize` 的成本 = 1 轮调研 + N 个子代理（N=该模式视图数，1~3），按需触发。
- 3D 视图的 three.js 走 jsdelivr CDN（首次打开需联网）。

## 开发

```sh
npm test       # 仿真测试：122 项断言（命令/提示词/ready/回退链/SSE/路由/词表）
npm run build  # esbuild 编译客户端半区（Termux 用 @esbuild/android-arm64 二进制）
```

## License

MIT
