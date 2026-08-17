# 调研：Node-RED flows.json → 可独立运行的 JS 项目

日期：2026-08-17

## 核心结论

**把 Node-RED 导出的 flows.json「转译」成纯手写 JS 代码 —— 目前没有成熟工具能做到可运行的转译。**
业界可行的路线是：**生成一个完整的 Node.js 项目，内嵌 Node-RED 运行时（headless，无编辑器），加载 flows.json 运行**。这样保真度 100%，所有节点（包括第三方 contrib 节点）都能正常工作。

## 两条技术路线

### 路线 A：内嵌 Node-RED 运行时（推荐，业界标准做法）

官方文档：[Embedding Node-RED into an existing app](https://nodered.org/docs/user-guide/runtime/embedding)

原理：Node-RED 本身是一个 npm 包（`node-red`），可以用 API 编程方式启动：

```javascript
const http = require('http');
const express = require('express');
const RED = require('node-red');

const app = express();
const server = http.createServer(app);

const settings = {
    httpAdminRoot: false,      // 关键：禁用编辑器，纯 headless
    httpNodeRoot: '/api',
    userDir: './data',
    flowFile: 'flows.json',    // 我们的输入文件
    functionGlobalContext: {},
};

RED.init(server, settings);
// 不挂载 RED.httpAdmin（编辑器），只挂 RED.httpNode（http in 节点需要）
if (settings.httpNodeRoot) app.use(settings.httpNodeRoot, RED.httpNode);
server.listen(1880);
RED.start();
```

生成器要做的事：

1. **解析 flows.json** — 用官方 [@node-red/flow-parser](https://github.com/node-red/flow-parser) 校验、提取：
   - 用到的所有节点 `type`
   - 环境变量、子流程（subflow）、全局配置节点（config nodes）
2. **推断 npm 依赖** — 根据节点 type 映射到 npm 包：
   - 核心节点（inject/debug/function/http/mqtt...）→ 只需 `node-red` 本体
   - contrib 节点（如 `node-red-contrib-*`、`node-red-dashboard`）→ 从 type 名推导包名，或让用户在生成时确认依赖表
3. **生成项目骨架**：
   ```
   output/
   ├── package.json        # node-red + 推断出的 contrib 依赖
   ├── index.js            # 上面的启动代码
   ├── settings.js         # 可选，独立配置文件
   ├── flows.json          # 拷贝输入
   ├── .gitignore
   └── README.md           # npm install && npm start 说明
   ```
4. **处理 credentials** — flows.json 导出时凭据通常被剥离（`flows_cred.json` 单独存在），需要在生成的 settings.js 中暴露 `credentialSecret`，或提示用户用环境变量注入。
5. **特殊节点适配**：
   - `http in` / Dashboard 节点 → 需要保留 `httpNodeRoot` 和 express 挂载
   - `function` 节点 → 无需处理，运行时原生支持
   - 文件路径类节点（file in/out）→ 路径是相对 userDir 的，生成项目里固定 userDir 即可

### 路线 B：真正的「转译」成纯 JS（探索性，工作量大）

现有工具都做不到可运行转译：

- [walterl/red2js](https://github.com/walterl/red2js) — 把 flow 转成 JS **伪代码**，作者明确说明"Generated code is NOT executable"，仅用于帮助理解复杂 flow。
- [Node-RED MCU Edition](https://github.com/phoddie/node-red-mcu) — 把 flow 编译到微控制器（ESP32 等）上运行的 JS（Moddable XS 引擎），是「转译」思路的实例，但只支持受限的节点子集，目标是 MCU 而非 Node.js。

如果要做自己的转译器，本质是写一个 mini Node-RED 运行时：

1. 用 flow-parser 解析 JSON，建图（节点 + wires 连线）
2. 实现消息传递语义：msg 克隆规则、多输出分叉、连线到多节点的广播
3. 逐个实现节点类型的 JS 等价物（inject/timer → setInterval，function → 直接内嵌其 JS 代码，switch → 条件路由，change → JSONata 求值……）
4. 节点类型是开放的（几千个 contrib 节点），永远做不完 → 只能支持白名单子集

**结论：除非 flow 只用极少数节点类型且明确不需要第三方节点，否则不要走这条路。**

## 相关工具盘点

| 工具 | 做什么 | 对我们的参考价值 |
|---|---|---|
| [node-red/flow-parser](https://github.com/node-red/flow-parser) | 官方 flows.json 解析/校验库 | 直接用作生成器的解析层 |
| [marcus-j-davies/Node-RED-SFE](https://github.com/marcus-j-davies/Node-RED-SFE) | 用 esbuild + yao-pkg/pkg 把整个 Node-RED 项目打包成单文件可执行程序 | 路线 A 的「打包版」，可参考其 settings 处理、内嵌 flows 的方式；如果最终目标是不需要装 Node.js 的机器，可在路线 A 产物上套 pkg |
| [walterl/red2js](https://github.com/walterl/red2js) | flow → JS 伪代码（不可运行） | 证明纯转译不可行；其 flow 图遍历代码可参考 |
| [hlapp/node-red-embedded-start](https://github.com/hlapp/node-red-embedded-start) | 编程方式启动嵌入式 Node-RED 的封装 | 年代久远（2017），思路可参考，代码别直接用 |
| [phoddie/node-red-mcu](https://github.com/phoddie/node-red-mcu) | flow 编译到 MCU | 转译思路参考，目标平台不同 |

## 依赖推断的细节（路线 A 的难点）

flows.json 里只有节点 `type` 字符串（如 `mqtt in`、`ui_button`、`mssql`），没有包名。推断策略：

1. **查 Node-RED 官方目录 API**：`https://catalogue.nodered.org/` 或 flows.nodered.org 的搜索 API，按节点 type 反查 npm 包（catalogue 数据里有 type → module 映射）
2. **本机反查**：如果用户是在本机 Node-RED 里导出的，`~/.node-red/package.json` 的 dependencies 就是精确答案 —— 生成器可选地读取它来锁定版本
3. **启发式 + 用户确认**：type 前缀匹配常见包名，不确定的列出来让用户勾选

凭据（credentials）单独处理：提示用户设置 `credentialSecret` 环境变量，或在生成的 settings.js 里留配置位。

## 推荐实现方案（给后续开发）

做一个 CLI 工具（比如就叫 node-red-to-project）：

```bash
npx node-red-to-project ./flows.json -o ./my-app
# 生成完整项目
cd my-app && npm install && npm start
# flow 在 1880 端口 headless 运行，无编辑器
```

技术栈：Node.js + Commander（CLI）+ @node-red/flow-parser（解析）+ ejs/模板字符串（生成项目文件）。

里程碑：
1. 解析 flows.json，列出所有节点 type 和依赖推断结果（dry-run 模式）
2. 生成项目骨架 + 启动脚本（仅核心节点的 flow 可跑通）
3. contrib 依赖推断 + 用户确认交互
4. credentials / 环境变量处理
5. 可选：pkg 打包成单文件可执行
