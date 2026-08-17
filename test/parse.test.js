"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseFlowFile } = require("../src/parse");

const fixturesDir = path.join(__dirname, "..", "fixtures");

function readFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

test("classifies tabs, subflows, groups, global configs, and nodes", () => {
    const flow = [
        {
            id: "tab-1",
            type: "tab",
            label: "Main",
            info: "main flow",
            env: [{ name: "MODE", value: "test", type: "str" }],
            disabled: true,
        },
        {
            id: "subflow-1",
            type: "subflow",
            name: "Worker",
            info: "worker flow",
            env: [],
            in: [{ x: 100, y: 100, wires: [{ id: "subflow-function" }] }],
            out: [{ x: 300, y: 100, wires: [] }],
            meta: { color: "blue" },
        },
        {
            id: "group-1",
            type: "group",
            z: "tab-1",
            name: "Group",
            nodes: ["tab-node"],
        },
        {
            id: "config-1",
            type: "mqtt-broker",
            broker: "localhost",
            port: "1883",
        },
        {
            id: "tab-node",
            type: "function",
            z: "tab-1",
            name: "Uppercase",
            func: "msg.payload = msg.payload.toUpperCase();\\nreturn msg;",
            x: 200,
            y: 120,
            wires: [["tab-debug"]],
            custom: { keep: true },
        },
        {
            id: "tab-debug",
            type: "debug",
            z: "tab-1",
            name: "Debug",
            active: true,
            x: 400,
            y: 120,
            wires: [],
        },
        {
            id: "subflow-function",
            type: "function",
            z: "subflow-1",
            name: "Work",
            func: "return msg;",
            wires: [[]],
        },
        {
            id: "orphan-node",
            type: "debug",
            z: "missing-parent",
            name: "Orphan",
        },
    ];

    const parsed = parseFlowFile(flow);

    assert.equal(parsed.tabs.length, 1);
    assert.equal(parsed.tabs[0].id, "tab-1");
    assert.equal(parsed.tabs[0].label, "Main");
    assert.equal(parsed.tabs[0].info, "main flow");
    assert.deepEqual(parsed.tabs[0].env, flow[0].env);
    assert.equal(parsed.tabs[0].disabled, true);
    assert.deepEqual(parsed.tabs[0].nodes, [flow[4], flow[5]]);

    assert.equal(parsed.subflows.length, 1);
    assert.equal(parsed.subflows[0].id, "subflow-1");
    assert.equal(parsed.subflows[0].name, "Worker");
    assert.deepEqual(parsed.subflows[0].in, flow[1].in);
    assert.deepEqual(parsed.subflows[0].out, flow[1].out);
    assert.deepEqual(parsed.subflows[0].meta, { color: "blue" });
    assert.deepEqual(parsed.subflows[0].nodes, [flow[6]]);

    assert.deepEqual(parsed.groups, [flow[2]]);
    assert.deepEqual(parsed.globalConfigs, [flow[3]]);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /orphan-node/);
});

test("accepts serialized JSON and preserves every node field", () => {
    const node = {
        id: "node-1",
        type: "inject",
        z: "tab-1",
        name: "Start",
        once: true,
        payload: "hello",
        payloadType: "str",
        props: [{ p: "payload", v: "payload", vt: "str" }],
        x: 120,
        y: 80,
        wires: [["node-2"]],
    };
    const parsed = parseFlowFile(JSON.stringify([
        { id: "tab-1", type: "tab", label: "Flow" },
        node,
    ]));

    assert.deepEqual(parsed.tabs[0].nodes[0], node);
    assert.equal(parsed.tabs[0].nodes[0].payloadType, "str");
    assert.deepEqual(parsed.tabs[0].nodes[0].props, node.props);
});

test("parses the basic fixture with its Node-RED topology", () => {
    const parsed = parseFlowFile(readFixture("basic.json"));

    assert.equal(parsed.tabs.length, 1);
    assert.equal(parsed.tabs[0].nodes.length, 3);
    assert.equal(parsed.tabs[0].nodes[0].type, "inject");
    assert.equal(parsed.tabs[0].nodes[0].once, true);
    assert.equal(parsed.tabs[0].nodes[0].payload, "hello");
    assert.equal(parsed.tabs[0].nodes[1].type, "function");
    assert.equal(parsed.tabs[0].nodes[2].type, "debug");
});

test("parses the HTTP fixture and assigns all nodes to its tab", () => {
    const parsed = parseFlowFile(readFixture("http.json"));
    const nodes = parsed.tabs[0].nodes;

    assert.deepEqual(nodes.map((node) => node.type), ["http in", "template", "http response"]);
    assert.equal(nodes[0].method, "get");
    assert.equal(nodes[0].url, "/hello");
    assert.deepEqual(nodes[0].wires, [[nodes[1].id]]);
    assert.deepEqual(nodes[1].wires, [[nodes[2].id]]);
});

test("parses a subflow definition and its instance", () => {
    const parsed = parseFlowFile(readFixture("subflow.json"));

    assert.equal(parsed.subflows.length, 1);
    assert.equal(parsed.subflows[0].in.length, 1);
    assert.equal(parsed.subflows[0].out.length, 1);
    assert.equal(parsed.subflows[0].nodes.length, 1);
    assert.equal(parsed.subflows[0].nodes[0].type, "function");
    assert.equal(parsed.tabs.length, 1);
    assert.equal(parsed.tabs[0].nodes.length, 3);
    assert.equal(parsed.tabs[0].nodes[0].type, `subflow:${parsed.subflows[0].id}`);
    assert.deepEqual(parsed.tabs[0].nodes.map(n => n.type), [
        `subflow:${parsed.subflows[0].id}`,
        "inject",
        "debug"
    ]);
});

test("rejects invalid JSON and non-array input", () => {
    assert.throws(() => parseFlowFile("{not json"), {
        name: "Error",
        message: /invalid JSON/i,
    });
    assert.throws(() => parseFlowFile({}), {
        name: "Error",
        message: /array/i,
    });
    assert.throws(() => parseFlowFile(JSON.stringify({ type: "tab" })), {
        name: "Error",
        message: /array/i,
    });
});
