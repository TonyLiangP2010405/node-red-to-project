"use strict";

module.exports = {
    type: "junction",
    requires: [],
    register(runtime) {
        runtime.registerNode("junction", () => ({
            input(msg, send, done) {
                send(msg);
                done();
            }
        }));
    }
};
