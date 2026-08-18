"use strict";

function normalizePath(type, path) {
    path = String(path || "");
    const prefix = `${type}.`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function readContext(store, runtime, path) {
    path = String(path || "");
    if (!path.includes(".")) { return store.get(path); }
    const parts = path.split(".");
    const root = store.get(parts[0]);
    if (root !== undefined) { return runtime._getProp(root, parts.slice(1).join(".")); }
    return store.get(path);
}

function readProperty(runtime, node, msg, type, path) {
    type = type || "msg";
    path = normalizePath(type, path);
    if (type === "msg") { return runtime._getProp(msg, path); }
    if (type === "flow" || type === "global") {
        return readContext(node.context()[type], runtime, path);
    }
    return path;
}

async function evaluateJsonata(expression, msg) {
    const jsonata = require("jsonata");
    return await jsonata(expression).evaluate(msg);
}

async function ruleValue(runtime, node, msg, value, type) {
    switch (type || "str") {
    case "num":
        return Number(value);
    case "bool":
        return typeof value === "boolean" ? value : /^true$/i.test(String(value));
    case "json":
        return typeof value === "string" ? JSON.parse(value) : value;
    case "env":
        return process.env[String(value)];
    case "msg":
    case "flow":
    case "global":
        return readProperty(runtime, node, msg, type, value);
    case "jsonata":
        return evaluateJsonata(value, msg);
    default:
        return value;
    }
}

function isType(value, expected) {
    switch (String(expected)) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && !Number.isNaN(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "buffer": return Buffer.isBuffer(value);
    case "null": return value === null;
    case "json":
        if (typeof value === "string") {
            try { JSON.parse(value); return true; } catch (err) { return false; }
        }
        return value !== null && typeof value === "object" && !Buffer.isBuffer(value);
    default: return false;
    }
}

function matches(operator, actual, expected, second, rule) {
    switch (operator) {
    case "eq": return actual == expected;
    case "neq": return actual != expected;
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "gt": return actual > expected;
    case "gte": return actual >= expected;
    case "between":
    case "btwn": return (actual >= expected && actual <= second) || (actual <= expected && actual >= second);
    case "cont": return String(actual).includes(String(expected));
    case "regex": return new RegExp(String(expected), rule.case ? "i" : "").test(String(actual));
    case "true": return actual === true;
    case "false": return actual === false;
    case "null": return actual === null || actual === undefined;
    case "nnull": return actual !== null && actual !== undefined;
    case "hask": return actual !== null && actual !== undefined && typeof expected !== "object" &&
        Object.prototype.hasOwnProperty.call(Object(actual), String(expected));
    case "istype": return isType(actual, expected);
    default: return false;
    }
}

module.exports = {
    type: "switch",
    requires: [],
    register(runtime) {
        runtime.registerNode("switch", (node, config) => ({
            async input(msg, send, done) {
                try {
                    const property = await readProperty(
                        runtime,
                        node,
                        msg,
                        config.propertyType || "msg",
                        config.property
                    );
                    const rules = config.rules || [];
                    const ordinary = rules.filter(rule => rule.t !== "else");
                    const matched = [];
                    for (const rule of ordinary) {
                        const expected = await ruleValue(runtime, node, msg, rule.v, rule.vt || "str");
                        const second = rule.v2 === undefined
                            ? undefined
                            : await ruleValue(runtime, node, msg, rule.v2, rule.v2t || rule.vt || "str");
                        if (matches(rule.t, property, expected, second, rule)) {
                            matched.push(rule);
                            if (config.checkall !== "true") { break; }
                        }
                    }
                    if (matched.length === 0) {
                        const elseRule = rules.find(rule => rule.t === "else");
                        if (elseRule) { matched.push(elseRule); }
                    }
                    const outputs = new Array(rules.length).fill(null);
                    for (const rule of matched) {
                        outputs[rules.indexOf(rule)] = msg;
                    }
                    send(outputs);
                    if (done) { done(); }
                } catch (err) {
                    node.error(err, msg);
                    if (done) { done(err); }
                }
            }
        }));
    }
};
