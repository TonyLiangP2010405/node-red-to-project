"use strict";

module.exports = {
    type: "template",
    requires: ["mustache"],
    register(runtime) {
        runtime.registerNode("template", (node, config) => ({
            input(msg, send, done) {
                try {
                    const value = config.syntax === "plain"
                        ? config.template
                        : require("mustache").render(config.template || "", msg);
                    runtime._setProp(msg, config.field || "payload", value);
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
