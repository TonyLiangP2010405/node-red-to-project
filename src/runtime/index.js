/**
 * Standalone Node-RED-compatible runtime (the "RED facade").
 *
 * createRuntime({ settings, userDir }) returns a runtime that can load real
 * Node-RED node packages (@node-red/nodes and node-red-contrib-*) and run
 * flows without the Node-RED editor or full runtime.
 */
"use strict";

const EventEmitter = require("events");
const express = require("express");
const redUtil = require("@node-red/util").util;

const Log = require("./log");
const Node = require("./node");
const { Flow } = require("./flow");
const { createContextManager } = require("./context");
const { Credentials } = require("./credentials");
const loader = require("./loader");
const env = require("./env");

const DEFAULT_SETTINGS = {
    httpNodeRoot: "/",
    httpAdminRoot: false,
    debugMaxLength: 1000,
    debugStatusLength: 32,
    debugUseColors: false,
    functionTimeout: 0,
    functionGlobalContext: {},
    httpRequestTimeout: 120000,
    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    socketTimeout: 120000,
    tcpMsgQueueSize: 1000,
    inboundMessageBufferSize: 0,
    tlsConfigDisableLocalFiles: false,
    logging: { console: { level: "info" } }
};

function createRuntime(options) {
    options = options || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const userDir = options.userDir || process.cwd();

    if (settings.logging && settings.logging.console && settings.logging.console.level) {
        Log.setLevel(settings.logging.console.level);
    }

    // ---- registry -----------------------------------------------------------
    const typeRegistry = new Map();   // type -> { ctor, credentials }
    const nodesById = new Map();      // id -> node instance (all flows)
    const warnedApi = new Set();      // one warning per stubbed API

    const contexts = createContextManager();
    const credentials = new Credentials();

    function warnOnce(key, message) {
        if (!warnedApi.has(key)) {
            warnedApi.add(key);
            Log.warn(message);
        }
    }

    // ---- RED facade ---------------------------------------------------------
    const events = new EventEmitter();
    events.setMaxListeners(0);

    const httpNode = express();
    httpNode.disable("x-powered-off");
    const httpAdmin = express.Router();
    httpAdmin.use((req, res) => {
        warnOnce("httpAdmin", `A node tried to use the editor-only RED.httpAdmin API (${req.method} ${req.path}); the request will 404`);
        res.status(404).end();
    });

    const comms = {
        publish(topic, data /*, retained */) {
            if (topic === "debug" && data) {
                const text = typeof data.msg === "string" ? data.msg : safeStringify(data.msg);
                Log.log({ level: Log.INFO, id: data.id, type: "debug", name: data.name, msg: text });
            }
            events.emit("comms:" + topic, data);
        }
    };

    const RED = {
        _: (id, opts) => {
            if (opts && typeof opts.defaultValue === "string") {
                // cheap template fill for ${param} placeholders
                return opts.defaultValue.replace(/\$\{(\w+)\}/g, (m, k) => (opts[k] !== undefined ? opts[k] : m));
            }
            return id;
        },
        util: redUtil,
        log: Log,
        settings,
        events,
        comms,
        httpNode,
        httpAdmin,
        server: null, // set via runtime.attachServer() before start()
        auth: {
            needsPermission() {
                return (req, res, next) => next();
            }
        },
        hooks: {
            has: () => false,
            trigger: (name, payload, done) => { if (done) { done(false); } },
            add: () => {},
            remove: () => {}
        },
        plugins: {
            get: () => undefined,
            getByType: () => [],
            registerPlugin: () => {},
            init: () => {}
        },
        library: {
            register: () => {},
            getAll: () => [],
            resolve: () => { throw new Error("library API is not available in the standalone runtime"); }
        },
        nodes: {
            registerType(type, ctor, opts) {
                if (typeRegistry.has(type)) {
                    Log.warn(`Node type "${type}" registered more than once; the later registration wins`);
                }
                // The Node base class methods are provided via the prototype
                // chain, exactly like the official runtime does.
                require("util").inherits(ctor, Node);
                typeRegistry.set(type, { ctor, credentials: (opts && opts.credentials) || null });
            },
            registerSubflow() {
                warnOnce("subflow", "registerSubflow called: subflows are statically expanded by the generator, this call was ignored");
            },
            getType(type) {
                const entry = typeRegistry.get(type);
                return entry && entry.ctor;
            },
            // Called by node constructors: RED.nodes.createNode(this, def)
            createNode(node, def) {
                Node.call(node, def);
                const creds = credentials.get(def.id);
                if (creds) {
                    const cloned = redUtil.cloneMessage({ v: creds }).v;
                    // allow $(VAR) substitution inside credential values too
                    env.substituteEnvVars(cloned, node._flow || globalFlow);
                    node.credentials = cloned;
                } else {
                    const entry = typeRegistry.get(node.type);
                    if (entry && entry.credentials) { node.credentials = {}; }
                }
            },
            getNode(id) {
                return nodesById.get(id);
            },
            eachNode(cb) {
                for (const n of nodesById.values()) { cb(n); }
            },
            linkcallTargets: (function () {
                const byId = new Map();
                const byName = new Map();
                function target(node) {
                    return { id: node.id, name: node.name || node.id, node };
                }
                return {
                    register(node) {
                        const t = target(node);
                        byId.set(node.id, t);
                        const name = node.name || node.id;
                        if (!byName.has(name)) { byName.set(name, []); }
                        byName.get(name).push(t);
                    },
                    remove(node) {
                        byId.delete(node.id);
                        const name = node.name || node.id;
                        const list = byName.get(name) || [];
                        const i = list.findIndex(t => t.id === node.id);
                        if (i > -1) { list.splice(i, 1); }
                    },
                    getTargets(name) { return byName.get(name) || []; },
                    getTargetNode(node, targetId) {
                        const t = byId.get(targetId);
                        if (!t) { throw new Error("link call: no such target " + targetId); }
                        return t.node;
                    }
                };
            })()
        }
    };

    // ---- runtime ------------------------------------------------------------
    const flows = new Map(); // id -> Flow
    let globalFlow = null;

    const runtime = {
        RED,
        settings,
        contexts,
        credentials,
        httpNode,
        events,
        log: Log,

        registeredTypes() { return [...typeRegistry.keys()]; },

        loadPackage(pkgRef, baseDir) {
            return loader.loadPackage(runtime, pkgRef, baseDir || userDir);
        },

        attachServer(server) {
            RED.server = server;
        },

        /** Replace the global config-node definitions before start(). */
        setGlobalConfigs(configs) {
            globalFlow.flow.configs = configs || {};
        },

        /** Register a flow definition { id, label, env, nodes: {id: def} }. */
        addFlow(def) {
            const processed = applyLinkWires(def);
            const flow = new Flow(runtime, processed, globalFlow);
            flows.set(flow.id, flow);
            return flow;
        },

        getFlow(id) { return flows.get(id); },

        /** Instantiate a node from a definition, resolving its type. */
        async createNode(flow, def) {
            const entry = typeRegistry.get(def.type);
            if (!entry) {
                flow.warn(`Unknown node type "${def.type}" (node ${def.id}); skipped. ` +
                          `Install the package that provides it in package.json.`);
                return null;
            }
            // Work on a copy: env substitution rewrites values
            const conf = redUtil.cloneMessage({ v: def }).v;
            env.substituteEnvVars(conf, flow);
            conf._flow = flow;
            try {
                const node = new entry.ctor(conf);
                nodesById.set(node.id, node);
                if (node.type && node.type.indexOf("config") === -1) {
                    // config-node users bookkeeping used by handleError on global flow
                }
                return node;
            } catch (err) {
                flow.error(`Failed to create node ${def.id} (${def.type}): ${err.stack || err}`);
                return null;
            }
        },

        getNode(id) { return nodesById.get(id); },

        async start() {
            credentials.load(userDir, settings.credentialSecret, Log);
            const loadWarnings = [];
            await globalFlow.start();
            for (const flow of flows.values()) {
                if (flow.flow.disabled) { continue; }
                await flow.start();
            }
            return { warnings: loadWarnings };
        },

        async stop() {
            for (const flow of flows.values()) {
                await flow.stop();
            }
            await globalFlow.stop();
        }
    };

    // Node base class needs the contexts manager; stash on flows via constructor
    // (Flow already receives runtime and reads runtime.contexts).

    globalFlow = new Flow(runtime, { id: "global", configs: {} }, null);

    return runtime;
}

function safeStringify(v) {
    try { return JSON.stringify(v); } catch (err) { return "" + v; }
}

/**
 * Convert link in / link out `links` properties into wires, mirroring
 * @node-red/runtime flows/util.js: a link out node ends up with
 * wires = [ union of its own links and every link in that lists it ].
 * Returns a copy; the caller's def is not mutated.
 */
function applyLinkWires(def) {
    const nodes = def.nodes || {};
    const linkWires = {};
    let hasLinks = false;
    for (const n of Object.values(nodes)) {
        if (n.type === "link in" && Array.isArray(n.links)) {
            hasLinks = true;
            n.links.forEach(id => {
                linkWires[id] = linkWires[id] || {};
                linkWires[id][n.id] = true;
            });
        } else if (n.type === "link out" && Array.isArray(n.links)) {
            hasLinks = true;
            linkWires[n.id] = linkWires[n.id] || {};
            n.links.forEach(id => { linkWires[n.id][id] = true; });
        }
    }
    if (!hasLinks) { return def; }
    const out = Object.assign({}, def, { nodes: Object.assign({}, nodes) });
    for (const n of Object.values(out.nodes)) {
        if (n.type === "link out" && linkWires[n.id]) {
            out.nodes[n.id] = Object.assign({}, n, { wires: [Object.keys(linkWires[n.id])] });
        }
    }
    return out;
}

module.exports = { createRuntime, DEFAULT_SETTINGS, Log };
