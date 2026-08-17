"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { generateProject } = require("../src/gen");

const projectDir = path.resolve(__dirname, "..");
const runtimeDir = path.join(projectDir, "src", "runtime");

function makeParsed() {
    return {
        tabs: [{
            id: "tab-1",
            label: "Main Flow",
            info: "A test flow",
            env: [{ name: "MODE", value: "test" }],
            disabled: false,
            nodes: [
                {
                    id: "node-1",
                    type: "inject",
                    z: "tab-1",
                    name: "Start",
                    x: 100,
                    y: 200,
                    wires: [["node-2"]],
                    props: [{ p: "payload", v: "hello" }]
                },
                {
                    id: "node-2",
                    type: "node-red-contrib-mystery",
                    z: "tab-1",
                    name: "Disabled mystery",
                    d: true,
                    x: 300,
                    y: 200,
                    wires: [[]],
                    custom: "quoted\\value\n"
                }
            ]
        }],
        globalConfigs: [{
            id: "global-1",
            type: "global-config",
            name: "Global config",
            x: 10,
            y: 20,
            setting: "value"
        }],
        groups: [],
        subflows: [],
        warnings: ["fixture warning"]
    };
}

function generate(outDir, force) {
    const inputPath = path.join(path.dirname(outDir), "source", "flows.json");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    const original = JSON.stringify({ original: true, unicode: "\u4e2d" });
    fs.writeFileSync(inputPath, original);
    return generateProject({
        inputPath,
        parsed: makeParsed(),
        deps: {
            "@node-red/nodes": "^5.0.0",
            "node-red-contrib-mystery": "latest"
        },
        outDir,
        projectName: "generated-flow-app",
        runtimeDir,
        force
    });
}

test("generates a standalone project with code-first flow files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-to-project-"));
    const outDir = path.join(root, "app");
    const result = generate(outDir);

    const expected = [
        "package.json",
        "index.js",
        "settings.js",
        "flows/global.js",
        "flows/main-flow.js",
        "lib/flow-builder.js",
        "lib/runtime/index.js",
        ".gitignore",
        "README.md",
        "flows.json"
    ];
    for (const relativePath of expected) {
        assert.ok(result.files.includes(relativePath), `missing ${relativePath}`);
        assert.ok(fs.existsSync(path.join(outDir, relativePath)), `not written: ${relativePath}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"));
    assert.equal(packageJson.name, "generated-flow-app");
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.scripts.start, "node index.js");
    assert.deepEqual(packageJson.dependencies, {
        "@node-red/nodes": "^5.0.0",
        "@node-red/util": "^5.0.0",
        express: "^4.21.0",
        "node-red-contrib-mystery": "latest"
    });

    const flowSource = fs.readFileSync(path.join(outDir, "flows", "main-flow.js"), "utf8");
    assert.match(flowSource, /flow\.add\("inject"/);
    assert.match(flowSource, /\/\/ node-1\[0\] -> node-2/);
    assert.match(flowSource, /flow\.wire\(n1, 0, n2\)/);
    assert.match(flowSource, /\/\/ DISABLED: flow\.add\("node-red-contrib-mystery"/);
    assert.doesNotMatch(flowSource, /const n2 = flow\.add/);
    assert.doesNotMatch(flowSource, /"x"\s*:/);
    assert.doesNotMatch(flowSource, /"y"\s*:/);
    assert.doesNotMatch(flowSource, /"z"\s*:/);
    assert.doesNotMatch(flowSource, /"wires"\s*:/);

    const globalSource = fs.readFileSync(path.join(outDir, "flows", "global.js"), "utf8");
    assert.match(globalSource, /"global-1"/);
    assert.doesNotMatch(globalSource, /"x"\s*:/);
    assert.doesNotMatch(globalSource, /"y"\s*:/);

    const copiedRuntime = fs.readdirSync(path.join(outDir, "lib", "runtime"))
        .filter(name => name.endsWith(".js"));
    const sourceRuntime = fs.readdirSync(runtimeDir).filter(name => name.endsWith(".js"));
    assert.equal(copiedRuntime.length, sourceRuntime.length);
    assert.equal(
        fs.readFileSync(path.join(outDir, "lib", "runtime", "index.js"), "utf8"),
        fs.readFileSync(path.join(runtimeDir, "index.js"), "utf8")
    );

    const inputCopy = fs.readFileSync(path.join(outDir, "flows.json"), "utf8");
    assert.equal(inputCopy, JSON.stringify({ original: true, unicode: "\u4e2d" }));
    assert.match(fs.readFileSync(path.join(outDir, "README.md"), "utf8"), /fixture warning/);

    execFileSync(process.execPath, ["--check", path.join(outDir, "flows", "main-flow.js")]);
    execFileSync(process.execPath, ["--check", path.join(outDir, "index.js")]);
});

test("rejects non-empty output directories unless force is enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-to-project-"));
    const outDir = path.join(root, "app");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "sentinel.txt"), "existing");

    assert.throws(() => generate(outDir), /non-empty/i);
    assert.doesNotThrow(() => generate(outDir, true));
    assert.ok(fs.existsSync(path.join(outDir, "package.json")));
});
