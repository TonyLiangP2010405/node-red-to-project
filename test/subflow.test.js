"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseFlowFile } = require("../src/parse");
const { expandSubflows } = require("../src/subflow");

const fixturesDir = path.join(__dirname, "..", "fixtures");

function readFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

test("expands a subflow instance and rewrites its entry, exit, and env values", () => {
    const parsed = parseFlowFile(readFixture("subflow.json"));
    const result = expandSubflows(parsed);
    const nodes = parsed.tabs[0].nodes;

    assert.equal(result, parsed);
    assert.deepEqual(nodes.map(node => node.id), [
        "subflow-instance:subflow-function",
        "subflow-inject",
        "subflow-sink"
    ]);
    assert.equal(nodes.some(node => node.type === "subflow:subflow-worker"), false);
    assert.deepEqual(nodes[0].wires, [["subflow-sink"]]);
    assert.deepEqual(nodes[1].wires, [["subflow-instance:subflow-function"]]);
    assert.equal(nodes[0].workerMark, "instance");
    assert.equal(nodes[0].workerCount, 7);
    assert.equal(nodes[0].workerEnabled, true);
    assert.deepEqual(nodes[0].workerOptions, { retries: 2 });
});

test("expands nested subflows from the inner boundary to the outer flow", () => {
    const parsed = parseFlowFile([
        {
            id: "sf-inner",
            type: "subflow",
            name: "Inner",
            env: [],
            in: [{ wires: [{ id: "inner-node" }] }],
            out: [{ wires: [{ id: "inner-node", port: 0 }] }]
        },
        {
            id: "inner-node",
            type: "function",
            z: "sf-inner",
            func: "return msg;",
            wires: [[]]
        },
        {
            id: "sf-outer",
            type: "subflow",
            name: "Outer",
            env: [],
            in: [{ wires: [{ id: "outer-inner" }] }],
            out: [{ wires: [{ id: "outer-inner", port: 0 }] }]
        },
        {
            id: "outer-inner",
            type: "subflow:sf-inner",
            z: "sf-outer",
            wires: [[]]
        },
        { id: "tab-nested", type: "tab", label: "Nested" },
        {
            id: "outer-instance",
            type: "subflow:sf-outer",
            z: "tab-nested",
            wires: [["nested-tail"]]
        },
        {
            id: "nested-source",
            type: "inject",
            z: "tab-nested",
            wires: [["outer-instance"]]
        },
        {
            id: "nested-tail",
            type: "debug",
            z: "tab-nested",
            wires: [[]]
        }
    ]);

    expandSubflows(parsed);

    const nodes = parsed.tabs[0].nodes;
    assert.deepEqual(nodes.map(node => node.id), [
        "outer-instance:outer-inner:inner-node",
        "nested-source",
        "nested-tail"
    ]);
    assert.equal(nodes.some(node => node.type.startsWith("subflow:")), false);
    assert.deepEqual(nodes[1].wires, [["outer-instance:outer-inner:inner-node"]]);
    assert.deepEqual(nodes[0].wires, [["nested-tail"]]);
});

test("keeps an instance with a missing definition and records a warning", () => {
    const parsed = parseFlowFile([
        { id: "tab-missing", type: "tab", label: "Missing" },
        {
            id: "missing-instance",
            type: "subflow:does-not-exist",
            z: "tab-missing",
            wires: [[]]
        }
    ]);

    expandSubflows(parsed);

    assert.deepEqual(parsed.tabs[0].nodes, [{
        id: "missing-instance",
        type: "subflow:does-not-exist",
        z: "tab-missing",
        wires: [[]]
    }]);
    assert.match(parsed.warnings.join("\n"), /subflow:does-not-exist/);
});
