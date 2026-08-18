"use strict";

module.exports = {
    type: "link out",
    requires: [],
    register(runtime) {
        runtime.registerNode("link out", (node, config) => {
            if (config.mode === "return") {
                throw new Error("link call/return 暂不支持");
            }
            return {
                input(msg, send, done) {
                    send(msg);
                    done();
                }
            };
        });
    }
};
