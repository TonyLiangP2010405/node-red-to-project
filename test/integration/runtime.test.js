// Integration tests for the standalone runtime, driving real @node-red/nodes.
// Run with: npm run test:integration
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createRuntime } = require("../../src/runtime");

function makeRuntime() {
    const runtime = createRuntime({ settings: {}, userDir: __dirname });
    const loaded = runtime.loadPackage("@node-red/nodes");
    assert.ok(loaded.types.length > 40, "core node types should load");
    const debugMsgs = [];
    runtime.events.on("comms:debug", d => debugMsgs.push(d));
    return { runtime, debugMsgs };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

test("inject -> function -> debug", async () => {
    const { runtime, debugMsgs } = makeRuntime();
    runtime.addFlow({
        id: "tab1", label: "T1",
        nodes: {
            inj: { id: "inj", type: "inject", z: "tab1", props: [{ p: "payload" }], once: true, onceDelay: 0.05, payload: "hello", payloadType: "str", wires: [["fn"]] },
            fn: { id: "fn", type: "function", z: "tab1", name: "up", func: "msg.payload = msg.payload.toUpperCase();\nreturn msg;", outputs: 1, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], wires: [["dbg"]] },
            dbg: { id: "dbg", type: "debug", z: "tab1", name: "out", active: true, console: false, tostatus: false, complete: "payload", statusVal: "", statusType: "auto", wires: [] }
        }
    });
    await runtime.start();
    await wait(500);
    await runtime.stop();
    assert.ok(debugMsgs.some(d => d.msg === "HELLO"), `expected HELLO, got ${JSON.stringify(debugMsgs.map(d => d.msg))}`);
});

test("catch / complete / status semantics", async () => {
    const { runtime, debugMsgs } = makeRuntime();
    runtime.addFlow({
        id: "tab1", label: "T1",
        nodes: {
            inj1: { id: "inj1", type: "inject", z: "tab1", props: [{ p: "payload" }], once: true, onceDelay: 0.05, payload: "boom", payloadType: "str", wires: [["fnErr"]] },
            fnErr: { id: "fnErr", type: "function", z: "tab1", name: "throws", func: "throw new Error(\"kaboom\");", outputs: 1, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], wires: [] },
            catch1: { id: "catch1", type: "catch", z: "tab1", scope: ["fnErr"], uncaught: false, wires: [["dbgCatch"]] },
            dbgCatch: { id: "dbgCatch", type: "debug", z: "tab1", name: "caught", active: true, console: false, tostatus: false, complete: "error.message", statusVal: "", statusType: "auto", wires: [] },

            inj2: { id: "inj2", type: "inject", z: "tab1", props: [{ p: "payload" }], once: true, onceDelay: 0.1, payload: "fine", payloadType: "str", wires: [["fnOk"]] },
            fnOk: { id: "fnOk", type: "function", z: "tab1", name: "ok", func: "node.status(\"working\");\nreturn msg;", outputs: 1, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], wires: [] },
            complete1: { id: "complete1", type: "complete", z: "tab1", scope: ["fnOk"], wires: [["dbgComplete"]] },
            dbgComplete: { id: "dbgComplete", type: "debug", z: "tab1", name: "completed", active: true, console: false, tostatus: false, complete: "payload", statusVal: "", statusType: "auto", wires: [] },

            status1: { id: "status1", type: "status", z: "tab1", scope: ["fnOk"], wires: [["dbgStatus"]] },
            dbgStatus: { id: "dbgStatus", type: "debug", z: "tab1", name: "statused", active: true, console: false, tostatus: false, complete: "status.text", statusVal: "", statusType: "auto", wires: [] }
        }
    });
    await runtime.start();
    await wait(600);
    await runtime.stop();
    const got = debugMsgs.map(d => `${d.name}=${d.msg}`);
    assert.ok(got.some(m => m.startsWith("caught=") && m.includes("kaboom")), `catch failed: ${got}`);
    assert.ok(got.includes("completed=fine"), `complete failed: ${got}`);
    assert.ok(got.includes("statused=working"), `status failed: ${got}`);
});

test("change(jsonata) -> switch -> link out/in -> delay", async () => {
    const { runtime, debugMsgs } = makeRuntime();
    runtime.addFlow({
        id: "tab1", label: "T1",
        nodes: {
            inj: { id: "inj", type: "inject", z: "tab1", props: [{ p: "payload" }], once: true, onceDelay: 0.05, payload: "42", payloadType: "num", wires: [["chg"]] },
            chg: { id: "chg", type: "change", z: "tab1", rules: [{ t: "set", p: "payload", pt: "msg", to: "payload * 2", tot: "jsonata" }], wires: [["sw"]] },
            sw: { id: "sw", type: "switch", z: "tab1", property: "payload", propertyType: "msg", rules: [{ t: "gt", v: "50", vt: "num" }, { t: "else" }], checkall: "true", repair: false, outputs: 2, wires: [["linkOut"], ["dbgLow"]] },
            linkOut: { id: "linkOut", type: "link out", z: "tab1", name: "l1", mode: "link", links: ["linkIn"], wires: [] },
            linkIn: { id: "linkIn", type: "link in", z: "tab1", name: "l1", links: ["linkOut"], wires: [["delay1"]] },
            delay1: { id: "delay1", type: "delay", z: "tab1", pauseType: "delay", timeout: "0.1", timeoutUnits: "seconds", rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, wires: [["dbgHigh"]] },
            dbgHigh: { id: "dbgHigh", type: "debug", z: "tab1", name: "high", active: true, console: false, tostatus: false, complete: "payload", statusVal: "", statusType: "auto", wires: [] },
            dbgLow: { id: "dbgLow", type: "debug", z: "tab1", name: "low", active: true, console: false, tostatus: false, complete: "payload", statusVal: "", statusType: "auto", wires: [] }
        }
    });
    await runtime.start();
    await wait(800);
    await runtime.stop();
    const got = debugMsgs.map(d => `${d.name}=${d.msg}`);
    assert.ok(got.includes("high=84"), `link/delay path failed: ${got}`);
    assert.ok(!got.some(m => m.startsWith("low=")), `else branch should not fire: ${got}`);
});

test("context: flow and global scopes", async () => {
    const { runtime, debugMsgs } = makeRuntime();
    runtime.addFlow({
        id: "tab1", label: "T1",
        nodes: {
            inj: { id: "inj", type: "inject", z: "tab1", props: [{ p: "payload" }], once: true, onceDelay: 0.05, payload: "1", payloadType: "num", wires: [["fn"]] },
            fn: {
                id: "fn", type: "function", z: "tab1", name: "ctx", outputs: 1, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [],
                func: [
                    "const count = (flow.get('count') || 0) + 1;",
                    "flow.set('count', count);",
                    "global.set('seen', true);",
                    "msg.payload = { count, seen: global.get('seen') };",
                    "return msg;"
                ].join("\n"),
                wires: [["dbg"]]
            },
            dbg: { id: "dbg", type: "debug", z: "tab1", name: "out", active: true, console: false, tostatus: false, complete: "payload", statusVal: "", statusType: "auto", wires: [] }
        }
    });
    await runtime.start();
    await wait(500);
    await runtime.stop();
    assert.ok(debugMsgs.some(d => d.msg && d.msg.includes("count") ), `expected context payload, got ${JSON.stringify(debugMsgs.map(d => d.msg))}`);
});
