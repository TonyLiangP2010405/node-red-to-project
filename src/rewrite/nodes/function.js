"use strict";

module.exports = {
    type: "function",
    requires: [],
    register(runtime) {
        runtime.registerNode("function", (node, config) => {
            const func = config.func;
            if (typeof func !== "function") {
                throw new Error(`function node ${config.id} requires a real function`);
            }

            return {
                async input(msg, send, done) {
                    const context = node.context();
                    const finish = err => {
                        if (err) { node.error(err, msg); }
                    };
                    const scope = {
                        node,
                        context,
                        flow: context.flow,
                        global: context.global,
                        send,
                        done: finish,
                        env: { get: name => process.env[String(name)] }
                    };

                    try {
                        const result = await func(msg, scope);
                        if (result !== null && result !== undefined) { send(result); }
                    } catch (err) {
                        node.error(err, msg);
                    }
                }
            };
        });
    }
};
