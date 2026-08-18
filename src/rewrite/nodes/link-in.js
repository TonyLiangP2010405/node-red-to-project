"use strict";

module.exports = {
    type: "link in",
    requires: [],
    register(runtime) {
        runtime.registerNode("link in", () => ({
            input(msg, send, done) {
                send(msg);
                done();
            }
        }));
    }
};
