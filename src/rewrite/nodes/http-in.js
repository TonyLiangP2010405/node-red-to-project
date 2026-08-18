"use strict";

module.exports = {
    type: "http in",
    requires: ["express"],
    register(runtime) {
        runtime.registerNode("http in", (node, config) => {
            const method = String(config.method || "get").toLowerCase();
            const url = String(config.url || "").startsWith("/")
                ? String(config.url || "")
                : `/${config.url || ""}`;
            const app = node.http();
            if (typeof app[method] !== "function") {
                throw new Error(`Unsupported HTTP method: ${method}`);
            }
            app[method](url, (req, res) => {
                const payload = req.body === undefined ? {} : req.body;
                const msg = {
                    payload,
                    req: {
                        method: req.method,
                        url: req.url,
                        headers: req.headers,
                        query: req.query,
                        params: req.params
                    },
                    _res: res
                };
                node.send(msg);
            });
            runtime._registerRoute();
            return {};
        });
    }
};
