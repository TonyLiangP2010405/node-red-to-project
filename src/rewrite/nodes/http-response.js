"use strict";

module.exports = {
    type: "http response",
    requires: ["express"],
    register(runtime) {
        runtime.registerNode("http response", (node, config) => ({
            input(msg, send, done) {
                const res = msg && msg._res;
                if (!res) {
                    node.warn("Message has no response object");
                    if (done) { done(); }
                    return;
                }
                const statusCode = msg.statusCode !== undefined
                    ? msg.statusCode
                    : config.statusCode;
                if (statusCode !== undefined && statusCode !== null && statusCode !== "") {
                    res.status(Number(statusCode));
                }
                const headers = { ...(config.headers || {}), ...(msg.headers || {}) };
                if (Object.keys(headers).length > 0) {
                    res.set(headers);
                }
                res.send(msg.payload);
                if (done) { done(); }
            }
        }));
    }
};
