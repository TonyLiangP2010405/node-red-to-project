/**
 * In-memory context stores for the standalone runtime: node / flow / global scopes.
 * Values are cloned on the way in and out, matching Node-RED's memory store behaviour.
 */
"use strict";

const redUtil = require("@node-red/util").util;

function clone(value) {
    if (value === undefined || value === null) { return value; }
    try { return redUtil.cloneMessage({ v: value }).v; }
    catch (err) { return value; }
}

function createStore() {
    const data = new Map();
    return {
        get(key) {
            if (key === undefined) { return undefined; }
            if (!data.has(key)) { return undefined; }
            return clone(data.get(key));
        },
        set(key, value) {
            if (value === undefined) { data.delete(key); }
            else { data.set(key, clone(value)); }
        },
        keys() { return [...data.keys()]; },
        clear() { data.clear(); }
    };
}

function makeContext(getStore, extra) {
    const ctx = {
        get(key, store, callback) {
            if (typeof store === "function") { callback = store; }
            // only the default memory store exists; the store arg is accepted and ignored
            const doGet = () => {
                if (Array.isArray(key)) { return key.map(k => getStore().get(k)); }
                return getStore().get(key);
            };
            if (callback) { setImmediate(() => callback(null, doGet())); return; }
            return doGet();
        },
        set(key, value, store, callback) {
            if (typeof store === "function") { callback = store; store = undefined; }
            const doSet = () => {
                if (Array.isArray(key)) {
                    const values = Array.isArray(value) ? value : [];
                    key.forEach((k, i) => getStore().set(k, values[i]));
                } else {
                    getStore().set(key, value);
                }
            };
            if (callback) { doSet(); setImmediate(() => callback(null)); return; }
            doSet();
        },
        keys(store, callback) {
            if (typeof store === "function") { callback = store; }
            const doKeys = () => getStore().keys();
            if (callback) { setImmediate(() => callback(null, doKeys())); return; }
            return doKeys();
        }
    };
    return Object.assign(ctx, extra || {});
}

function createContextManager() {
    const globalStore = createStore();
    const flowStores = new Map();  // flowId -> store
    const nodeStores = new Map();  // flowId + "." + nodeId -> store

    function flowStore(flowId) {
        const id = flowId || "global";
        if (!flowStores.has(id)) { flowStores.set(id, createStore()); }
        return flowStores.get(id);
    }
    function nodeStore(nodeId, flowId) {
        const key = (flowId || "global") + "." + nodeId;
        if (!nodeStores.has(key)) { nodeStores.set(key, createStore()); }
        return nodeStores.get(key);
    }

    const globalContext = makeContext(() => globalStore);

    return {
        global: globalContext,
        getFlowContext(flowId) {
            return makeContext(() => flowStore(flowId), { get global() { return globalContext; } });
        },
        // The context object handed to a node: node scope plus .flow and .global
        getNodeContext(nodeId, flowId) {
            return makeContext(() => nodeStore(nodeId, flowId), {
                get flow() { return makeContext(() => flowStore(flowId)); },
                get global() { return globalContext; }
            });
        },
        deleteNodeContext(nodeId, flowId) {
            const store = nodeStores.get((flowId || "global") + "." + nodeId);
            if (store) { store.clear(); }
            return Promise.resolve();
        }
    };
}

module.exports = { createContextManager };
