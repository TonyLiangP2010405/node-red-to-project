# rewrite 模式设计文档（C 方案：完全重写）

日期：2026-08-18
状态：已获用户批准

## 目标

新增 `--mode rewrite`（默认模式）：把 flows.json 转译为**手写风格、零 Node-RED 痕迹**的 JS 项目。节点行为由工具自带的手写节点实现提供（每种类型一个干净文件），不再依赖 `@node-red/nodes`。现有 facade 模式保留为 `--mode runtime` 兜底。

## 生成项目形态

```
my-app/
├── package.json      # 极简依赖：按用到的功能决定（http→express，template→mustache，jsonata 规则→jsonata）
├── index.js          # 启动入口
├── settings.js       # uiPort/uiHost 等
├── flows/<tab>.js    # 配置 + 连线 + function 内联为真实函数
├── lib/runtime.js    # ~200 行消息路由（工具自带模板，拷入）
└── lib/nodes/        # 只用到的节点实现（拷入）
```

flows/<tab>.js 中 function 节点的 `func` 生成为真实 JS 函数（不再是字符串）：

```js
module.exports = flow => {
    flow.add("inject", { id: "basic-inject", payload: "hello", once: true });
    flow.add("function", { id: "basic-function", name: "Uppercase", func(msg, node) {
        msg.payload = msg.payload.toUpperCase();
        return msg;
    } });
    flow.add("debug", { id: "basic-debug", name: "Result" });
    flow.wire("basic-inject", 0, "basic-function");
    flow.wire("basic-function", 0, "basic-debug");
};
```

## mini runtime 契约（src/rewrite/runtime.js，拷入生成项目 lib/runtime.js）

```js
const { createRuntime } = require("./lib/runtime");
const runtime = createRuntime({ settings });
runtime.registerNode(type, factory);   // factory(node, config) -> { input(msg, send, done)?, close()? } | void
const flow = runtime.flow(id, { label, env });  // -> { add(type, config) -> id, wire(fromId, port, toId) }
runtime.start() / runtime.stop();      // Promise
```

node API（factory 的第一个参数）：
- `node.id/name/type`、`node.send(msg)`、`node.log/warn/error/debug/trace()`
- `node.status(obj)`（v1 打到日志）
- `node.context()` → `{ get/set/keys, flow, global }`（内存实现）
- `node.http()` → 惰性创建 express app（仅 http 节点用；未装 express 时报清晰错误）
- `node.onClose(fn)`

消息语义对齐 Node-RED：多接收者时除第一个外克隆 msg；`send([m1, null, m2])` 按输出下标分发；`_msgid` 自动分配；异步投递（setImmediate）。link out 的 `links` 在 flow 构建时转 wires。配置里 `$(VAR)` 整串替换：flow env → process.env。

function 节点：`func(msg, node)` 支持同步返回 msg/数组/null、async 函数、throw 报错；`func.length >= 3` 时以 `(msg, send, done)` 调用。

## 节点白名单 v1（src/rewrite/nodes/*.js）

inject / debug / function / change / switch / delay / template / http in / http response / http request / junction / link in / link out

- junction、link in、link out = 直通节点（links→wires 已由 runtime 处理）
- change/switch 的 jsonata 规则、template 的 mustache：惰性 require，生成项目按需加依赖
- inject 的 crontab、delay 的随机/timed 等冷门子模式：不支持时在生成期报错
- 白名单外类型：生成期报错列清单，提示 `--mode runtime`

## 生成器（src/rewrite/gen.js）

复用 parse/subflow 管线；deps.js 不适用（rewrite 模式不推断 contrib 包）。按用到的功能计算 package.json 依赖。CLI：`--mode rewrite|runtime`，默认 rewrite；web 版 analyze/generate 加 `mode` 参数。

## 测试

- runtime 单测：路由/克隆/多输出/context/env 替换
- 每种节点单测
- E2E：fixtures/basic.json 与 fixtures/http.json 用 rewrite 模式生成并实跑断言
