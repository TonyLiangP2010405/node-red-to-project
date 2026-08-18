"use strict";

function normalizePath(type, path) {
    path = String(path || "");
    const prefix = `${type}.`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function readContext(store, runtime, path) {
    path = String(path || "");
    if (!path.includes(".")) {
        return store.get(path);
    }
    const parts = path.split(".");
    const root = store.get(parts[0]);
    if (root !== undefined) {
        return runtime._getProp(root, parts.slice(1).join("."));
    }
    return store.get(path);
}

function writeContext(store, runtime, path, value) {
    path = String(path || "");
    if (!path.includes(".")) {
        store.set(path, value);
        return;
    }
    const parts = path.split(".");
    const root = store.get(parts[0]);
    const target = root && typeof root === "object" ? root : {};
    runtime._setProp(target, parts.slice(1).join("."), value);
    store.set(parts[0], target);
}

function deleteContext(store, runtime, path) {
    path = String(path || "");
    if (!path.includes(".")) {
        store.set(path, undefined);
        return;
    }
    const parts = path.split(".");
    const root = store.get(parts[0]);
    if (root && typeof root === "object") {
        runtime._setProp(root, parts.slice(1).join("."), undefined);
        store.set(parts[0], root);
    }
}

function readValue(runtime, node, msg, type, path) {
    type = type || "msg";
    path = normalizePath(type, path);
    if (type === "msg") {
        return runtime._getProp(msg, path);
    }
    if (type === "flow" || type === "global") {
        return readContext(node.context()[type], runtime, path);
    }
    return path;
}

function writeValue(runtime, node, msg, type, path, value) {
    type = type || "msg";
    path = normalizePath(type, path);
    if (type === "msg") {
        runtime._setProp(msg, path, value);
    } else if (type === "flow" || type === "global") {
        writeContext(node.context()[type], runtime, path, value);
    }
}

function deleteValue(runtime, node, msg, type, path) {
    type = type || "msg";
    path = normalizePath(type, path);
    if (type === "msg") {
        runtime._setProp(msg, path, undefined);
    } else if (type === "flow" || type === "global") {
        deleteContext(node.context()[type], runtime, path);
    }
}

async function evaluateJsonata(expression, msg) {
    const jsonata = require("jsonata");
    return await jsonata(expression).evaluate(msg);
}

async function valueFor(runtime, node, msg, value, type) {
    switch (type || "str") {
    case "num":
        return Number(value);
    case "bool":
        return typeof value === "boolean" ? value : /^true$/i.test(String(value));
    case "json":
        return typeof value === "string" ? JSON.parse(value) : value;
    case "date":
        return Date.now();
    case "env":
        return process.env[String(value)];
    case "msg":
    case "flow":
    case "global":
        return readValue(runtime, node, msg, type, value);
    case "jsonata":
        return evaluateJsonata(value, msg);
    default:
        return value;
    }
}

function sourceSpec(rule) {
    if (rule.from !== undefined) {
        return { type: rule.fromt || rule.pt || "msg", path: rule.from };
    }
    return { type: rule.pt || "msg", path: rule.p };
}

function destinationSpec(rule) {
    if (rule.from !== undefined) {
        return { type: rule.pt || "msg", path: rule.p };
    }
    return { type: rule.tot || rule.pt || "msg", path: rule.to };
}

module.exports = {
    type: "change",
    requires: ["jsonata"],
    register(runtime) {
        runtime.registerNode("change", (node, config) => ({
            async input(msg, send, done) {
                try {
                    for (const rule of config.rules || []) {
                        const target = { type: rule.pt || "msg", path: rule.p };
                        if (rule.t === "delete") {
                            deleteValue(runtime, node, msg, target.type, target.path);
                            continue;
                        }
                        if (rule.t === "set") {
                            const value = await valueFor(runtime, node, msg, rule.to, rule.tot || "str");
                            writeValue(runtime, node, msg, target.type, target.path, value);
                            continue;
                        }
                        if (rule.t === "move" || rule.t === "rename") {
                            const source = sourceSpec(rule);
                            const destination = destinationSpec(rule);
                            const value = readValue(runtime, node, msg, source.type, source.path);
                            writeValue(runtime, node, msg, destination.type, destination.path, value);
                            deleteValue(runtime, node, msg, source.type, source.path);
                        }
                    }
                    send(msg);
                    if (done) { done(); }
                } catch (err) {
                    node.error(err, msg);
                    if (done) { done(err); }
                }
            }
        }));
    }
};
