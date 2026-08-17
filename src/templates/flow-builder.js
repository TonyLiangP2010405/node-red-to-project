"use strict";

module.exports = function buildFlowDef(meta, buildFn) {
    const nodes = {};
    const wires = {};

    const flow = {
        add(type, config) {
            if (!config || !config.id) {
                throw new Error("flow.add requires a config object with an id");
            }
            const id = config.id;
            nodes[id] = { ...config, type, z: meta.id };
            wires[id] = [];
            return id;
        },

        wire(fromId, port, toId) {
            if (!wires[fromId]) {
                wires[fromId] = [];
            }
            if (!wires[fromId][port]) {
                wires[fromId][port] = [];
            }
            wires[fromId][port].push(toId);
        }
    };

    buildFn(flow);

    for (const id of Object.keys(nodes)) {
        nodes[id].wires = wires[id] || [];
    }
    return { ...meta, nodes };
};
