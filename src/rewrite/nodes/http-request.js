"use strict";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Never forward these from a previous response's msg.headers into a new request.
const SKIP_HEADERS = new Set([
    "content-length", "host", "connection", "keep-alive",
    "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization"
]);

function renderUrl(template, msg) {
    template = String(template || "");
    if (!template.includes("{{")) { return template; }
    return require("mustache").render(template, msg);
}

function collectHeaders(node, config, msg) {
    const headers = {};
    for (const entry of config.headers || []) {
        if (!entry || !entry.keyValue) { continue; }
        headers[String(entry.keyValue)] = String(entry.valueValue !== undefined ? entry.valueValue : "");
    }
    if (msg.headers && typeof msg.headers === "object") {
        for (const [key, value] of Object.entries(msg.headers)) {
            if (SKIP_HEADERS.has(String(key).toLowerCase())) { continue; }
            if (value !== undefined && value !== null) { headers[String(key)] = String(value); }
        }
    }
    return headers;
}

async function parseBody(response, ret) {
    if (ret === "bin") {
        return Buffer.from(await response.arrayBuffer());
    }
    const text = await response.text();
    if (ret === "obj") {
        try { return JSON.parse(text); } catch (err) { return text; }
    }
    return text;
}

module.exports = {
    type: "http request",
    requires: ["mustache"],
    register(runtime) {
        runtime.registerNode("http request", (node, config) => ({
            async input(msg, send, done) {
                try {
                    const method = String(
                        config.method === "use" ? (msg.method || "GET") : (config.method || "GET")
                    ).toUpperCase();
                    let url = renderUrl(config.url || msg.url || "", msg);
                    if (!url) { throw new Error("http request: no url configured"); }

                    const headers = collectHeaders(node, config, msg);
                    const options = { method, headers, redirect: "follow" };

                    if (config.paytoqs === "query" && msg.payload && typeof msg.payload === "object" && !BODY_METHODS.has(method)) {
                        const qs = new URLSearchParams();
                        for (const [key, value] of Object.entries(msg.payload)) {
                            qs.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
                        }
                        url += (url.includes("?") ? "&" : "?") + qs.toString();
                    } else if (BODY_METHODS.has(method) && msg.payload !== undefined) {
                        if (Buffer.isBuffer(msg.payload) || typeof msg.payload === "string") {
                            options.body = msg.payload;
                        } else {
                            options.body = JSON.stringify(msg.payload);
                            if (!Object.keys(headers).some(key => key.toLowerCase() === "content-type")) {
                                headers["content-type"] = "application/json";
                            }
                        }
                    }

                    const response = await fetch(url, options);
                    msg.statusCode = response.status;
                    msg.responseUrl = response.url;
                    msg.headers = {};
                    response.headers.forEach((value, key) => { msg.headers[key] = value; });
                    msg.payload = await parseBody(response, config.ret || "txt");

                    send(msg);
                    if (done) { done(); }
                } catch (err) {
                    if (config.senderr) {
                        msg.payload = err.message;
                        msg.statusCode = 0;
                        send(msg);
                        if (done) { done(); }
                    } else {
                        node.error(err, msg);
                        if (done) { done(err); }
                    }
                }
            }
        }));
    }
};
