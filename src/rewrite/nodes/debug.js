"use strict";

function formatValue(value) {
    if (value !== null && typeof value === "object") {
        try { return JSON.stringify(value); }
        catch (err) { return String(value); }
    }
    return String(value);
}

module.exports = {
    type: "debug",
    requires: [],
    register(runtime) {
        runtime.registerNode("debug", (node, config) => ({
            input(msg) {
                if (config.active === false || config.active === "false") { return; }
                let value;
                if (config.completeType === "msg") {
                    value = msg;
                } else {
                    let path = config.complete === undefined || config.complete === false || config.complete === "false"
                        ? "payload"
                        : config.complete;
                    path = String(path).replace(/^msg\./, "");
                    value = runtime._getProp(msg, path);
                }
                node.log(formatValue(value));
            }
        }));
    }
};
