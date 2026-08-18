"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { parseFlowFile } = require("../src/parse");
const { expandSubflows } = require("../src/subflow");
const { generateRewriteProject } = require("../src/rewrite/gen");

const projectDir = path.resolve(__dirname, "..");
const fixturePath = path.join(projectDir, "fixtures", "basic.json");

function parseFixture() {
    const parsed = parseFlowFile(fs.readFileSync(fixturePath, "utf8"));
    return expandSubflows(parsed);
}

function generate(parsed, inputText = fs.readFileSync(fixturePath, "utf8")) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-to-project-rewrite-"));
    const inputPath = path.join(root, "flows.json");
    const outDir = path.join(root, "app");
    fs.writeFileSync(inputPath, inputText);
    const result = generateRewriteProject({
        inputPath,
        parsed,
        outDir,
        projectName: "rewrite-basic-app"
    });
    return { root, outDir, result };
}

test("generates the complete rewrite project with the union of node dependencies", () => {
    const { outDir, result } = generate(parseFixture());
    const expectedFiles = [
        "package.json",
        "index.js",
        "settings.js",
        "flows.json",
        "flows/basic.js",
        "lib/runtime.js",
        "lib/nodes/inject.js",
        "lib/nodes/function.js",
        "lib/nodes/debug.js",
        "README.md"
    ];
    for (const file of expectedFiles) {
        assert.ok(result.files.includes(file), `missing ${file}`);
        assert.ok(fs.existsSync(path.join(outDir, file)), `not written: ${file}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"));
    assert.equal(packageJson.name, "rewrite-basic-app");
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.scripts.start, "node index.js");
    assert.deepEqual(packageJson.dependencies, {});
    assert.equal(fs.readFileSync(path.join(outDir, "flows.json"), "utf8"), fs.readFileSync(fixturePath, "utf8"));
    assert.equal(
        fs.readFileSync(path.join(outDir, "lib", "runtime.js"), "utf8"),
        fs.readFileSync(path.join(projectDir, "src", "rewrite", "runtime.js"), "utf8")
    );
});

test("renders function bodies as real methods and generated files pass node check", () => {
    const { outDir } = generate(parseFixture());
    const flowPath = path.join(outDir, "flows", "basic.js");
    const flowSource = fs.readFileSync(flowPath, "utf8");

    assert.match(flowSource, /func\(msg, \{ node, context, flow, global, send, done, env \}\) \{/);
    assert.match(flowSource, /msg\.payload = msg\.payload\.toUpperCase\(\);/);
    assert.match(flowSource, /return msg;/);
    assert.doesNotMatch(flowSource, /"func"\s*:/);
    execFileSync(process.execPath, ["--check", flowPath]);
    execFileSync(process.execPath, ["--check", path.join(outDir, "index.js")]);
});

test("rejects unsupported node types and points to runtime mode", () => {
    const parsed = parseFixture();
    parsed.tabs[0].nodes.push({
        id: "unsupported-1",
        type: "node-red-contrib-not-supported",
        z: parsed.tabs[0].id,
        wires: [[]]
    });
    assert.throws(
        () => generate(parsed),
        error => /node-red-contrib-not-supported/.test(error.message) && /--mode runtime/.test(error.message)
    );
});

test("renders wires, disabled nodes, and stable slugs", () => {
    const parsed = parseFixture();
    parsed.tabs[0].label = "Main Flow / QA";
    parsed.tabs[0].nodes[2].d = true;
    const { outDir } = generate(parsed);
    const flowSource = fs.readFileSync(path.join(outDir, "flows", "main-flow-qa.js"), "utf8");

    assert.match(flowSource, /\/\/ basic-inject\[0\] -> basic-function/);
    assert.match(flowSource, /flow\.wire\("basic-inject", 0, "basic-function"\);/);
    assert.match(flowSource, /\/\/ DISABLED: flow\.add\("debug"/);
    assert.match(flowSource, /\/\/ DISABLED: flow\.wire\("basic-function", 0, "basic-debug"\);/);
});

test("cli syntax remains valid", () => {
    execFileSync(process.execPath, ["--check", path.join(projectDir, "bin", "cli.js")]);
});
