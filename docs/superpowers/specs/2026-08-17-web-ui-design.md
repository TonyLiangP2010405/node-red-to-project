# node-red-to-project Web 版设计文档

日期：2026-08-17
状态：已获用户批准

## 目标

给现有 CLI 工具加 Web 前后端：浏览器上传/粘贴 flows.json → 分析节点与依赖（可编辑确认）→ 生成项目 → 页面预览生成的代码 + 下载整个项目 zip。

## 形态

- 零新依赖：`node:http` 做后端，单页静态前端（无构建步骤）
- 启动：`node bin/cli.js --serve [port]`（默认 8321），`npm run web` 快捷脚本
- CLI 原有功能不受影响

## 页面流程

1. 拖拽/选择 flows.json（或粘贴文本）→ 前端读成文本，POST 纯文本 body（不用 multipart）
2. 分析页：节点清单（type/name）、推断依赖表；contrib 包名可在表格中直接编辑；确认后点「生成」
3. 结果页：左侧文件树、右侧代码预览（点击文件查看内容）、顶部「下载 zip」按钮

## 后端 API（src/web/server.js）

- `GET /` → 静态页面（src/web/public/）
- `POST /api/analyze` — body: flows.json 文本 → `{ nodes: [{id,type,name}], resolved: {type: pkg}, deps: {pkg: version}, unknown: [{type, suggestion}], warnings: [] }`；非法 JSON 返回 400 + 错误信息。内部 = parseFlowFile + expandSubflows + inferDependencies
- `POST /api/generate` — body: `{ flow: string, deps: object, projectName?: string }` → 系统临时目录生成项目（generateProject）→ `{ jobId, files: [{path, content}] }`（content 为 utf8 文本，供预览）→ 同时缓存 zip buffer
- `GET /api/download/<jobId>` → `Content-Type: application/zip` + `Content-Disposition: attachment` 下载
- job 存内存 Map，30 分钟过期，惰性清理

## zip（src/zip.js）

零依赖 store-only zip：`createZip(files: [{path, data: string|Buffer}]) -> Buffer`。CRC32 查表法 + local file headers + central directory + EOCD，不压缩（method 0）。生成内容全是文本，体积可接受。

## 测试（test/web.test.js）

node:test + 随机端口起服务 + fetch：
- analyze：正常 flow 返回节点清单与依赖；非法 JSON 返回 400
- generate：返回文件清单，flows/*.js 内容含预期节点 id
- download：zip 可解开（用 unzip 命令或手动解析 EOCD 校验条目数与文件名）
- zip.js 单元测试可并入 web.test.js 或独立 test/zip.test.js

## 约束

- 不引入任何 npm 依赖（工具保持零运行时依赖；devDependencies 不变）
- CommonJS，4 空格缩进
- 不改 src/parse.js / src/deps.js / src/gen.js / src/subflow.js / src/runtime/** 的既有契约
