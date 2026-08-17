# node-red-to-project

把 Node-RED 导出的 `flows.json` 转换成一个**代码化、可独立运行**的 Node.js 项目——不需要 Node-RED 编辑器，也不需要安装 Node-RED 本体。

## 原理

不重写节点实现。生成的项目内置一个精简的 Node-RED 兼容运行时（RED 门面），流程拓扑、节点配置、function 节点代码全部生成为可读可改的 JS 代码；节点类型的行为则直接加载 `@node-red/nodes`（官方核心节点）和各 `node-red-contrib-*` 包里的**真实实现代码**运行。

## 用法

```bash
node bin/cli.js ./flows.json -o ./my-app
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

## 依赖推断

`flows.json` 里只有节点 `type` 没有包名，工具按三级策略推断：

1. 核心节点 → `@node-red/nodes`
2. 本地反查：扫描 `--user-dir` 下已安装包的 `node-red.nodes` 清单和 `registerType` 调用，拿到精确包名+版本
3. 启发式猜测 `node-red-contrib-<type>`，交互式向你确认（`--yes` 时全自动）

## 生成项目的结构

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

## 凭据（credentials）

Node-RED 导出时凭据会被剥离。两种方式注入：

- 把凭据按 `credentials.example.json` 的格式（`{ "<节点id>": { "<key>": "<value>" } }`）写进 `credentials.json`（已在 .gitignore）
- 或直接拷贝原 `flows_cred.json` 并设置环境变量 `NR_CREDENTIAL_SECRET`（原 Node-RED 的 credentialSecret）自动解密

## 已知限制

- **Dashboard 等编辑器专属节点**（`ui_*`）：依赖 `RED.httpAdmin` 和编辑器 websocket，运行时不可用，会打警告
- **httpAdmin 自定义端点**：个别 contrib 节点用它暴露管理接口，在独立运行时里 404
- `subflow` 在生成期静态展开为内联节点；`cred` 类型的 subflow env 不支持
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
