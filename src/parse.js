"use strict";

/**
 * Parse and classify a Node-RED flows.json export.
 *
 * @param {string|Array} input flows.json text or an already parsed array
 * @returns {{tabs: Array, globalConfigs: Array, groups: Array, subflows: Array, warnings: Array<string>}}
 */
function parseFlowFile(input) {
    const items = toFlowArray(input);
    const tabs = [];
    const subflows = [];
    const groups = [];
    const globalConfigs = [];
    const warnings = [];
    const tabsById = new Map();
    const subflowsById = new Map();

    for (const item of items) {
        if (item.type === "tab") {
            const tab = {
                id: item.id,
                label: item.label,
                info: item.info,
                env: item.env,
                disabled: item.disabled,
                nodes: [],
            };
            tabs.push(tab);
            tabsById.set(item.id, tab);
        } else if (item.type === "subflow") {
            const subflow = { ...item, nodes: [] };
            subflows.push(subflow);
            subflowsById.set(item.id, subflow);
        } else if (item.type === "group") {
            groups.push(item);
        }
    }

    for (const item of items) {
        if (item.type === "tab" || item.type === "subflow" || item.type === "group") {
            continue;
        }
        if (item.z !== undefined) {
            const parent = tabsById.get(item.z) || subflowsById.get(item.z);
            if (parent) {
                parent.nodes.push(item);
            } else {
                warnings.push(`Node ${item.id || "<unknown>"} references unknown flow ${item.z}`);
            }
        } else {
            globalConfigs.push(item);
        }
    }

    return { tabs, globalConfigs, groups, subflows, warnings };
}

function toFlowArray(input) {
    let value = input;
    if (typeof input === "string") {
        try {
            value = JSON.parse(input);
        } catch (error) {
            throw new Error(`Invalid JSON in flows.json: ${error.message}`);
        }
    }
    if (!Array.isArray(value)) {
        throw new Error("flows.json must contain an array of flow items");
    }
    return value;
}

module.exports = { parseFlowFile };
