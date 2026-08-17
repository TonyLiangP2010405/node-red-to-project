#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { parseArgs } = require("node:util");

const { parseFlowFile } = require("../src/parse");
const { expandSubflows } = require("../src/subflow");
const { inferDependencies } = require("../src/deps");
const { generateProject } = require("../src/gen");
const { startServer } = require("../src/web/server");

const HELP = `Usage: node-red-to-project <flows.json> [options]
       node-red-to-project --serve [--port <port>]

Options:
  -o, --output <dir>   Output directory (default: ./<input>-app)
      --name <name>   Generated project name
      --user-dir <dir> Node-RED user directory (default: ~/.node-red)
      --yes            Accept all dependency suggestions without prompting
      --force          Overwrite a non-empty output directory
      --serve          Start the Web UI instead of converting a file
      --port <port>    Web UI port (default: 8321)
  -h, --help           Show this help
`;

async function main(argv = process.argv.slice(2)) {
    let parsedArgs;
    try {
        parsedArgs = parseArgs({
            args: argv,
            options: {
                output: { type: "string", short: "o" },
                name: { type: "string" },
                "user-dir": { type: "string" },
                yes: { type: "boolean" },
                force: { type: "boolean" },
                serve: { type: "boolean" },
                port: { type: "string" },
                help: { type: "boolean", short: "h" }
            },
            allowPositionals: true,
            strict: true
        });
    } catch (error) {
        throw new Error(`${error.message}\n\n${HELP}`);
    }

    if (parsedArgs.values.help) {
        process.stdout.write(HELP);
        return;
    }
    if (parsedArgs.values.serve) {
        if (parsedArgs.positionals.length !== 0) {
            throw new Error(`--serve does not accept a flows.json path; use --port to choose a port.\n\n${HELP}`);
        }
        const port = parseWebPort(parsedArgs.values.port || "8321");
        const server = startServer({ port });
        server.once("listening", () => {
            const address = server.address();
            const actualPort = address && typeof address === "object" ? address.port : port;
            process.stdout.write(`Web UI listening on http://localhost:${actualPort}\n`);
        });
        return;
    }
    if (parsedArgs.positionals.length !== 1) {
        throw new Error(`Exactly one flows.json path is required.\n\n${HELP}`);
    }

    const inputPath = path.resolve(parsedArgs.positionals[0]);
    const outputPath = path.resolve(parsedArgs.values.output || defaultOutput(inputPath));
    const projectName = parsedArgs.values.name || path.basename(outputPath);
    const userDir = path.resolve(parsedArgs.values["user-dir"] || path.join(os.homedir(), ".node-red"));

    const raw = fs.readFileSync(inputPath, "utf8");
    const input = JSON.parse(raw);
    const parsed = parseFlowFile(input);
    expandSubflows(parsed);
    const types = collectTypes(parsed);
    const inference = inferDependencies(types, { userDir });
    const deps = { ...(inference.deps || {}) };
    const warnings = [...(parsed.warnings || [])];
    const unconfirmedDeps = [];

    if ((inference.unknown || []).length > 0) {
        if (parsedArgs.values.yes) {
            for (const unknown of inference.unknown) {
                acceptSuggestion(unknown, deps, warnings, unconfirmedDeps, true);
            }
        } else {
            await confirmUnknownTypes(inference.unknown, deps, warnings, unconfirmedDeps);
        }
    }

    const result = generateProject({
        inputPath,
        parsed: { ...parsed, warnings },
        deps,
        outDir: outputPath,
        projectName,
        runtimeDir: path.join(__dirname, "..", "src", "runtime"),
        force: Boolean(parsedArgs.values.force),
        resolved: inference.resolved || {},
        unconfirmedDeps
    });

    process.stdout.write(`Generated ${result.files.length} files in ${outputPath}.\n`);
    process.stdout.write("Dependencies:\n");
    for (const [name, version] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
        process.stdout.write(`  ${name}: ${version}\n`);
    }
    if (result.warnings.length > 0) {
        process.stdout.write("Warnings:\n");
        for (const warning of result.warnings) {
            process.stdout.write(`  - ${warning}\n`);
        }
    }
    process.stdout.write("Next: cd into the output directory, then run npm install && npm start.\n");
}

function parseWebPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid Web UI port: ${value}`);
    }
    return port;
}

function defaultOutput(inputPath) {
    const basename = path.basename(inputPath, path.extname(inputPath));
    return `./${basename}-app`;
}

function collectTypes(parsed) {
    const types = new Set();
    const addNodes = nodes => {
        for (const node of nodes || []) {
            if (node && node.type) {
                types.add(node.type);
            }
        }
    };
    for (const tab of parsed.tabs || []) {
        addNodes(tab.nodes);
    }
    addNodes(parsed.globalConfigs);
    for (const subflow of parsed.subflows || []) {
        addNodes(subflow.nodes);
    }
    return [...types];
}

async function confirmUnknownTypes(unknownTypes, deps, warnings, unconfirmedDeps) {
    const input = process.stdin;
    const output = process.stdout;
    const remainingSuggestions = new Map();
    const acceptedSuggestions = new Set();
    for (const unknown of unknownTypes) {
        if (unknown.suggestion) {
            remainingSuggestions.set(
                unknown.suggestion,
                (remainingSuggestions.get(unknown.suggestion) || 0) + 1
            );
        }
    }
    const rl = readline.createInterface({ input, output });
    try {
        for (const unknown of unknownTypes) {
            const suggestion = unknown.suggestion || "";
            const answer = (await rl.question(
                `Unknown node type "${unknown.type}". Suggested package: "${suggestion}". ` +
                `Enter package name, press Enter to accept, or type skip: `
            )).trim();
            const skipping = answer.toLowerCase() === "skip";
            const selected = skipping ? "" : answer || suggestion;
            if (!skipping && selected === suggestion && selected) {
                acceptedSuggestions.add(selected);
            }
            decrementSuggestion(deps, remainingSuggestions, suggestion, acceptedSuggestions);
            if (skipping) {
                warnings.push(`Skipped dependency for unknown node type "${unknown.type}".`);
                continue;
            }
            acceptSuggestion(
                { ...unknown, suggestion: selected },
                deps,
                warnings,
                unconfirmedDeps,
                false
            );
        }
    } finally {
        rl.close();
    }
}

function decrementSuggestion(deps, remainingSuggestions, suggestion, acceptedSuggestions) {
    if (!suggestion || !remainingSuggestions.has(suggestion)) {
        return;
    }
    const remaining = remainingSuggestions.get(suggestion) - 1;
    if (remaining === 0) {
        remainingSuggestions.delete(suggestion);
        if (!acceptedSuggestions.has(suggestion)) {
            delete deps[suggestion];
        }
    } else {
        remainingSuggestions.set(suggestion, remaining);
    }
}

function acceptSuggestion(unknown, deps, warnings, unconfirmedDeps, yesMode) {
    const packageName = unknown.suggestion;
    if (!packageName) {
        warnings.push(`No package suggestion for unknown node type "${unknown.type}"; skipped.`);
        return;
    }
    deps[packageName] = deps[packageName] || "latest";
    unconfirmedDeps.push(packageName);
    const mode = yesMode ? " (--yes)" : "";
    warnings.push(`Unknown node type "${unknown.type}" uses suggested package "${packageName}" without version confirmation${mode}.`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { collectTypes, defaultOutput, main };
