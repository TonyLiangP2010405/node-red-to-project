const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE_TYPES = new Set([
    'batch',
    'catch',
    'change',
    'comment',
    'complete',
    'csv',
    'debug',
    'delay',
    'exec',
    'file',
    'file in',
    'function',
    'global-config',
    'html',
    'http in',
    'http request',
    'http response',
    'inject',
    'join',
    'json',
    'junction',
    'link call',
    'link in',
    'link out',
    'mqtt in',
    'mqtt out',
    'mqtt-broker',
    'range',
    'sort',
    'split',
    'status',
    'switch',
    'tcp in',
    'tcp out',
    'tcp request',
    'template',
    'tls-config',
    'trigger',
    'udp in',
    'udp out',
    'unknown',
    'watch',
    'websocket in',
    'websocket out',
    'websocket-client',
    'websocket-listener',
    'xml',
    'yaml'
]);

const MAX_NODE_FILE_SIZE = 2 * 1024 * 1024;
const REGISTER_TYPE_PATTERN = /registerType\(\s*["']([^"']+)["']/g;

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function scanNodeFile(filePath, packageName, typeToPackage) {
    try {
        if (fs.statSync(filePath).size > MAX_NODE_FILE_SIZE) {
            return;
        }

        const source = fs.readFileSync(filePath, 'utf8');
        REGISTER_TYPE_PATTERN.lastIndex = 0;
        let match;
        while ((match = REGISTER_TYPE_PATTERN.exec(source)) !== null) {
            typeToPackage.set(match[1], packageName);
        }
    } catch {
        // A missing, unreadable, or invalid node file does not block inference.
    }
}

function findLocalTypes(userDir) {
    const typeToPackage = new Map();
    const userPackage = readJson(path.join(userDir, 'package.json'));
    const dependencies = userPackage && userPackage.dependencies;

    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        return typeToPackage;
    }

    for (const packageName of Object.keys(dependencies)) {
        const packageDir = path.join(userDir, 'node_modules', packageName);
        const packageJson = readJson(path.join(packageDir, 'package.json'));
        const nodes = packageJson && packageJson['node-red'] && packageJson['node-red'].nodes;

        if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
            continue;
        }

        const nodeFiles = new Set(Object.values(nodes));
        for (const nodeFile of nodeFiles) {
            if (typeof nodeFile === 'string') {
                scanNodeFile(path.resolve(packageDir, nodeFile), packageName, typeToPackage);
            }
        }
    }

    return typeToPackage;
}

function suggestionFor(type) {
    const slug = type
        .toLowerCase()
        .replace(/[ _]/g, '-')
        .replace(/[^a-z0-9-]/g, '');
    return `node-red-contrib-${slug}`;
}

/**
 * @param {string[]} types - flow 里用到的所有节点 type（含 config 节点 type）
 * @param {{ userDir?: string }} opts - userDir 默认为 ~/.node-red
 * @returns {{
 *   deps: Object<string,string>,
 *   resolved: Object<string,string>,
 *   unknown: Array<{ type: string, suggestion: string }>
 * }}
 */
function inferDependencies(types, opts = {}) {
    const userDir = opts.userDir || path.join(os.homedir(), '.node-red');
    const typeToPackage = findLocalTypes(userDir);
    const deps = {};
    const resolved = {};
    const unknown = [];
    const unresolved = [];
    const uniqueTypes = [...new Set(types)];

    for (const type of uniqueTypes) {
        if (CORE_TYPES.has(type)) {
            resolved[type] = '@node-red/nodes';
            deps['@node-red/nodes'] = '^5.0.0';
        } else if (typeToPackage.has(type)) {
            const packageName = typeToPackage.get(type);
            resolved[type] = packageName;
            deps[packageName] = readDependencyVersion(userDir, packageName);
        } else {
            const suggestion = suggestionFor(type);
            unknown.push({ type, suggestion });
            unresolved.push(suggestion);
        }
    }

    for (const packageName of unresolved) {
        if (deps[packageName] === undefined) {
            deps[packageName] = 'latest';
        }
    }

    return { deps, resolved, unknown };
}

function readDependencyVersion(userDir, packageName) {
    const userPackage = readJson(path.join(userDir, 'package.json'));
    const dependencies = userPackage && userPackage.dependencies;
    const version = dependencies && dependencies[packageName];
    return typeof version === 'string' ? version : 'latest';
}

module.exports = { inferDependencies, CORE_TYPES };
