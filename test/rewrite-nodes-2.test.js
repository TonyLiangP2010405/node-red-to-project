"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createRuntime } = require("../src/rewrite/runtime");
const change = require("../src/rewrite/nodes/change");
const sw = require("../src/rewrite/nodes/switch");
const template = require("../src/rewrite/nodes/template");
const httpIn = require("../src/rewrite/nodes/http-in");
const httpResponse = require("../src/rewrite/nodes/http-response");

const inspectModules = path.join("/tmp", "nr-inspect", "node_modules");

function optionalModule(name) {
    try {
        return require(name);
    } catch (err) {
        try {
            return require(require.resolve(name, { paths: [inspectModules] }));
        } catch (resolveErr) {
            return null;
        }
    }
}

const hasJsonata = Boolean(optionalModule("jsonata"));
const hasMustache = Boolean(optionalModule("mustache"));

async function makeFlow(nodes, wires, registerNodes) {
    const runtime = createRuntime({ settings: {} });
    let source;
    const received = new Map();
    runtime.registerNode("test-source", node => {
        source = node;
        return {};
    });
    runtime.registerNode("test-sink", node => ({
        input(msg) {
            const list = received.get(node.id) || [];
            list.push(msg);
            received.set(node.id, list);
        }
    }));
    if (registerNodes) {
        registerNodes(runtime);
    }
    const flow = runtime.flow("test-flow");
    flow.add("test-source", { id: "source" });
    for (const node of nodes) {
        flow.add(node.type, { id: node.id, ...(node.config || {}) });
    }
    const nodeIds = new Set(["source", ...nodes.map(node => node.id)]);
    for (const wire of wires) {
        if (!nodeIds.has(wire[2])) {
            flow.add("test-sink", { id: wire[2] });
            nodeIds.add(wire[2]);
        }
    }
    for (const wire of wires) {
        flow.wire(wire[0], wire[1], wire[2]);
    }
    await runtime.start();
    return {
        runtime,
        source,
        received,
        async send(msg) {
            source.send(msg);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    };
}

function onlyMessage(flow, id) {
    const messages = flow.received.get(id) || [];
    assert.equal(messages.length, 1);
    return messages[0];
}

test("change applies set, move, delete, rename, typed values, and contexts", async () => {
    process.env.REWRITE_CHANGE_TEST_ENV = "from-env";
    const flow = await makeFlow([
        {
            type: "change",
            id: "change",
            config: {
                rules: [
                    { t: "set", p: "set", pt: "msg", to: "hello", tot: "str" },
                    { t: "set", p: "number", pt: "msg", to: "42", tot: "num" },
                    { t: "set", p: "flag", pt: "msg", to: "true", tot: "bool" },
                    { t: "set", p: "object", pt: "msg", to: "{\"ok\":true}", tot: "json" },
                    { t: "set", p: "stamp", pt: "msg", to: "", tot: "date" },
                    { t: "set", p: "fromEnv", pt: "msg", to: "REWRITE_CHANGE_TEST_ENV", tot: "env" },
                    { t: "set", p: "fromMsg", pt: "msg", to: "source", tot: "msg" },
                    { t: "set", p: "fromFlow", pt: "msg", to: "flowValue", tot: "flow" },
                    { t: "set", p: "fromGlobal", pt: "msg", to: "globalValue", tot: "global" },
                    { t: "set", p: "flowWritten", pt: "flow", to: "written", tot: "str" },
                    { t: "set", p: "globalWritten", pt: "global", to: "written", tot: "str" },
                    { t: "move", p: "moved", pt: "msg", from: "payload.old", fromt: "msg" },
                    { t: "rename", p: "renamed", pt: "msg", from: "payload.name", fromt: "msg" },
                    { t: "delete", p: "payload.remove", pt: "msg" }
                ]
            }
        }
    ], [["source", 0, "change"], ["change", 0, "sink"]], runtime => {
        change.register(runtime);
    });
    flow.source.context().flow.set("flowValue", "from-flow");
    flow.source.context().global.set("globalValue", "from-global");
    await flow.send({ payload: { old: "moved-value", name: "renamed-value", remove: true }, source: "message" });
    const msg = onlyMessage(flow, "sink");

    assert.equal(msg.set, "hello");
    assert.equal(msg.number, 42);
    assert.equal(msg.flag, true);
    assert.deepEqual(msg.object, { ok: true });
    assert.equal(typeof msg.stamp, "number");
    assert.equal(msg.fromEnv, "from-env");
    assert.equal(msg.fromMsg, "message");
    assert.equal(msg.fromFlow, "from-flow");
    assert.equal(msg.fromGlobal, "from-global");
    assert.equal(flow.source.context().flow.get("flowWritten"), "written");
    assert.equal(flow.source.context().global.get("globalWritten"), "written");
    assert.equal(msg.moved, "moved-value");
    assert.equal(msg.renamed, "renamed-value");
    assert.equal(msg.payload.old, undefined);
    assert.equal(msg.payload.name, undefined);
    assert.equal(msg.payload.remove, undefined);
    await flow.runtime.stop();
    delete process.env.REWRITE_CHANGE_TEST_ENV;
});

test("change evaluates jsonata values when jsonata is available", { skip: !hasJsonata }, async () => {
    const flow = await makeFlow([
        {
            type: "change",
            id: "change",
            config: { rules: [{ t: "set", p: "payload.total", pt: "msg", to: "payload.a + payload.b", tot: "jsonata" }] }
        }
    ], [["source", 0, "change"], ["change", 0, "sink"]], runtime => change.register(runtime));
    await flow.send({ payload: { a: 2, b: 3 } });
    assert.equal(onlyMessage(flow, "sink").payload.total, 5);
    await flow.runtime.stop();
});

function switchFlow(property, rules, checkall) {
    const runtime = createRuntime({ settings: {} });
    let source;
    const received = new Map();
    runtime.registerNode("test-source", node => { source = node; return {}; });
    rules.forEach((rule, index) => {
        runtime.registerNode(`sink-${index}`, node => ({
            input(msg) {
                const list = received.get(node.id) || [];
                list.push(msg);
                received.set(node.id, list);
            }
        }));
    });
    sw.register(runtime);
    const flow = runtime.flow("switch-flow");
    flow.add("test-source", { id: "source" });
    flow.add("switch", { id: "switch", property, propertyType: "msg", rules, checkall });
    flow.wire("source", 0, "switch");
    rules.forEach((rule, index) => {
        flow.add(`sink-${index}`, { id: `sink-${index}` });
        flow.wire("switch", index, `sink-${index}`);
    });
    return { runtime, source, received, async start() { await runtime.start(); }, async send(msg) {
        source.send(msg);
        await new Promise(resolve => setTimeout(resolve, 25));
    } };
}

test("switch evaluates comparison, containment, regex, null, hask, and istype operators", async () => {
    const cases = [
        [{ payload: 5 }, { t: "eq", v: "5", vt: "str" }],
        [{ payload: 5 }, { t: "neq", v: "6", vt: "num" }],
        [{ payload: 5 }, { t: "lt", v: "6", vt: "num" }],
        [{ payload: 5 }, { t: "lte", v: "5", vt: "num" }],
        [{ payload: 5 }, { t: "gt", v: "4", vt: "num" }],
        [{ payload: 5 }, { t: "gte", v: "5", vt: "num" }],
        [{ payload: 5 }, { t: "between", v: "1", vt: "num", v2: "10", v2t: "num" }],
        [{ payload: "hello" }, { t: "cont", v: "ell", vt: "str" }],
        [{ payload: "Hello" }, { t: "regex", v: "^hello$", vt: "str", case: true }],
        [{ payload: true }, { t: "true", v: "ignored", vt: "str" }],
        [{ payload: false }, { t: "false", v: "ignored", vt: "str" }],
        [{ other: 1 }, { t: "null", v: "ignored", vt: "str" }],
        [{ payload: 1 }, { t: "nnull", v: "ignored", vt: "str" }],
        [{ payload: { key: 1 } }, { t: "hask", v: "key", vt: "str" }],
        [{ payload: "text" }, { t: "istype", v: "string", vt: "str" }],
        [{ payload: [1] }, { t: "istype", v: "array", vt: "str" }],
        [{ payload: null }, { t: "istype", v: "null", vt: "str" }]
    ];
    for (const [msg, rule] of cases) {
        const flow = switchFlow("payload", [rule]);
        await flow.start();
        await flow.send(msg);
        assert.equal((flow.received.get("sink-0") || []).length, 1, rule.t);
        await flow.runtime.stop();
    }
});

test("switch sends all matching outputs, otherwise stops at the first, and supports else", async () => {
    const rules = [
        { t: "eq", v: "5", vt: "num" },
        { t: "gt", v: "1", vt: "num" },
        { t: "lt", v: "0", vt: "num" },
        { t: "else", v: "ignored", vt: "str" }
    ];
    const all = switchFlow("payload", rules, "true");
    await all.start();
    await all.send({ payload: 5 });
    assert.equal((all.received.get("sink-0") || []).length, 1);
    assert.equal((all.received.get("sink-1") || []).length, 1);
    assert.equal((all.received.get("sink-2") || []).length, 0);
    assert.equal((all.received.get("sink-3") || []).length, 0);
    await all.runtime.stop();

    const first = switchFlow("payload", rules, "false");
    await first.start();
    await first.send({ payload: 5 });
    assert.equal((first.received.get("sink-0") || []).length, 1);
    assert.equal((first.received.get("sink-1") || []).length, 0);
    await first.runtime.stop();

    const otherwise = switchFlow("payload", rules, "true");
    await otherwise.start();
    await otherwise.send({ payload: "no-match" });
    assert.equal((otherwise.received.get("sink-3") || []).length, 1);
    await otherwise.runtime.stop();
});

test("switch evaluates jsonata rule values when jsonata is available", { skip: !hasJsonata }, async () => {
    const flow = switchFlow("payload", [{ t: "eq", v: "limit + 1", vt: "jsonata" }]);
    await flow.start();
    await flow.send({ payload: 3, limit: 2 });
    assert.equal((flow.received.get("sink-0") || []).length, 1);
    await flow.runtime.stop();
});

test("template renders variables, custom fields, and plain syntax", { skip: !hasMustache }, async () => {
    const flow = await makeFlow([
        { type: "template", id: "template", config: { template: "Hello {{name}}", field: "payload.text" } }
    ], [["source", 0, "template"], ["template", 0, "sink"]], runtime => template.register(runtime));
    await flow.send({ name: "Ada" });
    assert.equal(onlyMessage(flow, "sink").payload.text, "Hello Ada");
    await flow.runtime.stop();

    const plain = await makeFlow([
        { type: "template", id: "template", config: { template: "{{name}}", syntax: "plain" } }
    ], [["source", 0, "template"], ["template", 0, "sink"]], runtime => template.register(runtime));
    await plain.send({ name: "Ada" });
    assert.equal(onlyMessage(plain, "sink").payload, "{{name}}");
    await plain.runtime.stop();
});

async function startHttp(method, pathName) {
    const runtime = createRuntime({ settings: { uiPort: 18765 + Math.floor(Math.random() * 1000), uiHost: "127.0.0.1" } });
    httpIn.register(runtime);
    httpResponse.register(runtime);
    runtime.registerNode("test-function", () => ({
        input(msg, send, done) {
            if (msg.req.method === "GET") {
                msg.payload = "hello from function";
            } else {
                msg.payload = { received: msg.payload.value };
            }
            send(msg);
            done();
        }
    }));
    const flow = runtime.flow("http-flow");
    flow.add("http in", { id: "http-in", method, url: pathName });
    flow.add("test-function", { id: "function" });
    flow.add("http response", { id: "http-response", statusCode: 200 });
    flow.wire("http-in", 0, "function");
    flow.wire("function", 0, "http-response");
    await runtime.start();
    return { runtime, port: runtime.settings.uiPort };
}

test("http in and http response serve GET and JSON POST flows", async () => {
    const getFlow = await startHttp("get", "/hello");
    try {
        const getResponse = await fetch(`http://127.0.0.1:${getFlow.port}/hello`);
        assert.equal(getResponse.status, 200);
        assert.equal(await getResponse.text(), "hello from function");
    } finally {
        await getFlow.runtime.stop();
    }

    const postFlow = await startHttp("post", "/echo");
    try {
        const postResponse = await fetch(`http://127.0.0.1:${postFlow.port}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value: "parsed" })
        });
        assert.equal(postResponse.status, 200);
        assert.deepEqual(await postResponse.json(), { received: "parsed" });
    } finally {
        await postFlow.runtime.stop();
    }
});
