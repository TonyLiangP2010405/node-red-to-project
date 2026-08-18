"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { inferDependencies } = require("../deps");
const { generateProject } = require("../gen");
const { generateRewriteProject, getUnsupportedNodeTypes } = require("../rewrite/gen");
const { parseFlowFile } = require("../parse");
const { expandSubflows } = require("../subflow");

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

/**
 * @param {{ port?: number, userDir?: string }} opts
 * @returns {http.Server} 已 listen 的服务器（server.address().port 可取实际端口）
 */
function startServer(opts = {}) {
    const options = opts || {};
    const port = options.port === undefined ? 8321 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new RangeError("Web server port must be an integer between 0 and 65535");
    }

    const publicFile = path.join(__dirname, "public", "index.html");
    const server = http.createServer((request, response) => {
        handleRequest(request, response, {
            publicFile,
            userDir: options.userDir
        }).catch(error => {
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            sendJson(response, 500, { error: error.message || "服务器内部错误" });
        });
    });
    server.listen(port);
    return server;
}

async function handleRequest(request, response, options) {
    cleanupJobs();
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
        return serveIndex(response, options.publicFile);
    }

    if (request.method === "POST" && url.pathname === "/api/analyze") {
        return handleAnalyze(request, response, options.userDir);
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
        return handleGenerate(request, response, options.userDir);
    }

    const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
    if (request.method === "GET" && downloadMatch) {
        return handleDownload(response, decodeURIComponent(downloadMatch[1]));
    }

    sendJson(response, 404, { error: "Not found" });
}

function serveIndex(response, publicFile) {
    let html;
    try {
        html = fs.readFileSync(publicFile, "utf8");
    } catch (error) {
        sendJson(response, 500, { error: `无法读取 Web 页面：${error.message}` });
        return;
    }
    response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html)
    });
    response.end(html);
}

async function handleAnalyze(request, response, userDir) {
    let body;
    try {
        body = await readBody(request);
    } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
        return;
    }

    try {
        const requestData = parseAnalyzeBody(body);
        const mode = parseMode(requestData.mode);
        const parsed = parseFlowFile(requestData.flow);
        expandSubflows(parsed);
        const nodes = collectNodes(parsed);
        if (mode === "rewrite") {
            sendJson(response, 200, {
                mode,
                nodes,
                deps: {},
                resolved: {},
                unsupportedTypes: getUnsupportedNodeTypes(parsed),
                warnings: parsed.warnings || []
            });
            return;
        }
        const types = [...new Set(nodes.map(node => node.type).filter(Boolean))];
        const inference = inferDependencies(types, { userDir });
        sendJson(response, 200, {
            mode,
            nodes,
            deps: inference.deps || {},
            resolved: inference.resolved || {},
            unknown: inference.unknown || [],
            unsupportedTypes: [],
            warnings: parsed.warnings || []
        });
    } catch (error) {
        sendJson(response, 400, { error: error.message || "无法解析 flows.json" });
    }
}

async function handleGenerate(request, response, userDir) {
    let body;
    try {
        body = await readBody(request);
    } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
        return;
    }

    let input;
    try {
        input = JSON.parse(body);
    } catch (error) {
        sendJson(response, 400, { error: `请求 JSON 无效：${error.message}` });
        return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.flow !== "string") {
        sendJson(response, 400, { error: "请求必须包含 flow 字符串" });
        return;
    }
    if (input.deps !== undefined &&
        (!input.deps || typeof input.deps !== "object" || Array.isArray(input.deps))) {
        sendJson(response, 400, { error: "deps 必须是对象" });
        return;
    }

    let mode;
    try {
        mode = parseMode(input.mode);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }
    const projectName = typeof input.projectName === "string" && input.projectName.trim()
        ? input.projectName.trim()
        : "my-flow-app";
    const deps = input.deps || {};
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-to-project-web-"));
    const inputPath = path.join(tempRoot, "flows.json");
    const outDir = path.join(tempRoot, "project");

    try {
        fs.writeFileSync(inputPath, input.flow, "utf8");
        const parsed = parseFlowFile(input.flow);
        expandSubflows(parsed);
        const result = mode === "rewrite"
            ? generateRewriteProject({
                inputPath,
                parsed,
                outDir,
                projectName,
                force: false
            })
            : generateProject({
                inputPath,
                parsed,
                deps,
                outDir,
                projectName,
                runtimeDir: path.join(__dirname, "..", "runtime"),
                force: false
            });
        const files = result.files.map(relativePath => {
            const normalizedPath = relativePath.split(path.sep).join("/");
            const content = fs.readFileSync(path.join(outDir, relativePath), "utf8");
            return { path: normalizedPath, content };
        });
        const { createZip } = require("../zip");
        const zip = createZip(files.map(file => ({ path: file.path, data: file.content })));
        const jobId = crypto.randomUUID();
        jobs.set(jobId, { zip, projectName, createdAt: Date.now() });
        sendJson(response, 200, {
            jobId,
            files,
            warnings: result.warnings || []
        });
    } catch (error) {
        sendJson(response, 400, { error: error.message || "项目生成失败" });
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function handleDownload(response, jobId) {
    const job = jobs.get(jobId);
    if (!job || Date.now() - job.createdAt >= JOB_TTL_MS) {
        if (job) {
            jobs.delete(jobId);
        }
        sendJson(response, 404, { error: "下载任务不存在或已过期" });
        return;
    }

    const filename = `${safeFilename(job.projectName)}.zip`;
    response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": job.zip.length
    });
    response.end(job.zip);
}

function collectNodes(parsed) {
    const nodes = [];
    const addNodes = list => {
        for (const node of list || []) {
            if (!node || typeof node !== "object") {
                continue;
            }
            nodes.push({
                id: node.id || "",
                type: node.type || "",
                name: node.name || ""
            });
        }
    };
    for (const tab of parsed.tabs || []) {
        addNodes(tab.nodes);
    }
    addNodes(parsed.globalConfigs);
    return nodes;
}

function parseAnalyzeBody(body) {
    let value;
    try {
        value = JSON.parse(body);
    } catch {
        return { flow: body, mode: "rewrite" };
    }
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.flow === "string") {
        return { flow: value.flow, mode: value.mode };
    }
    return { flow: body, mode: "rewrite" };
}

function parseMode(value) {
    const mode = value || "rewrite";
    if (mode !== "rewrite" && mode !== "runtime") {
        throw new Error(`Invalid mode: ${mode}. Use rewrite or runtime.`);
    }
    return mode;
}

function cleanupJobs() {
    const expiresAt = Date.now() - JOB_TTL_MS;
    for (const [jobId, job] of jobs) {
        if (job.createdAt <= expiresAt) {
            jobs.delete(jobId);
        }
    }
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = error => {
            if (settled) {
                return;
            }
            settled = true;
            request.resume();
            reject(error);
        };

        request.on("data", chunk => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                fail(Object.assign(new Error("请求体超过 20MB 限制"), { statusCode: 413 }));
                return;
            }
            if (!settled) {
                chunks.push(chunk);
            }
        });
        request.on("end", () => {
            if (!settled) {
                settled = true;
                resolve(Buffer.concat(chunks).toString("utf8"));
            }
        });
        request.on("error", error => fail(error));
    });
}

function sendJson(response, statusCode, value) {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
    });
    response.end(body);
}

function safeFilename(value) {
    const filename = String(value || "my-flow-app")
        .replace(/[\\/\r\n"]/g, "_")
        .replace(/[^\x20-\x7e]/g, "_")
        .trim();
    return filename || "my-flow-app";
}

module.exports = { startServer };
