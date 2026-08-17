/**
 * Node package loader for the standalone runtime.
 *
 * Node packages are loaded by requiring their node JS files with the RED
 * facade. For contrib packages the file list comes from the package.json
 * "node-red".nodes manifest. For @node-red/nodes (which has no manifest)
 * the core/[0-9]*.js files are scanned.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function listCoreNodeFiles(nodesDir) {
    const files = [];
    const coreDir = path.join(nodesDir, "core");
    if (!fs.existsSync(coreDir)) { return files; }
    for (const sub of fs.readdirSync(coreDir)) {
        const subDir = path.join(coreDir, sub);
        if (!fs.statSync(subDir).isDirectory()) { continue; }
        for (const f of fs.readdirSync(subDir)) {
            if (/^[0-9].*\.js$/.test(f)) { files.push(path.join(subDir, f)); }
        }
    }
    return files;
}

function listManifestNodeFiles(pkgDir, pkg) {
    const nr = pkg["node-red"];
    if (!nr || !nr.nodes) { return []; }
    return Object.values(nr.nodes).map(f => path.join(pkgDir, f));
}

/**
 * Load all node JS files of an npm package into the runtime.
 * @returns {{ package: string, types: string[], warnings: string[] }}
 */
function loadPackage(runtime, pkgRef, baseDir) {
    const warnings = [];
    let pkgJsonPath;
    try {
        pkgJsonPath = require.resolve(pkgRef + "/package.json", { paths: [baseDir || process.cwd()] });
    } catch (err) {
        warnings.push(`Cannot resolve package "${pkgRef}": ${err.message}`);
        return { package: pkgRef, types: [], warnings };
    }
    const pkgDir = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

    let files;
    if (pkg.name === "@node-red/nodes") {
        files = listCoreNodeFiles(pkgDir);
    } else {
        files = listManifestNodeFiles(pkgDir, pkg);
        if (files.length === 0) {
            warnings.push(`Package "${pkgRef}" has no node-red.nodes manifest`);
        }
    }

    const types = new Set();
    for (const file of files) {
        let mod;
        try {
            mod = require(file);
        } catch (err) {
            warnings.push(`Failed to require ${path.relative(pkgDir, file)}: ${err.message}`);
            continue;
        }
        if (typeof mod !== "function") { continue; }
        const before = runtime.registeredTypes();
        try {
            mod(runtime.RED);
        } catch (err) {
            warnings.push(`Failed to initialise ${path.relative(pkgDir, file)}: ${err.message}`);
            continue;
        }
        for (const t of runtime.registeredTypes()) {
            if (!before.includes(t)) { types.add(t); }
        }
    }
    return { package: pkg.name || pkgRef, version: pkg.version, types: [...types], warnings };
}

module.exports = { loadPackage };
