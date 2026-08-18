"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createRuntime } = require("../src/rewrite/runtime");
const httpRequest = require("../src/rewrite/nodes/http-request");

async function makeFlow(config) {
    const runtime = createRuntime({ settings: {} });
    let source;
    const received = [];
    runtime.registerNode("test-source", node => {
        source = node;
        return {};
    });
    runtime.registerNode("test-sink", () => ({
        input(msg) { received.push(msg); }
    }));
    httpRequest.register(runtime);
    const flow = runtime.flow("test-flow");
    flow.add("test-source", { id: "source" });
    flow.add("http request", { id: "req", ...config });
    flow.add("test-sink", { id: "sink" });
    flow.wire("source", 0, "req");
    flow.wire("req", 0, "sink");
    await runtime.start();
    return {
        runtime,
        async send(msg) {
            source.send(msg);
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(received.length, 1);
            return received[0];
        }
    };
}

function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

test("http request: GET with ret obj parses json and sets statusCode", async () => {
    const { server, port } = await startServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ device: { power: true } }));
    });
    try {
        const flow = await makeFlow({ method: "GET", ret: "obj", url: `http://127.0.0.1:${port}/api` });
        const msg = await flow.send({ payload: "" });
        assert.equal(msg.statusCode, 200);
        assert.deepEqual(msg.payload, { device: { power: true } });
        assert.equal(typeof msg.headers["content-type"], "string");
    } finally {
        server.close();
    }
});

test("http request: POST sends payload as json body", async () => {
    const { server, port } = await startServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({
                method: req.method,
                contentType: req.headers["content-type"],
                body: JSON.parse(body)
            }));
        });
    });
    try {
        const flow = await makeFlow({ method: "POST", ret: "obj", url: `http://127.0.0.1:${port}/power` });
        const msg = await flow.send({ payload: { power: false } });
        assert.equal(msg.payload.method, "POST");
        assert.equal(msg.payload.contentType, "application/json");
        assert.deepEqual(msg.payload.body, { power: false });
    } finally {
        server.close();
    }
});

test("http request: paytoqs query appends payload to query string", async () => {
    const { server, port } = await startServer((req, res) => {
        res.end(req.url);
    });
    try {
        const flow = await makeFlow({ method: "GET", ret: "txt", paytoqs: "query", url: `http://127.0.0.1:${port}/status` });
        const msg = await flow.send({ payload: { a: "1", b: "x y" } });
        assert.equal(msg.payload, "/status?a=1&b=x+y");
    } finally {
        server.close();
    }
});

test("http request: ret txt falls back to raw text when obj parse fails", async () => {
    const { server, port } = await startServer((req, res) => {
        res.end("not json");
    });
    try {
        const flow = await makeFlow({ method: "GET", ret: "obj", url: `http://127.0.0.1:${port}/` });
        const msg = await flow.send({ payload: "" });
        assert.equal(msg.payload, "not json");
    } finally {
        server.close();
    }
});

test("http request: stale response headers in msg.headers are not forwarded", async () => {
    const { server, port } = await startServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, echoed: body }));
        });
    });
    try {
        const flow = await makeFlow({ method: "POST", ret: "obj", url: `http://127.0.0.1:${port}/power` });
        const msg = await flow.send({
            payload: { power: false },
            headers: { "content-length": "9999", connection: "keep-alive", "x-custom": "yes" }
        });
        assert.equal(msg.payload.ok, true);
        assert.deepEqual(msg.payload.echoed, JSON.stringify({ power: false }));
    } finally {
        server.close();
    }
});
