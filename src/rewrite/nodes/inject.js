"use strict";

function asBoolean(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function valueOf(value, type, context) {
    switch (type) {
    case "str":
        return value === undefined || value === null ? value : String(value);
    case "num":
        return Number(value);
    case "bool":
        return asBoolean(value);
    case "json":
        return typeof value === "string" ? JSON.parse(value) : value;
    case "date":
    case "timestamp":
        return Date.now();
    case "env":
        return process.env[String(value)];
    case "flow":
        return context.flow.get(value);
    case "global":
        return context.global.get(value);
    default:
        return value;
    }
}

function messageFactory(node, config, setProp) {
    const context = node.context();
    const message = {
        payload: valueOf(config.payload, config.payloadType || "str", context),
        topic: config.topic
    };

    for (const prop of Array.isArray(config.props) ? config.props : []) {
        if (!prop || !prop.p) { continue; }
        // Legacy merge: a prop entry without v falls back to the legacy
        // payload/payloadType/topic fields (official 20-inject.js behaviour)
        let v = prop.v;
        let vt = prop.vt || "str";
        if (v === undefined) {
            if (prop.p === "payload") { v = config.payload; vt = config.payloadType || "str"; }
            else if (prop.p === "topic") { v = config.topic; vt = "str"; }
            else { continue; }
        }
        const path = String(prop.p).replace(/^msg\./, "");
        const value = valueOf(v, vt, context);
        setProp(message, path, value);
    }
    return message;
}

module.exports = {
    type: "inject",
    requires: [],
    register(runtime) {
        runtime.registerNode("inject", (node, config) => {
            if (config.crontab) {
                throw new Error("crontab 暂不支持");
            }

            const timers = new Set();
            let closed = false;
            const trigger = () => {
                if (!closed) { node.send(messageFactory(node, config, runtime._setProp)); }
            };
            const scheduleTimeout = (delay, callback) => {
                const timer = setTimeout(() => {
                    timers.delete(timer);
                    callback();
                }, delay);
                timers.add(timer);
            };

            const once = config.once === true || config.once === "true";
            if (once) {
                const onceDelay = config.onceDelay === undefined ? 0.1 : Number(config.onceDelay);
                scheduleTimeout(Number.isFinite(onceDelay) ? Math.max(0, onceDelay * 1000) : 100, trigger);
            }

            const repeat = Number(config.repeat);
            if (Number.isFinite(repeat) && repeat > 0) {
                const timer = setInterval(trigger, repeat * 1000);
                timers.add(timer);
            }

            node.onClose(() => {
                closed = true;
                for (const timer of timers) {
                    clearTimeout(timer);
                    clearInterval(timer);
                }
                timers.clear();
            });
        });
    }
};
