"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRuntime } = require("../src/rewrite/runtime");
const nodeModules = [
    require("../src/rewrite/nodes/inject"),
    require("../src/rewrite/nodes/debug"),
    require("../src/rewrite/nodes/function"),
    require("../src/rewrite/nodes/delay"),
    require("../src/rewrite/nodes/junction"),
    require("../src/rewrite/nodes/link-in"),
    require("../src/rewrite/nodes/link-out")
];

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setupRuntime(settings) {
    const runtime = createRuntime({ settings: settings || {} });
    for (const nodeModule of nodeModules) {
        nodeModule.register(runtime);
    }
    return runtime;
}

function registerSink(runtime, messages) {
    runtime.registerNode("sink", () => ({
        input(msg, send, done) {
            messages.push(msg);
            done();
        }
    }));
}

test("inject once resolves props of every supported type", async () => {
    const messages = [];
    const previousEnv = process.env.REWRITE_MODE_TEST_ENV;
    process.env.REWRITE_MODE_TEST_ENV = "process-env";
    const runtime = setupRuntime();
    registerSink(runtime, messages);
    const flow = runtime.flow("inject-types", {
        env: [{ name: "FLOW_ENV", value: "flow-env", type: "str" }]
    });
    flow.add("seed", { id: "seed" });
    runtime.registerNode("seed", node => {
        node.context().flow.set("flowValue", "from-flow");
        node.context().global.set("globalValue", "from-global");
    });
    flow.add("inject", {
        id: "inject",
        name: "typed",
        payload: "legacy",
        payloadType: "str",
        once: true,
        onceDelay: 0.01,
        props: [
            { p: "text", v: "hello", vt: "str" },
            { p: "number", v: "12.5", vt: "num" },
            { p: "flag", v: "true", vt: "bool" },
            { p: "json", v: "{\"ok\":true}", vt: "json" },
            { p: "date", v: "ignored", vt: "date" },
            { p: "timestamp", v: "ignored", vt: "timestamp" },
            { p: "environment", v: "REWRITE_MODE_TEST_ENV", vt: "env" },
            { p: "substituted", v: "$(FLOW_ENV)", vt: "str" },
            { p: "flowValue", v: "flowValue", vt: "flow" },
            { p: "globalValue", v: "globalValue", vt: "global" }
        ]
    });
    flow.add("sink", { id: "sink" });
    flow.wire("inject", 0, "sink");

    await runtime.start();
    await wait(50);
    await runtime.stop();
    if (previousEnv === undefined) { delete process.env.REWRITE_MODE_TEST_ENV; }
    else { process.env.REWRITE_MODE_TEST_ENV = previousEnv; }

    assert.equal(messages.length, 1);
    const message = messages[0];
    assert.equal(message.payload, "legacy");
    assert.equal(message.text, "hello");
    assert.equal(message.number, 12.5);
    assert.equal(message.flag, true);
    assert.deepEqual(message.json, { ok: true });
    assert.equal(typeof message.date, "number");
    assert.equal(typeof message.timestamp, "number");
    assert.equal(message.environment, "process-env");
    assert.equal(message.substituted, "flow-env");
    assert.equal(message.flowValue, "from-flow");
    assert.equal(message.globalValue, "from-global");
    assert.ok(message._msgid);
});

test("inject repeat stops all future triggers on runtime.stop", async () => {
    const messages = [];
    const runtime = setupRuntime();
    registerSink(runtime, messages);
    const flow = runtime.flow("inject-repeat");
    flow.add("inject", {
        id: "inject",
        payload: "tick",
        payloadType: "str",
        repeat: 0.01
    });
    flow.add("sink", { id: "sink" });
    flow.wire("inject", 0, "sink");

    await runtime.start();
    await wait(55);
    assert.ok(messages.length >= 3);
    await runtime.stop();
    await wait(10);
    const count = messages.length;
    await wait(40);
    assert.equal(messages.length, count);
});

test("function handles sync, multi-output, async, and thrown errors", async () => {
    const syncMessages = [];
    const firstOutput = [];
    const secondOutput = [];
    const asyncMessages = [];
    const runtime = setupRuntime();
    registerSink(runtime, syncMessages);
    runtime.registerNode("first-sink", () => ({ input(msg) { firstOutput.push(msg); } }));
    runtime.registerNode("second-sink", () => ({ input(msg) { secondOutput.push(msg); } }));
    runtime.registerNode("async-sink", () => ({ input(msg) { asyncMessages.push(msg); } }));
    const errors = [];
    const originalError = console.error;
    console.error = message => errors.push(String(message));

    try {
        const flow = runtime.flow("functions");
        for (const id of ["sync-inject", "array-inject", "async-inject", "throw-inject"]) {
            flow.add("inject", {
                id,
                payload: id,
                payloadType: "str",
                once: true,
                onceDelay: 0.01
            });
        }
        flow.add("function", {
            id: "sync",
            func(msg, scope) {
                scope.node.status({ text: "running" });
                return { payload: msg.payload.toUpperCase() };
            }
        });
        flow.add("function", {
            id: "array",
            outputs: 2,
            func(msg) {
                return [{ payload: "first" }, { payload: "second" }];
            }
        });
        flow.add("function", {
            id: "async",
            func: async msg => ({ payload: "async-" + msg.payload })
        });
        flow.add("function", {
            id: "throw",
            func() {
                throw new Error("function boom");
            }
        });
        flow.add("sink", { id: "sync-sink" });
        flow.add("first-sink", { id: "first" });
        flow.add("second-sink", { id: "second" });
        flow.add("async-sink", { id: "async-sink" });
        flow.wire("sync-inject", 0, "sync");
        flow.wire("array-inject", 0, "array");
        flow.wire("async-inject", 0, "async");
        flow.wire("throw-inject", 0, "throw");
        flow.wire("sync", 0, "sync-sink");
        flow.wire("array", 0, "first");
        flow.wire("array", 1, "second");
        flow.wire("async", 0, "async-sink");

        await runtime.start();
        await wait(60);
    } finally {
        await runtime.stop();
        console.error = originalError;
    }

    assert.deepEqual(syncMessages.map(message => message.payload), ["SYNC-INJECT"]);
    assert.deepEqual(firstOutput.map(message => message.payload), ["first"]);
    assert.deepEqual(secondOutput.map(message => message.payload), ["second"]);
    assert.deepEqual(asyncMessages.map(message => message.payload), ["async-async-inject"]);
    assert.ok(errors.some(message => message.includes("function boom")));
});

test("delay mode preserves order and rate mode drops over-limit messages", async () => {
    const delayed = [];
    const dropped = [];
    const runtime = setupRuntime();
    registerSink(runtime, delayed);
    runtime.registerNode("burst", () => ({
        input(msg, send, done) {
            send([[{ payload: 1 }, { payload: 2 }]]);
            done();
        }
    }));
    runtime.registerNode("drop-sink", () => ({ input(msg) { dropped.push(msg); } }));
    const flow = runtime.flow("delays");
    flow.add("inject", { id: "delay-inject", once: true, onceDelay: 0.01 });
    flow.add("delay", {
        id: "delay",
        pauseType: "delay",
        timeout: 0.01,
        timeoutUnits: "seconds"
    });
    flow.add("sink", { id: "delay-sink" });
    flow.wire("delay-inject", 0, "delay");
    flow.wire("delay", 0, "delay-sink");

    flow.add("inject", { id: "rate-inject", once: true, onceDelay: 0.015 });
    flow.add("burst", { id: "burst" });
    flow.add("delay", {
        id: "rate",
        pauseType: "rate",
        rate: 1,
        nbRateUnits: 1,
        rateUnits: "second",
        drop: true
    });
    flow.add("drop-sink", { id: "drop-sink" });
    flow.wire("rate-inject", 0, "burst");
    flow.wire("burst", 0, "rate");
    flow.wire("rate", 0, "drop-sink");

    await runtime.start();
    await wait(100);
    await runtime.stop();

    assert.deepEqual(delayed.map(message => message.payload), [undefined]);
    assert.deepEqual(dropped.map(message => message.payload), [1]);
});

test("junction and links pass messages through, while link return mode is rejected", async () => {
    const messages = [];
    const runtime = setupRuntime();
    registerSink(runtime, messages);
    const flow = runtime.flow("links");
    flow.add("inject", { id: "inject", payload: "linked", payloadType: "str", once: true, onceDelay: 0.01 });
    flow.add("junction", { id: "junction" });
    flow.add("link out", { id: "out", links: ["in"] });
    flow.add("link in", { id: "in", links: ["out"] });
    flow.add("sink", { id: "sink" });
    flow.wire("inject", 0, "junction");
    flow.wire("junction", 0, "out");
    flow.wire("in", 0, "sink");

    await runtime.start();
    await wait(40);
    await runtime.stop();
    assert.deepEqual(messages.map(message => message.payload), ["linked"]);

    const badRuntime = setupRuntime();
    const badFlow = badRuntime.flow("bad-link");
    badFlow.add("link out", { id: "return", mode: "return" });
    await assert.rejects(() => badRuntime.start(), /link call\/return 暂不支持/);
});

test("debug reads complete paths and ignores inactive nodes", async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = message => logs.push(String(message));
    try {
        const runtime = setupRuntime();
        const flow = runtime.flow("debug");
        flow.add("inject", {
            id: "active-inject",
            payload: "ignored",
            payloadType: "str",
            once: true,
            onceDelay: 0.01,
            props: [{ p: "nested.value", v: "debug-value", vt: "str" }]
        });
        flow.add("debug", { id: "active-debug", name: "active", complete: "nested.value" });
        flow.wire("active-inject", 0, "active-debug");
        flow.add("inject", { id: "inactive-inject", payload: "hidden", payloadType: "str", once: true, onceDelay: 0.01 });
        flow.add("debug", { id: "inactive-debug", name: "inactive", active: false });
        flow.wire("inactive-inject", 0, "inactive-debug");
        flow.add("inject", { id: "object-inject", payload: "ignored", payloadType: "str", once: true, onceDelay: 0.01 });
        flow.add("function", { id: "object-function", func: msg => ({ nested: { value: "whole" }, payload: msg.payload }) });
        flow.add("debug", { id: "object-debug", name: "whole", completeType: "msg" });
        flow.wire("object-inject", 0, "object-function");
        flow.wire("object-function", 0, "object-debug");

        await runtime.start();
        await wait(50);
        await runtime.stop();
    } finally {
        console.log = originalLog;
    }

    assert.ok(logs.some(message => message.includes("[debug:active] debug-value")));
    assert.ok(logs.some(message => message.includes("[debug:whole] {\"nested\":{\"value\":\"whole\"}")));
    assert.ok(!logs.some(message => message.includes("[debug:inactive]")));
});

test("unsupported delay pause types fail during construction", async () => {
    const runtime = setupRuntime();
    const flow = runtime.flow("bad-delay");
    flow.add("delay", { id: "bad", pauseType: "random" });
    await assert.rejects(() => runtime.start(), /不支持的 pauseType/);
});
