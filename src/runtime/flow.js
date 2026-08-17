/**
 * Flow for the standalone runtime.
 *
 * Adapted from @node-red/runtime lib/flows/Flow.js (Apache-2.0,
 * Copyright JS Foundation and other contributors, http://js.foundation),
 * simplified: no groups, no diff/deploy, no subflow instances
 * (subflows are statically expanded by the generator).
 */
"use strict";

const redUtil = require("@node-red/util").util;
const Log = require("./log");
const env = require("./env");

class Flow {
    constructor(runtime, def, parent) {
        this.TYPE = "flow";
        this.runtime = runtime;
        this.parent = parent || null;
        this.flow = def || { id: "global", configs: {} };
        this.isGlobalFlow = !parent;
        this.id = this.flow.id || "global";
        this.activeNodes = {};
        this.catchNodes = [];
        this.statusNodes = [];
        this.completeNodeMap = {};
        this.contexts = runtime.contexts;
        this._env = {};
        this.path = this.id;
    }

    log(msg) {
        if (!msg.path) { msg.path = this.path; }
        Log.log(msg);
    }
    debug(msg) { this.log({ id: this.id, level: Log.DEBUG, type: this.TYPE, msg }); }
    info(msg) { this.log({ id: this.id, level: Log.INFO, type: this.TYPE, msg }); }
    warn(msg) { this.log({ id: this.id, level: Log.WARN, type: this.TYPE, msg }); }
    error(msg) { this.log({ id: this.id, level: Log.ERROR, type: this.TYPE, msg }); }
    trace(msg) { this.log({ id: this.id, level: Log.TRACE, type: this.TYPE, msg }); }

    getSetting(name) {
        if (Object.prototype.hasOwnProperty.call(this._env, name)) {
            return this._env[name];
        }
        if (this.parent) { return this.parent.getSetting(name); }
        return process.env[name];
    }

    getContext(scope) {
        if (scope === "flow") { return this.contexts.getFlowContext(this.id); }
        return this.contexts.global;
    }

    getNode(id) {
        return this.activeNodes[id] || this.runtime.getNode(id);
    }

    async start() {
        // Evaluate flow-level env. Global flow also reads global-config nodes.
        if (this.isGlobalFlow) {
            const configs = this.flow.configs || {};
            for (const id of Object.keys(configs)) {
                const node = configs[id];
                if (node.type === "global-config" && node.env) {
                    const globalCreds = this.runtime.credentials.get(node.id) || {};
                    Object.assign(this._env, env.evaluateEnvProperties(this, node.env, globalCreds));
                }
            }
        }
        if (this.flow.env) {
            const creds = this.runtime.credentials.get(this.id) || {};
            Object.assign(this._env, env.evaluateEnvProperties(this, this.flow.env, creds));
        }

        this.catchNodes = [];
        this.statusNodes = [];
        this.completeNodeMap = {};

        // Config nodes first, honouring references between them.
        const pending = Object.keys(this.flow.configs || {});
        const attempts = {};
        while (pending.length > 0) {
            const id = pending.shift();
            const def = this.flow.configs[id];
            if (this.activeNodes[id]) { continue; }
            if (def.d === true) { continue; }
            let ready = true;
            for (const prop of Object.keys(def)) {
                if (["id", "wires", "_users"].includes(prop)) { continue; }
                const ref = def[prop];
                if (typeof ref === "string" && this.flow.configs[ref] &&
                    this.flow.configs[ref].d !== true && !this.activeNodes[ref]) {
                    attempts[id] = (attempts[id] || 0) + 1;
                    if (attempts[id] === 100) {
                        throw new Error("Circular config node dependency detected: " + id);
                    }
                    pending.push(id);
                    ready = false;
                    break;
                }
            }
            if (ready) {
                const node = await this.runtime.createNode(this, def);
                if (node) { this.activeNodes[id] = node; }
            }
        }

        for (const id of Object.keys(this.flow.nodes || {})) {
            const def = this.flow.nodes[id];
            if (def.d === true) {
                this.debug("not starting disabled node: " + id);
                continue;
            }
            if (this.activeNodes[id]) { continue; }
            const node = await this.runtime.createNode(this, def);
            if (node) { this.activeNodes[id] = node; }
        }

        for (const id of Object.keys(this.activeNodes)) {
            const node = this.activeNodes[id];
            if (node.type === "catch") {
                this.catchNodes.push(node);
            } else if (node.type === "status") {
                this.statusNodes.push(node);
            } else if (node.type === "complete") {
                (node.scope || []).forEach(scopeId => {
                    this.completeNodeMap[scopeId] = this.completeNodeMap[scopeId] || [];
                    this.completeNodeMap[scopeId].push(node);
                });
            }
        }
        this.catchNodes.sort((A, B) => {
            if (A.scope && !B.scope) { return -1; }
            if (!A.scope && B.scope) { return 1; }
            if (A.scope && B.scope) { return 0; }
            if (A.uncaught && !B.uncaught) { return 1; }
            if (!A.uncaught && B.uncaught) { return -1; }
            return 0;
        });
    }

    async stop() {
        const ids = Object.keys(this.activeNodes);
        await Promise.all(ids.map(id => this.activeNodes[id].close(false)));
        this.activeNodes = {};
    }

    handleStatus(node, statusMessage) {
        let handled = false;
        this.statusNodes.forEach(targetStatusNode => {
            if (Array.isArray(targetStatusNode.scope) &&
                targetStatusNode.scope.indexOf(node.id) === -1) {
                return;
            }
            const message = { status: redUtil.cloneMessage(statusMessage) };
            if (Object.prototype.hasOwnProperty.call(statusMessage, "text")) {
                message.status.text = statusMessage.text.toString();
            }
            message.status.source = { id: node.id, type: node.type, name: node.name };
            targetStatusNode.receive(message);
            handled = true;
        });
        return handled;
    }

    handleError(node, logMessage, msg, reportingNode) {
        if (!reportingNode) { reportingNode = node; }
        let count = 1;
        if (msg && msg.error && msg.error.source) {
            if (msg.error.source.id === node.id) {
                count = msg.error.source.count + 1;
                if (count === 10) {
                    node.warn("catch node error loop detected");
                    return false;
                }
            }
        }
        let handled = false;

        if (this.isGlobalFlow && node.users) {
            for (const userNode of Object.values(node.users)) {
                handled = userNode._flow.handleError(node, logMessage, msg, userNode) || handled;
            }
            return handled;
        }

        let handledByUncaught = false;
        this.catchNodes.forEach(targetCatchNode => {
            if (Array.isArray(targetCatchNode.scope) &&
                targetCatchNode.scope.indexOf(reportingNode.id) === -1) {
                return;
            }
            if (targetCatchNode.uncaught && !handledByUncaught) {
                if (handled) { return; }
                handledByUncaught = true;
            }
            let errorMessage;
            if (msg) { errorMessage = redUtil.cloneMessage(msg); }
            else { errorMessage = {}; }
            if (Object.prototype.hasOwnProperty.call(errorMessage, "error")) {
                errorMessage._error = errorMessage.error;
            }
            errorMessage.error = {
                message: logMessage.toString(),
                source: { id: node.id, type: node.type, name: node.name, count }
            };
            if (logMessage && logMessage.code !== undefined) { errorMessage.error.code = logMessage.code; }
            if (logMessage && logMessage.stack !== undefined) { errorMessage.error.stack = logMessage.stack; }
            if (logMessage && logMessage.cause !== undefined) { errorMessage.error.cause = logMessage.cause; }
            targetCatchNode.receive(errorMessage);
            handled = true;
        });
        return handled;
    }

    handleComplete(node, msg) {
        if (this.completeNodeMap[node.id]) {
            this.completeNodeMap[node.id].forEach(completeNode => {
                const toSend = redUtil.cloneMessage(msg);
                toSend.complete = {
                    source: { id: node.id, type: node.type, name: node.name }
                };
                completeNode.receive(toSend);
            });
        }
    }

    send(sendEvents) {
        for (const sendEvent of sendEvents) {
            sendEvent.destination.node = this.getNode(sendEvent.destination.id);
            if (sendEvent.destination.node && typeof sendEvent.destination.node === "object") {
                if (sendEvent.cloneMessage) {
                    sendEvent.msg = redUtil.cloneMessage(sendEvent.msg);
                }
                // Node-RED delivers asynchronously by default; keep that.
                const ev = sendEvent;
                setImmediate(() => {
                    try {
                        ev.destination.node.receive(ev.msg);
                    } catch (err) {
                        Log.log({ level: Log.ERROR, id: ev.destination.id, type: "flow", msg: err.stack || err });
                    }
                });
            }
        }
    }
}

module.exports = { Flow };
