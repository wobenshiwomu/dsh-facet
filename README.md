# dsh-facet

> DeepSeek Harness 插件：**模型架构可视化 —— 一个名字或一条 arXiv 链接，两张图。**
> 在对话里输入 `/visualize Llama-3-8B`（或论文链接），主 agent 自动调研架构、
> 生成结构化 spec，两个子代理并行画出 **2D 结构图（SVG）** 与 **3D 视图（three.js）**，
> 浮窗直接在界面上弹出。

## 特点

- **一个命令，两张图**：`/visualize <模型名 | arXiv 链接>` 即可；主 agent 负责调研与整理，两个独立子代理并行出图。
- **浮窗自动弹出**：产物就绪后经 SSE 通知界面，在全局浮层弹出可视化窗口——桌面双窗并排（2D / 3D 各自可拖动、最大化、刷新、关闭），手机单窗 + 2D/3D 标签切换。
- **风格铁律（视觉一致性）**：内置固定调色板（用具体 hex 色值而非颜色词），2D 与 3D 共用同一套 token——同一个插件画出来的图，长得像一家人。
  - 层类型配色：注意力＝橙 `#E8590C`、FFN/专家＝蓝 `#1C7ED6`、嵌入＝紫 `#7048E8`、归一化＝绿 `#2F9E44`、循环/状态类（SSM、GDN…）＝藤紫 `#AE3EC9`、输出头＝深灰 `#343A40`
  - 低置信字段＝虚线边框 + 问号；非标准/自研块＝加粗描边 + ★；白底、圆角、统一线宽
- **可分享的产物**：`2d.html` 与 `3d.html` 都是**单文件**（2D 零依赖内联 SVG；3D 引 jsdelivr CDN 的 three.js，手机浏览器直接能转能缩）。
- **复核友好**：回复里只有一行人类摘要（不贴 JSON）；全量 `spec.json` 静默落盘，随查随看。

## 安装

```sh
dsh plugin --profile web add 'https://codeload.github.com/wobenshiwomu/dsh-facet/tar.gz/v0.1.0'
```

或在图形界面：侧栏「插件」→ 添加插件 → 填上面这条 URL。装完重启 DSH 生效。
URL 末段的 `v0.1.0` 是版本标签；升级时换成本仓库的新版本标签重装即可。

## 使用

在任意对话里输入（模型名或 arXiv 链接皆可）：

```
/visualize Qwen3-0.6B
/visualize https://arxiv.org/abs/2407.21783
```

接下来自动发生：

1. 主 agent 调研架构（读论文/模型卡，标注不确定字段）→ 写 `spec.json`
2. 你收到一行摘要（模型 · 层结构 · 参数量 · 来源）
3. 两个子代理并行生成 `2d.html` / `3d.html`
4. **浮窗自动弹出**；最终回复里同时给出两个直链

直链形如（关掉浮窗后依然可用）：

```
http://127.0.0.1:3080/dsh-facet/<slug>/2d.html
http://127.0.0.1:3080/dsh-facet/<slug>/3d.html
```

产物索引页：`http://127.0.0.1:3080/dsh-facet/`

## 产物结构

```
$DSH_HOME/facet/<slug>/
├── spec.json     # 结构化架构描述（层堆叠 / 维度 / 变体 / 置信度 / 来源）
├── 2d.html       # 2D 分层结构图（单文件，内联 SVG）
├── 3d.html       # 3D 堆叠视图（单文件，three.js via jsdelivr）
└── meta.json     # 生成元数据（query / 时间 / 状态）
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

- 命令处理器只做确定性的事：校验参数 → 生成 slug → 建目录写 `meta.json(pending)` → 把**工作流提示词**（含 spec schema、风格铁律、布局约定）以 user 消息注入当前 agent（与官方 `/goal` 同款 `agent.followup` 通路）。
- 智能的事交给 agent：调研、写 spec、用内置 `subagent` 工具**并行派发两个独立子代理**分别出图。
- 收尾走 `facet_ready` 工具：宿主校验两个 HTML 真实存在 → 写 `meta.json(ready)` → SSE 广播 → 界面浮窗弹出；两个直链同时回给 agent 放进最终回复。
- HTTP 路由（`/dsh-facet/*`）挂在 webServer 上（可选依赖——无 web 服务的几何下插件照常工作，仅少了浮窗与直链）。

## 已知边界

- 浮窗由**实时事件**触发：页面刷新后浮窗不还原（用消息里的直链即可再开）。
- 一次 `/visualize` 的成本 = 1 轮调研 + 2 个子代理，按需触发。
- 3D 页面的 three.js 走 jsdelivr CDN（首次打开需联网）。

## 开发

```sh
npm test       # 仿真测试：87 项断言（命令/工件/工具/SSE/路由/降级）
npm run build  # esbuild 编译客户端半区（Termux 用 @esbuild/android-arm64 二进制）
```

## License

MIT
