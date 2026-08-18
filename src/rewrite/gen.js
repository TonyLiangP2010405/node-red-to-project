"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_SOURCE = path.join(__dirname, "runtime.js");
const NODES_SOURCE = path.join(__dirname, "nodes");
const DEFAULT_VERSIONS = {
    express: "^4.21.0",
    mustache: "^4.2.0",
    jsonata: "^2.0.0"
};

/**
 * Generate a hand-written-style, zero-Node-RED-dependency project.
 *
 * @param {{ inputPath: string, parsed: object, outDir: string, projectName: string, force?: boolean }} opts
 * @returns {{ files: string[], warnings: string[] }}
 */
function generateRewriteProject(opts) {
    validateOptions(opts);
    const implementations = readNodeImplementations();
    const nodes = collectFlowNodes(opts.parsed);
    const unsupported = [...new Set(nodes.map(node => node.type).filter(type => !implementations.has(type)))].sort();
    if (unsupported.length > 0) {
        throw new Error(
            `Unsupported node types: ${unsupported.join(", ")}. ` +
            "Use --mode runtime as a fallback."
        );
    }

    prepareOutputDirectory(opts.outDir, Boolean(opts.force));
    const input = fs.readFileSync(opts.inputPath);
    const files = [];
    const warnings = [...(opts.parsed.warnings || [])];
    const write = (relativePath, content) => {
        const normalized = relativePath.split(path.sep).join("/");
        const target = path.join(opts.outDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        files.push(normalized);
    };

    const usedTypes = [...new Set(nodes.map(node => node.type))].sort();
    const dependencies = makeDependencies(usedTypes, implementations);
    write("package.json", `${JSON.stringify(makePackageJson(opts.projectName, dependencies), null, 4)}\n`);
    write("index.js", makeIndex(opts.parsed, usedTypes, implementations));
    write("settings.js", makeSettings());
    write("flows.json", input);

    const usedSlugs = new Set();
    for (const tab of opts.parsed.tabs || []) {
        const slug = uniqueSlug(tab.label, tab.id, usedSlugs, "flow");
        write(`flows/${slug}.js`, makeFlowFile(tab));
    }

    fs.mkdirSync(path.join(opts.outDir, "lib", "nodes"), { recursive: true });
    write("lib/runtime.js", fs.readFileSync(RUNTIME_SOURCE));
    for (const type of usedTypes) {
        const implementation = implementations.get(type);
        const relativePath = `lib/nodes/${implementation.fileName}`;
        write(relativePath, fs.readFileSync(implementation.sourcePath));
    }
    write("README.md", makeReadme(opts.projectName, dependencies, warnings));

    return { files, warnings };
}

function validateOptions(opts) {
    if (!opts || typeof opts !== "object") {
        throw new TypeError("generateRewriteProject options are required");
    }
    for (const key of ["inputPath", "parsed", "outDir", "projectName"]) {
        if (opts[key] === undefined || opts[key] === null) {
            throw new TypeError(`generateRewriteProject option is required: ${key}`);
        }
    }
}

function readNodeImplementations() {
    if (!fs.existsSync(NODES_SOURCE)) {
        return new Map();
    }
    const implementations = new Map();
    const entries = fs.readdirSync(NODES_SOURCE, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const sourcePath = path.join(NODES_SOURCE, entry.name);
        const implementation = require(sourcePath);
        if (!implementation || typeof implementation.type !== "string" ||
            typeof implementation.register !== "function") {
            throw new Error(`Invalid rewrite node implementation: ${entry.name}`);
        }
        if (implementations.has(implementation.type)) {
            throw new Error(`Duplicate rewrite node implementation for type "${implementation.type}"`);
        }
        implementations.set(implementation.type, {
            fileName: entry.name,
            sourcePath,
            requires: Array.isArray(implementation.requires) ? implementation.requires : []
        });
    }
    return implementations;
}

function getSupportedNodeTypes() {
    return [...readNodeImplementations().keys()].sort();
}

function getUnsupportedNodeTypes(parsed) {
    const supported = new Set(getSupportedNodeTypes());
    return [...new Set(collectFlowNodes(parsed).map(node => node.type)
        .filter(type => !supported.has(type)))].sort();
}

function collectFlowNodes(parsed) {
    const nodes = [];
    for (const tab of parsed.tabs || []) {
        for (const node of tab.nodes || []) {
            if (node && node.type) {
                nodes.push(node);
            }
        }
    }
    return nodes;
}

function makeDependencies(usedTypes, implementations) {
    const names = new Set();
    for (const type of usedTypes) {
        for (const name of implementations.get(type).requires) {
            if (typeof name === "string" && name.trim()) {
                names.add(name.trim());
            }
        }
    }
    const dependencies = {};
    for (const name of [...names].sort()) {
        dependencies[name] = DEFAULT_VERSIONS[name] || "latest";
    }
    return dependencies;
}

function makePackageJson(projectName, dependencies) {
    return {
        name: projectName,
        version: "1.0.0",
        private: true,
        scripts: { start: "node index.js" },
        dependencies
    };
}

function makeIndex(parsed, usedTypes, implementations) {
    const registrations = usedTypes.map(type => {
        const file = implementations.get(type).fileName.slice(0, -3);
        return `require(${JSON.stringify(`./lib/nodes/${file}`)}).register(runtime);`;
    });
    const usedSlugs = new Set();
    const flows = (parsed.tabs || []).map(tab => {
        const slug = uniqueSlug(tab.label, tab.id, usedSlugs, "flow");
        return `require(${JSON.stringify(`./flows/${slug}`)})(runtime.flow(${JSON.stringify(tab.id)}, ${JSON.stringify({
            label: tab.label || "",
            env: tab.env || []
        }, null, 4)}));`;
    });

    return `const settings = require("./settings");
const { createRuntime } = require("./lib/runtime");

const runtime = createRuntime({ settings });

// ---- 节点实现 ----
${registrations.join("\n")}

// ---- flows ----
${flows.join("\n")}

runtime.start().then(() => {
    console.log("Flows started.");
}).catch(err => { console.error(err); process.exit(1); });

const shutdown = () => runtime.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
}

function makeSettings() {
    return `module.exports = {
    uiPort: parseInt(process.env.PORT || "1880", 10),
    uiHost: "0.0.0.0",
    functionGlobalContext: {},
    logging: { console: { level: "info" } }
};
`;
}

function makeFlowFile(tab) {
    const nodes = tab.nodes || [];
    const disabledIds = new Set(nodes.filter(node => node && node.d === true).map(node => node.id));
    const lines = [
        `// Flow: ${tab.label || ""} (id: ${tab.id})`,
        "module.exports = flow => {"
    ];

    for (const node of nodes) {
        if (!node || !node.id || !node.type) {
            continue;
        }
        lines.push(...makeAddLines(node));
    }
    for (const node of nodes) {
        if (!node || !node.id || !Array.isArray(node.wires)) {
            continue;
        }
        node.wires.forEach((destinations, port) => {
            if (!Array.isArray(destinations)) {
                return;
            }
            for (const destination of destinations) {
                if (!destination) {
                    continue;
                }
                lines.push(`    // ${node.id}[${port}] -> ${destination}`);
                const disabled = node.d === true || disabledIds.has(destination);
                const wire = `flow.wire(${JSON.stringify(node.id)}, ${port}, ${JSON.stringify(destination)});`;
                lines.push(disabled ? `    // DISABLED: ${wire}` : `    ${wire}`);
            }
        });
    }
    lines.push("};", "");
    return `${lines.join("\n")}\n`;
}

function makeAddLines(node) {
    const config = withoutNodeRuntimeFields(node);
    const disabledPrefix = node.d === true ? "    // DISABLED: " : "    ";
    const rendered = renderConfig(config);
    const lines = rendered.map((line, index) => {
        if (index === 0) {
            return `${disabledPrefix}flow.add(${JSON.stringify(node.type)}, ${line}`;
        }
        return `${disabledPrefix}${line}`;
    });
    lines[lines.length - 1] += ");";
    return lines;
}

function renderConfig(config) {
    const functionBody = typeof config.func === "string" ? config.func : null;
    if (functionBody === null) {
        return JSON.stringify(config, null, 4).split("\n");
    }

    const rest = { ...config };
    delete rest.func;
    const jsonLines = JSON.stringify(rest, null, 4).split("\n");
    const closing = jsonLines.pop();
    if (jsonLines.length > 1) {
        jsonLines[jsonLines.length - 1] += ",";
    }
    jsonLines.push("    func(msg, { node, context, flow, global, send, done, env }) {");
    const body = indentFunctionBody(functionBody);
    if (body.length > 0) {
        jsonLines.push(...body.map(line => `        ${line}`));
    }
    jsonLines.push("    }");
    jsonLines.push(closing);
    return jsonLines;
}

function indentFunctionBody(source) {
    const lines = String(source).split("\n");
    const nonEmpty = lines.filter(line => line.trim());
    const minimumIndent = nonEmpty.length === 0
        ? 0
        : Math.min(...nonEmpty.map(line => (line.match(/^\s*/) || [""])[0].length));
    return lines.map(line => line.slice(Math.min(minimumIndent, line.length)).replace(/\s+$/, ""));
}

function withoutNodeRuntimeFields(node) {
    const config = { ...node };
    for (const key of ["type", "z", "wires", "x", "y"]) {
        delete config[key];
    }
    return config;
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

function makeReadme(projectName, dependencies, warnings) {
    const dependencyRows = Object.keys(dependencies).sort()
        .map(name => `| ${name} | ${dependencies[name]} |`).join("\n");
    const warningRows = warnings.length > 0
        ? warnings.map(warning => `- ${warning}`).join("\n")
        : "- None";
    return `# ${projectName}

This project was translated from a Node-RED flow into hand-written-style JavaScript.
It uses a small message runtime and has no Node-RED runtime dependency.

## Usage

Install and start it with:

    npm install && npm start

Node implementations are in lib/nodes/ and can be edited directly.

## Dependencies

| Package | Version |
| --- | --- |
${dependencyRows || "| (none) | |"}

## Warnings

${warningRows}
`;
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

module.exports = {
    generateRewriteProject,
    getSupportedNodeTypes,
    getUnsupportedNodeTypes
};
