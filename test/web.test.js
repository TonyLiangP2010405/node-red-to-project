"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

const { startServer } = require("../src/web/server");

const flow = fs.readFileSync(path.join(__dirname, "..", "fixtures", "basic.json"), "utf8");
let server;
let baseUrl;

test.before(async () => {
    server = startServer({ port: 0 });
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test("serves the Web UI and analyzes a flow", { timeout: 30_000 }, async () => {
    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type"), /text\/html; charset=utf-8/i);
    assert.match(await pageResponse.text(), /Node-RED 项目生成器/);

    const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ flow, mode: "runtime" })
    });
    assert.equal(response.status, 200);
    const result = await response.json();

    assert.deepEqual(result.nodes.map(node => node.id), [
        "basic-inject",
        "basic-function",
        "basic-debug"
    ]);
    assert.deepEqual(result.nodes.map(node => node.type), ["inject", "function", "debug"]);
    assert.deepEqual(result.deps, { "@node-red/nodes": "^5.0.0" });
    assert.deepEqual(result.resolved, {
        inject: "@node-red/nodes",
        function: "@node-red/nodes",
        debug: "@node-red/nodes"
    });
    assert.deepEqual(result.unknown, []);
    assert.deepEqual(result.warnings, []);
});

test("analyze defaults to rewrite mode and reports unsupported types", { timeout: 30_000 }, async () => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: flow
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    // rewrite mode: no contrib deps to confirm, whitelisted types fully supported
    assert.deepEqual(result.deps, {});
    assert.deepEqual(result.unsupportedTypes, []);
});

test("returns 400 for invalid flow JSON", { timeout: 30_000 }, async () => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "{not valid json"
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.match(result.error, /Invalid JSON|JSON/i);
});

test("generates preview files and downloads a ZIP job", { timeout: 30_000 }, async () => {
    const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
            flow,
            mode: "runtime",
            deps: { "@node-red/nodes": "^5.0.0" },
            projectName: "basic-app"
        })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.jobId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(result.files));

    const packageFile = result.files.find(file => file.path === "package.json");
    assert.ok(packageFile);
    assert.equal(JSON.parse(packageFile.content).name, "basic-app");
    const flowFile = result.files.find(file => file.path.startsWith("flows/") &&
        file.path !== "flows/global.js" && file.path.endsWith(".js"));
    assert.ok(flowFile);
    assert.match(flowFile.content, /basic-inject/);

    const download = await fetch(`${baseUrl}/api/download/${result.jobId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.match(download.headers.get("content-disposition"), /filename="basic-app\.zip"/);
    const zip = Buffer.from(await download.arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString("ascii"), "PK");
});

test("returns 404 for an unknown download job and route", { timeout: 30_000 }, async () => {
    const download = await fetch(`${baseUrl}/api/download/not-a-job`);
    assert.equal(download.status, 404);
    const missingRoute = await fetch(`${baseUrl}/not-found`);
    assert.equal(missingRoute.status, 404);
});
