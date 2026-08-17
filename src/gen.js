"use strict";

const fs = require("node:fs");
const path = require("node:path");

function generateProject(opts) {
    if (!opts || typeof opts !== "object") {
        throw new TypeError("generateProject options are required");
    }
    const required = ["inputPath", "parsed", "deps", "outDir", "projectName", "runtimeDir"];
    for (const key of required) {
        if (opts[key] === undefined || opts[key] === null) {
            throw new TypeError(`generateProject option is required: ${key}`);
        }
    }

    const input = fs.readFileSync(opts.inputPath);
    prepareOutputDirectory(opts.outDir, Boolean(opts.force));

    const files = [];
    const warnings = [...(opts.parsed.warnings || [])];
    const write = (relativePath, content) => {
        const normalized = relativePath.split(path.sep).join("/");
        const target = path.join(opts.outDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        files.push(normalized);
    };

    write("package.json", `${JSON.stringify(makePackageJson(opts.projectName, opts.deps), null, 4)}\n`);
    write("index.js", makeIndex(opts));
    write("settings.js", makeSettings());
    write("flows.json", input);
    write("flows/global.js", makeGlobalFile(opts.parsed.globalConfigs || []));

    const usedFlowSlugs = new Set();
    for (const tab of opts.parsed.tabs || []) {
        const slug = uniqueSlug(tab.label, tab.id, usedFlowSlugs, "flow");
        write(`flows/${slug}.js`, makeFlowFile(tab, warnings));
    }

    const usedSubflowSlugs = new Set();
    for (const subflow of opts.parsed.subflows || []) {
        const slug = uniqueSlug(subflow.name, subflow.id, usedSubflowSlugs, "subflow");
        write(`flows/subflows/${slug}.js`, makeSubflowFile(subflow));
    }

    copyJavaScriptTree(opts.runtimeDir, opts.outDir, "lib/runtime", files);
    write("lib/flow-builder.js", fs.readFileSync(
        path.join(__dirname, "templates", "flow-builder.js"),
        "utf8"
    ));
    write("credentials.example.json", "{}\n");
    write(".gitignore", "node_modules/\ncredentials.json\n");
    write("README.md", makeReadme(opts, warnings));

    return { files, warnings };
}

function prepareOutputDirectory(outDir, force) {
    if (fs.existsSync(outDir)) {
        const stat = fs.statSync(outDir);
        if (!stat.isDirectory()) {
            if (!force) {
                throw new Error(`Output path already exists and is not a directory: ${outDir}`);
            }
            fs.rmSync(outDir, { recursive: true, force: true });
        } else if (fs.readdirSync(outDir).length > 0) {
            if (!force) {
                throw new Error(`Output directory is non-empty: ${outDir} (use --force to overwrite)`);
            }
            fs.rmSync(outDir, { recursive: true, force: true });
        }
    }
    fs.mkdirSync(outDir, { recursive: true });
}

function makePackageJson(projectName, deps) {
    return {
        name: projectName,
        version: "1.0.0",
        private: true,
        scripts: { start: "node index.js" },
        dependencies: {
            ...(deps || {}),
            "@node-red/util": "^5.0.0",
            express: "^4.21.0"
        }
    };
}

function makeIndex(opts) {
    const dependencyNames = Object.keys(opts.deps || {})
        .filter(name => name !== "@node-red/util" && name !== "express")
        .sort();
    const packageLoads = dependencyNames.map(name => {
        const unconfirmed = (opts.unconfirmedDeps || []).includes(name) || opts.deps[name] === "latest";
        const suffix = unconfirmed
            ? "  // 未经确认，如安装失败请修正包名"
            : "";
        return `runtime.loadPackage(${JSON.stringify(name)});${suffix}`;
    });
    if (!dependencyNames.includes("@node-red/nodes") && opts.deps["@node-red/nodes"] === undefined) {
        packageLoads.unshift("runtime.loadPackage(\"@node-red/nodes\");");
    }

    const flowRequires = [];
    const used = new Set();
    for (const tab of opts.parsed.tabs || []) {
        const slug = uniqueSlug(tab.label, tab.id, used, "flow");
        flowRequires.push(`runtime.addFlow(require(${JSON.stringify(`./flows/${slug}`)}));`);
    }

    return `const path = require("path");
const http = require("http");
const express = require("express");
const settings = require("./settings");
const { createRuntime } = require("./lib/runtime");

const runtime = createRuntime({ settings, userDir: __dirname });

// ---- 加载节点包 ----
${packageLoads.join("\n")}

// ---- 全局 config 节点 ----
runtime.setGlobalConfigs(require("./flows/global"));

// ---- 加载 flows ----
${flowRequires.join("\n")}

async function main() {
    let server = null;
    if (settings.httpNodeRoot !== false) {
        const app = express();
        app.use(settings.httpNodeRoot || "/", runtime.httpNode);
        server = http.createServer(app);
        runtime.attachServer(server);
        await new Promise(resolve => server.listen(settings.uiPort, settings.uiHost, resolve));
        console.log(\`Standalone flow listening on http://\${settings.uiHost}:\${settings.uiPort}\${settings.httpNodeRoot}\`);
    }
    await runtime.start();
    console.log("Flows started.");
    const shutdown = async () => { await runtime.stop(); if (server) server.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch(err => { console.error(err); process.exit(1); });
`;
}

function makeSettings() {
    return `// credentialSecret 从环境变量读取，勿硬编码提交
module.exports = {
    uiPort: parseInt(process.env.PORT || "1880", 10),
    uiHost: "0.0.0.0",
    httpNodeRoot: "/",
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || undefined,
    functionGlobalContext: {},
    logging: { console: { level: "info" } }
};
`;
}

function makeGlobalFile(configs) {
    const map = {};
    for (const node of configs) {
        if (!node || !node.id) {
            continue;
        }
        map[node.id] = withoutCoordinates(node);
    }
    return `// 全局 config 节点定义，供 standalone runtime 初始化使用。\nmodule.exports = ${JSON.stringify(map, null, 4)};\n`;
}

function makeFlowFile(tab, warnings) {
    const nodes = tab.nodes || [];
    const variableById = new Map();
    nodes.forEach((node, index) => {
        if (node && node.id) {
            variableById.set(node.id, `n${index + 1}`);
        }
    });

    const lines = [
        `// Flow: ${tab.label || ""} (id: ${tab.id})`,
        "const buildFlowDef = require(\"../lib/flow-builder\");",
        "",
        "module.exports = buildFlowDef({",
        `    id: ${JSON.stringify(tab.id)},`,
        `    label: ${JSON.stringify(tab.label || "")},`,
        `    env: ${indentJson(tab.env || [], 4)},`,
        `    disabled: ${Boolean(tab.disabled)}`,
        "}, flow => {"
    ];

    nodes.forEach(node => {
        if (!node || !node.id || !node.type) {
            return;
        }
        const isSubflow = node.type.startsWith("subflow:");
        const disabled = node.d === true;
        if (isSubflow) {
            warnings.push(`SUBFLOW-INSTANCE: 尚未支持 (${node.id}, ${node.type})`);
        }
        const commentPrefix = isSubflow
            ? "// SUBFLOW-INSTANCE: "
            : disabled
                ? "// DISABLED: "
                : null;
        const variable = commentPrefix ? null : variableById.get(node.id);
        lines.push(...makeAddLines(variable, node, commentPrefix));
    });

    nodes.forEach(node => {
        if (!node || !node.id || !Array.isArray(node.wires)) {
            return;
        }
        node.wires.forEach((destinations, port) => {
            if (!Array.isArray(destinations)) {
                return;
            }
            destinations.forEach(destinationId => {
                if (!destinationId) {
                    return;
                }
                const comment = `// ${node.id}[${port}] -> ${destinationId}`;
                const from = variableById.get(node.id);
                const to = variableById.get(destinationId);
                if (!from || !to || node.d === true || isSubflowType(node.type) ||
                    nodes.some(candidate => candidate && candidate.id === destinationId && candidate.d === true)) {
                    lines.push(`    ${comment}`);
                    lines.push(`    // DISABLED: flow.wire(${from || JSON.stringify(node.id)}, ${port}, ${to || JSON.stringify(destinationId)});`);
                    return;
                }
                lines.push(`    ${comment}`);
                lines.push(`    flow.wire(${from}, ${port}, ${to});`);
            });
        });
    });

    lines.push("});", "");
    return `${lines.join("\n")}\n`;
}

function makeAddLines(variable, node, commentPrefix) {
    const config = withoutNodeRuntimeFields(node);
    const json = JSON.stringify(config, null, 4);
    const type = JSON.stringify(node.type);
    const callPrefix = variable ? `const ${variable} = flow.add(${type}, ` : `flow.add(${type}, `;
    const rendered = json.split("\n");
    rendered[0] = callPrefix + rendered[0];
    rendered[rendered.length - 1] += ");";
    if (commentPrefix) {
        return rendered.map(line => `    ${commentPrefix}${line}`);
    }
    return rendered.map(line => `    ${line}`);
}

function makeSubflowFile(subflow) {
    return `// subflow 将在后续版本静态展开；当前版本原样保留供参考\nmodule.exports = ${JSON.stringify(subflow, null, 4)};\n`;
}

function makeReadme(opts, warnings) {
    const deps = opts.deps || {};
    const dependencyRows = Object.keys(deps).sort()
        .map(name => `| ${name} | ${deps[name]} |`)
        .join("\n");
    const resolved = opts.resolved || {};
    const resolvedRows = Object.keys(resolved).sort()
        .map(type => `| ${type} | ${resolved[type]} |`)
        .join("\n");
    const warningText = warnings.length > 0
        ? warnings.map(warning => `- ${warning}`).join("\n")
        : "- None";
    const resolvedSection = Object.keys(resolved).length > 0
        ? `\n## Resolved node types\n\n| Node type | Package |\n| --- | --- |\n${resolvedRows}\n`
        : "";
    return `# ${opts.projectName}

This project was generated from 'flows.json' by node-red-to-project.

## Usage

1. Copy 'credentials.example.json' to 'credentials.json' when credentials are required.
2. Install dependencies: 'npm install'.
3. Start the standalone flows: 'npm start'.

The HTTP endpoint listens on port 1880 by default. Set 'PORT' and 'NR_CREDENTIAL_SECRET' through the environment.

## Dependencies

| Package | Version |
| --- | --- |
${dependencyRows || "| (none) | |"}
${resolvedSection}
## Warnings

${warningText}

The generated project uses a lightweight RED-compatible facade rather than the Node-RED editor runtime. Review unsupported nodes and inferred packages before deployment.
`;
}

function copyJavaScriptTree(sourceDir, outDir, relativeDir, files) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
            copyJavaScriptTree(sourcePath, outDir, relativePath, files);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            const target = path.join(outDir, relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(sourcePath, target);
            files.push(relativePath.split(path.sep).join("/"));
        }
    }
}

function uniqueSlug(value, id, used, prefix) {
    const raw = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const base = raw || `${prefix}-${String(id || "unknown").slice(0, 6)}`;
    let slug = base;
    let suffix = 2;
    while (used.has(slug)) {
        slug = `${base}-${suffix}`;
        suffix += 1;
    }
    used.add(slug);
    return slug;
}

function withoutCoordinates(node) {
    const copy = { ...node };
    delete copy.x;
    delete copy.y;
    return copy;
}

function withoutNodeRuntimeFields(node) {
    const copy = { ...node };
    delete copy.type;
    delete copy.z;
    delete copy.wires;
    delete copy.x;
    delete copy.y;
    return copy;
}

function indentJson(value, indent) {
    return JSON.stringify(value, null, 4).replace(/\n/g, `\n${" ".repeat(indent)}`);
}

function isSubflowType(type) {
    return typeof type === "string" && type.startsWith("subflow:");
}

module.exports = { generateProject };
