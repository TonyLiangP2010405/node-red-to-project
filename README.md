# node-red-to-project

把 Node-RED 导出的 `flows.json` 转换成一个**代码化、可独立运行**的 Node.js 项目——不需要 Node-RED 编辑器，也不需要安装 Node-RED 本体。

## 两种转换模式

**rewrite（默认）**：完全重写为手写风格、零 Node-RED 痕迹的项目。每种节点类型由工具自带的干净手写实现提供（`lib/nodes/`，随项目拷入、可自由修改），function 节点的代码生成为真实 JS 函数。依赖极简——按用到的功能自动决定（http→express、template→mustache、jsonata 规则→jsonata）。当前支持白名单：inject / debug / function / change / switch / delay / template / http in / http response / junction / link in / link out。白名单外的类型会报错并列清单。

**runtime（`--mode runtime`）**：兼容模式。流程生成为代码，节点行为加载 `@node-red/nodes` 和各 contrib 包里的官方真实实现运行，保真度最高，支持几乎所有节点类型（Dashboard 等编辑器专属节点除外）。

## 用法

```bash
node bin/cli.js ./flows.json -o ./my-app                    # rewrite 模式（默认）
node bin/cli.js ./flows.json -o ./my-app --mode runtime     # 兼容模式
cd my-app
npm install
npm start
```

CLI 选项：

| 选项 | 说明 |
|---|---|
| `-o, --output <dir>` | 输出目录（默认 `./<输入文件名>-app`） |
| `--name <name>` | 生成项目的 package.json name |
| `--user-dir <dir>` | 本地 Node-RED 用户目录（默认 `~/.node-red`），用于精确反查 contrib 依赖版本 |
| `--yes` | 跳过交互，无法确认的依赖按 `node-red-contrib-*` 猜测执行 |
| `--force` | 覆盖非空输出目录（会删除目录内容，包括 node_modules） |

## Web 界面

```bash
npm run web          # 或 node bin/cli.js --serve --port 8321
```

浏览器打开 `http://localhost:8321`：上传/粘贴 flows.json → 分析节点与依赖（contrib 包名可在页面上编辑确认）→ 生成项目 → 在线预览生成的代码，或下载整个项目的 zip。

## 依赖推断（仅 runtime 模式）

runtime 模式下 `flows.json` 里只有节点 `type` 没有包名，工具按三级策略推断：

1. 核心节点 → `@node-red/nodes`
2. 本地反查：扫描 `--user-dir` 下已安装包的 `node-red.nodes` 清单和 `registerType` 调用，拿到精确包名+版本
3. 启发式猜测 `node-red-contrib-<type>`，交互式向你确认（`--yes` 时全自动）

## 生成项目的结构

rewrite 模式：

```
my-app/
├── package.json        # 依赖按用到的功能自动计算（可能为空）
├── index.js            # 启动入口
├── settings.js         # 端口等
├── flows.json          # 原始导出文件存档
├── flows/<tab>.js      # 配置 + 连线 + function 内联为真实函数
├── lib/runtime.js      # ~200 行手写消息路由
└── lib/nodes/          # 用到的节点类型的手写实现，可自由修改
```

runtime 模式：

```
my-app/
├── package.json
├── index.js              # 启动入口
├── settings.js           # 端口、credentialSecret（读 NR_CREDENTIAL_SECRET 环境变量）等
├── flows.json            # 原始导出文件存档
├── flows/<tab>.js        # 每个 tab 一个文件：节点配置 + 连线，可读可改
├── flows/global.js       # 全局 config 节点
├── lib/runtime/          # 内嵌的 RED 门面运行时
├── lib/flow-builder.js
├── credentials.example.json
└── README.md
```

运行：`npm install && npm start`（默认监听 1880 端口，`PORT` 环境变量可改）。

## 凭据（credentials，仅 runtime 模式）

Node-RED 导出时凭据会被剥离。两种方式注入：

- 把凭据按 `credentials.example.json` 的格式（`{ "<节点id>": { "<key>": "<value>" } }`）写进 `credentials.json`（已在 .gitignore）
- 或直接拷贝原 `flows_cred.json` 并设置环境变量 `NR_CREDENTIAL_SECRET`（原 Node-RED 的 credentialSecret）自动解密

## 已知限制

- **rewrite 模式白名单**：只支持 inject / debug / function / change / switch / delay / template / http in / http response / junction / link in / link out；白名单外的类型生成时报错，可退回 `--mode runtime`
- rewrite 模式暂不支持的子特性：inject 的 crontab、delay 的 random/timed 等模式、link call/return、subflow 的 cred 类型 env
- **Dashboard 等编辑器专属节点**（`ui_*`）：依赖 `RED.httpAdmin` 和编辑器 websocket，runtime 模式下会打警告，rewrite 模式不支持
- **httpAdmin 自定义端点**：个别 contrib 节点用它暴露管理接口，runtime 模式里 404
- `subflow` 在生成期静态展开为内联节点
- context 只有内存实现（Node-RED 的 localfilesystem 持久化 context 未实现）
- 消息路由/克隆/env 等语义与官方运行时对齐过（见 test/integration），但边角差异仍可能存在

## 开发

```bash
npm install            # 安装 devDependencies（集成测试用）
npm test               # 单元测试（零依赖）
npm run test:integration  # 集成测试：真实加载 @node-red/nodes 跑流程
```

## License

Apache-2.0。`src/runtime/` 中的 Node/Flow 语义适配自 Node-RED（Copyright JS Foundation and other contributors, Apache-2.0）。
