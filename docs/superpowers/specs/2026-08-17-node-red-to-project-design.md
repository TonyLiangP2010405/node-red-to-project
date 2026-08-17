# node-red-to-project 设计文档

日期：2026-08-17
状态：已获用户批准（架构方案 1：RED 门面运行时）

## 目标

一个通用 CLI 工具：把 Node-RED 导出的 flows.json 转换为一个**逻辑完全代码化**、可独立运行的 Node.js 项目。不依赖 Node-RED 编辑器与官方运行时。

```bash
node node-red-to-project/bin/cli.js ./flows.json -o ./my-app
cd my-app && npm install && npm start
```

## 核心架构：RED 门面运行时

不重写节点实现，而是**直接加载节点包里的真实代码**。Node-RED 核心节点（`@node-red/nodes`）和所有 contrib 节点都是 CommonJS 模块，导出 `(RED) => { RED.nodes.registerType(...) }`。我们实现一个精简 RED 门面（runtime），生成的项目 require 这些真实模块运行。

- 流程拓扑、节点配置、function 节点代码 → 生成为项目中可读可改的 JS
- 节点类型实现 → npm 依赖（`@node-red/nodes` + contrib 包），loader 读取各包 `package.json` 的 `node-red.nodes` 清单注册类型
- 唯一不能完整支持的：依赖编辑器专属 API 的节点（Dashboard `ui_*` 等），运行时警告但不阻塞其余流程

## 工具本体（node-red-to-project/）

零 npm 依赖，纯 Node.js（`node:util` parseArgs），测试用 `node:test`。

```
bin/cli.js        # CLI 入口：<flows.json> -o <outdir> [--yes 跳过交互]
src/parse.js      # 解析 flows.json：tabs / subflows / 全局 config 节点分类
src/deps.js       # type → npm 包推断
src/gen.js        # 代码生成器（模板字符串）
src/runtime/      # RED 门面运行时（拷贝进生成的项目）
test/             # 单元测试 + fixture 驱动的 E2E 冒烟测试
fixtures/         # 测试用 flows.json
```

### 依赖推断（src/deps.js）三级策略

1. **本地反查**：扫描 `~/.node-red/node_modules/*/package.json` 的 `node-red.nodes` 段 + `~/.node-red/package.json` 依赖版本，得到精确的 type → 包@版本 映射
2. **启发式**：核心 type 白名单（inject/debug/function/...）→ `@node-red/nodes`；其余按 `node-red-contrib-*` 命名规则猜
3. **交互确认**：推断不确定的 type 列出清单，用户确认/修正包名；`--yes` 模式下全部按猜测执行并在 README 标注

### 代码生成（src/gen.js）

生成的项目（CommonJS，与 Node-RED 生态一致）：

```
my-app/
├── package.json      # @node-red/nodes + 推断出的 contrib 依赖
├── index.js          # 建 runtime → 加载节点包 → 加载 flows → listen
├── settings.js       # 端口、credentialSecret(读环境变量)、functionGlobalContext
├── flows/<tab>.js    # 每个 tab 一个文件：节点配置对象 + 连线（保留 wires 数组）
├── lib/runtime/      # 门面运行时拷贝
├── credentials.json  # 明文模板（.gitignore）
└── README.md         # 运行说明 + 推断依赖清单 + 不支持的节点警告
```

生成代码决策：节点配置保留 Node-RED 原始字段名和 `wires` 数组，语义 100% 对齐官方，不自创连线表示法。

## RED 门面运行时（src/runtime/，~5 个模块）

- `red.js` — 门面：`nodes.registerType/createNode/getNode`、`util.cloneMessage/generateId`、`_()` i18n 桩、`log`、`settings`、`httpNode`（真实 express app，供 http in 节点）、`httpAdmin`（桩，命中即警告）、`hooks/comms/plugins`（桩）
- `node.js` — Node 基类（EventEmitter）：`on('input'/'close')`、`send/receive/warn/error/status/context/credentials`；msg 多路分发克隆规则与 Node-RED 一致（除最后一个接收者外克隆）
- `loader.js` — 读 npm 依赖包的 `node-red.nodes` 清单，require 并注册类型；加载失败收集为警告清单
- `env.js` — flow/全局 env 变量 + 配置中 `$(VAR)` 替换
- `credentials.js` — 明文 `credentials.json`；设置 `credentialSecret` 时可解密原版 flows_cred.json（aes-256-ctr + sha256 key）

### Node-RED 语义要点（实现时必须对齐）

- `send` 路由按 wires 数组的输出下标分发
- 多分线克隆：除最后一个接收节点外，msg 深克隆
- subflow：生成期静态展开为内联节点（id 重写），subflow env 做映射；不支持的特性给警告
- catch / complete / status 节点：运行时实现对应的错误/完成/状态事件，best-effort

## 错误处理与限制

- 节点包加载失败 / 类型未注册：启动时汇总警告清单，不中断其余节点
- editor 专属 API 被调用：运行时警告一次/类型
- 明确的已知限制写入生成项目的 README

## 测试

- `parse.js` / `deps.js` 单元测试
- fixtures 驱动 E2E：生成项目 → npm install → 实际运行 → 断言行为
  - inject → function → debug（断言日志输出）
  - http in → http response（断言 HTTP 往返）
  - switch / change 链
  - subflow 展开
  - 含 contrib 节点的 flow（断言依赖推断结果）

## 已知风险

这是「重写一个 mini Node-RED 运行时」，消息路由/克隆/env/catch 等语义细节会有边角差异，靠 fixture 测试逐个磨平。第一版目标：常用核心节点跑通，而非一次完美。

## 里程碑

1. parse + deps 推断（dry-run 输出节点清单与依赖表）
2. runtime 最小内核 + inject/function/debug 跑通
3. 项目代码生成 + 首个 E2E
4. http/switch/change/template 等核心节点、env、credentials
5. subflow 展开、catch/complete/status
6. 交互式依赖确认、README 生成、打磨
