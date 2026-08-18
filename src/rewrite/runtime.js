/**
 * Mini flow runtime for rewrite-mode generated projects.
 *
 * Hand-written, zero-dependency message router with Node-RED semantics:
 *  - wires: send(msg) routes per output index; multiple recipients get clones
 *    except the first; _msgid is auto-assigned
 *  - async delivery (setImmediate), matching Node-RED defaults
 *  - node context / flow context / global context (in-memory)
 *  - link out "links" are converted to wires when the flow is built
 *  - "$(VAR)" whole-string substitution in configs: flow env -> process.env
 */
"use strict";

const crypto = require("crypto");

function generateId() {
    return crypto.randomBytes(8).toString("hex");
}

function cloneMessage(msg) {
    if (msg === null || typeof msg !== "object") { return msg; }
    if (Buffer.isBuffer(msg)) { return Buffer.from(msg); }
    if (Array.isArray(msg)) { return msg.map(cloneMessage); }
    const out = {};
    for (const k of Object.keys(msg)) { out[k] = cloneMessage(msg[k]); }
    return out;
}

function getProp(obj, path) {
    return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setProp(obj, path, value) {
    const keys = String(path).split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (typeof o[keys[i]] !== "object" || o[keys[i]] === null) { o[keys[i]] = {}; }
        o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
}

function makeStore() {
    const data = new Map();
    const wrap = (fn) => (key, value, callback) => {
        if (typeof value === "function") { callback = value; value = undefined; }
        const run = () => fn(key, value);
        if (callback) { setImmediate(() => callback(null, run())); return; }
        return run();
    };
    return {
        get: wrap(key => (Array.isArray(key) ? key.map(k => cloneMessage(data.get(k))) : cloneMessage(data.get(key)))),
        set: wrap((key, value) => {
            if (Array.isArray(key)) { key.forEach((k, i) => data.set(k, cloneMessage((value || [])[i]))); }
            else if (value === undefined) { data.delete(key); }
            else { data.set(key, cloneMessage(value)); }
        }),
        keys: wrap(() => [...data.keys()])
    };
}

function makeContext(nodeStore, flowStore, globalStore) {
    const ctx = makeStore();
    ctx.get = nodeStore.get; ctx.set = nodeStore.set; ctx.keys = nodeStore.keys;
    ctx.flow = flowStore; ctx.global = globalStore;
    return ctx;
}

const ENV_RE = /^\$\((\S+)\)$/;

function substituteEnv(value, flowEnv) {
    if (typeof value === "string") {
        const m = ENV_RE.exec(value);
        if (m) {
            const name = m[1];
            if (flowEnv && Object.prototype.hasOwnProperty.call(flowEnv, name)) { return flowEnv[name]; }
            return process.env[name];
        }
        return value;
    }
    if (Array.isArray(value)) { return value.map(v => substituteEnv(v, flowEnv)); }
    if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value)) { out[k] = substituteEnv(value[k], flowEnv); }
        return out;
    }
    return value;
}

function createRuntime(options) {
    options = options || {};
    const settings = options.settings || {};
    const factories = new Map();
    const flows = new Map();
    const nodeIndex = new Map();  // node id -> api object (across flows)
    const globalStore = makeStore();
    let expressApp = null;
    let server = null;
    let routeCount = 0;

    const log = {
        info: m => console.log(`[info] ${m}`),
        warn: m => console.warn(`[warn] ${m}`),
        error: m => console.error(`[error] ${m && m.stack ? m.stack : m}`),
        debug: m => { if (settings.debug) { console.log(`[debug] ${m}`); } },
        trace: m => { if (settings.debug) { console.log(`[trace] ${m}`); } }
    };

    function httpApp() {
        if (!expressApp) {
            let express;
            try { express = require("express"); }
            catch (err) {
                throw new Error('This flow uses http nodes: run "npm install express" in the generated project');
            }
            expressApp = express();
            expressApp.disable("x-powered-by");
            expressApp.use(express.json({ limit: settings.maxHttpBodySize || "5mb" }));
            expressApp.use(express.urlencoded({ extended: true, limit: settings.maxHttpBodySize || "5mb" }));
            expressApp.use(express.text({ type: ["text/*"], limit: settings.maxHttpBodySize || "5mb" }));
            expressApp.use(express.raw({ type: ["application/octet-stream"], limit: settings.maxHttpBodySize || "5mb" }));
        }
        return expressApp;
    }

    function makeNodeApi(flowState, config, type) {
        const flowStore = flowState.store;
        const nodeStore = makeStore();
        const closeHandlers = [];
        const wires = flowState.wires[config.id] || [];
        const node = {
            id: config.id,
            name: config.name,
            type,
            log: m => log.info(`[${type}${config.name ? ":" + config.name : ""}] ${format(m)}`),
            warn: m => log.warn(`[${type}${config.name ? ":" + config.name : ""}] ${format(m)}`),
            error: (m, msg) => log.error(`[${type}${config.name ? ":" + config.name : ""}] ${format(m)}`),
            debug: m => log.debug(`[${type}] ${format(m)}`),
            trace: m => log.trace(`[${type}] ${format(m)}`),
            status: s => log.debug(`[${type}] status: ${format(s && s.text !== undefined ? s.text : s)}`),
            context: () => makeContext(nodeStore, flowStore, globalStore),
            http: httpApp,
            onClose: fn => closeHandlers.push(fn),
            _closeHandlers: closeHandlers,
            send(msg) {
                routeSend(node, wires, msg);
            }
        };
        return node;
    }

    function format(m) {
        if (m === undefined) { return "undefined"; }
        if (typeof m === "string") { return m; }
        if (m instanceof Error) { return m.stack || m.message; }
        try { return JSON.stringify(m); } catch (err) { return "" + m; }
    }

    function deliver(nodeId, msg) {
        const target = nodeIndex.get(nodeId);
        if (!target || !target.handlers || !target.handlers.input) { return; }
        setImmediate(() => {
            const send = m => target.api.send(m);
            const done = err => { if (err) { target.api.error(err, msg); } };
            try {
                target.handlers.input.call(target.api, msg, send, done);
            } catch (err) {
                target.api.error(err, msg);
            }
        });
    }

    function routeSend(node, wires, msg) {
        if (msg === null || msg === undefined) { return; }
        if (!Array.isArray(msg)) { msg = [msg]; }
        let msgSent = false;
        const events = [];
        for (let port = 0; port < wires.length; port++) {
            if (port >= msg.length) { break; }
            let msgs = msg[port];
            if (msgs === null || msgs === undefined) { continue; }
            if (!Array.isArray(msgs)) { msgs = [msgs]; }
            for (const targetId of wires[port]) {
                for (const m of msgs) {
                    if (m === null || m === undefined) { continue; }
                    if (typeof m !== "object") {
                        node.error("Non-message returned: " + typeof m);
                        continue;
                    }
                    events.push({ targetId, msg: m, clone: msgSent });
                    msgSent = true;
                }
            }
        }
        for (const ev of events) {
            const out = ev.clone ? cloneMessage(ev.msg) : ev.msg;
            if (!out._msgid) { out._msgid = generateId(); }
            deliver(ev.targetId, out);
        }
    }

    const runtime = {
        settings,
        log,
        registerNode(type, factory) { factories.set(type, factory); },
        flow(id, meta) {
            meta = meta || {};
            const flowState = {
                id,
                env: evaluateEnv(meta.env),
                store: makeStore(),
                defs: [],
                wires: {}
            };
            const builder = {
                id,
                add(type, config) {
                    config = config || {};
                    if (!config.id) { throw new Error(`node of type "${type}" in flow ${id} is missing an id`); }
                    flowState.defs.push({ type, config });
                    return config.id;
                },
                wire(fromId, port, toId) {
                    const w = flowState.wires[fromId] = flowState.wires[fromId] || [];
                    while (w.length <= port) { w.push([]); }
                    w[port].push(toId);
                }
            };
            flows.set(id, flowState);
            return builder;
        },
        async start() {
            // link out "links" become wires (Node-RED does the same at flow build time)
            for (const flowState of flows.values()) {
                const linkWires = {};
                for (const { type, config } of flowState.defs) {
                    if (type === "link in" && Array.isArray(config.links)) {
                        config.links.forEach(id => { (linkWires[id] = linkWires[id] || new Set()).add(config.id); });
                    } else if (type === "link out" && Array.isArray(config.links)) {
                        config.links.forEach(id => { (linkWires[config.id] = linkWires[config.id] || new Set()).add(id); });
                    }
                }
                for (const [fromId, targets] of Object.entries(linkWires)) {
                    if (flowState.defs.some(d => d.config.id === fromId && d.type === "link out") && !flowState.wires[fromId]) {
                        flowState.wires[fromId] = [[...targets]];
                    }
                }
            }
            for (const flowState of flows.values()) {
                for (const { type, config } of flowState.defs) {
                    if (config.d === true) { continue; } // disabled
                    const factory = factories.get(type);
                    if (!factory) {
                        throw new Error(`No implementation registered for node type "${type}" (node ${config.id})`);
                    }
                    const conf = substituteEnv(config, flowState.env);
                    const api = makeNodeApi(flowState, conf, type);
                    const handlers = factory(api, conf) || {};
                    nodeIndex.set(conf.id, { api, handlers, flowId: flowState.id });
                }
            }
            if (routeCount > 0 || expressApp) {
                const http = require("http");
                server = http.createServer(expressApp);
                const port = settings.uiPort || 1880;
                const host = settings.uiHost || "0.0.0.0";
                await new Promise(resolve => server.listen(port, host, resolve));
                log.info(`listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
            }
        },
        async stop() {
            for (const entry of nodeIndex.values()) {
                for (const fn of entry.api._closeHandlers) {
                    try { await fn.call(entry.api); } catch (err) { log.error(err); }
                }
            }
            if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
        },
        // used by node implementations (http in)
        _registerRoute() { routeCount++; },
        _getProp: getProp,
        _setProp: setProp,
        _cloneMessage: cloneMessage,
        _generateId: generateId
    };
    return runtime;
}

function evaluateEnv(envDefs) {
    const out = {};
    for (const def of envDefs || []) {
        let { name, value, type } = def;
        try {
            if (type === "num") { value = parseFloat(value); }
            else if (type === "bool") { value = (value === "true") || (value === true); }
            else if (type === "json") { value = JSON.parse(value); }
            else if (type === "env") { value = process.env[value]; }
        } catch (err) { value = undefined; }
        out[name] = value;
    }
    return out;
}

module.exports = { createRuntime, cloneMessage, getProp, setProp };
