"use strict";

const ENV_RE = /^\$\((\S+)\)$/;
const STRUCTURAL_FIELDS = new Set(["id", "type", "z", "wires", "x", "y"]);

/**
 * Expand all subflow instances in parsed tabs into inline nodes.
 *
 * @param {object} parsed - The result returned by parseFlowFile.
 * @returns {object} The same parsed object.
 */
function expandSubflows(parsed) {
    if (!parsed || typeof parsed !== "object") {
        throw new TypeError("parsed flow is required");
    }

    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    parsed.warnings = warnings;
    const definitions = new Map();
    for (const subflow of parsed.subflows || []) {
        if (subflow && subflow.id) {
            definitions.set(subflow.id, subflow);
        }
    }

    const context = { definitions, warnings, resolved: new Map() };
    for (const subflow of parsed.subflows || []) {
        if (!subflow || !subflow.id) {
            continue;
        }
        const expanded = resolveDefinition(subflow, context, []);
        subflow.nodes = expanded.nodes;
        if (Array.isArray(subflow.in)) {
            subflow.in = expanded.in;
        }
        if (Array.isArray(subflow.out)) {
            subflow.out = expanded.out;
        }
    }

    for (const tab of parsed.tabs || []) {
        if (!tab || !Array.isArray(tab.nodes)) {
            continue;
        }
        tab.nodes = expandNodes(tab.nodes, tab.id, context, []);
    }

    return parsed;
}

function resolveDefinition(subflow, context, stack) {
    const cached = context.resolved.get(subflow.id);
    if (cached) {
        return cloneDefinition(cached);
    }

    const nextStack = [...stack, subflow.id];
    let nodes = cloneValue(subflow.nodes || []);
    let inputs = cloneValue(subflow.in || []);
    let outputs = cloneValue(subflow.out || []);

    for (let index = 0; index < nodes.length; index += 1) {
        const instance = nodes[index];
        if (!isSubflowInstance(instance)) {
            continue;
        }

        const childId = instance.type.slice("subflow:".length);
        const child = context.definitions.get(childId);
        if (!child) {
            warnMissingDefinition(context.warnings, instance);
            continue;
        }
        if (nextStack.includes(childId)) {
            context.warnings.push(`subflow 嵌套循环，保留实例 ${instance.id} (${instance.type})`);
            continue;
        }

        const replacement = instantiate(child, instance, subflow.id, context, nextStack);
        nodes = replaceNode(nodes, index, replacement.nodes);
        inputs = replaceBoundaryInputs(inputs, instance.id, replacement.entryTargets);
        outputs = replaceBoundaryOutputs(outputs, instance.id, replacement.outputSources);
        index += replacement.nodes.length - 1;
    }

    const expanded = { nodes, in: inputs, out: outputs };
    context.resolved.set(subflow.id, expanded);
    return cloneDefinition(expanded);
}

function instantiate(subflow, instance, containerId, context, stack) {
    const definition = resolveDefinition(subflow, context, stack);
    const prefix = `${instance.id}:`;
    const internalIds = new Set(
        definition.nodes.filter(node => node && node.id).map(node => node.id)
    );
    const routes = buildOutputRoutes(definition.out, instance.wires);
    const envValues = buildEnvValues(subflow.env, instance.env, context.warnings);
    const nodes = definition.nodes.map(node => {
        const copy = cloneValue(node);
        const originalId = copy.id;
        copy.id = `${prefix}${originalId}`;
        copy.z = containerId;
        copy.wires = rewriteWires(copy.wires, originalId, prefix, internalIds, routes);
        substituteNodeConfig(copy, envValues);
        return copy;
    });

    const entryTargets = [];
    for (const input of definition.in || []) {
        for (const wire of input.wires || []) {
            if (wire && wire.id) {
                entryTargets.push(`${prefix}${wire.id}`);
            }
        }
    }

    const outputSources = (definition.out || []).map(output => (output.wires || [])
        .filter(wire => wire && wire.id)
        .map(wire => ({ ...wire, id: `${prefix}${wire.id}` })));

    return { nodes, entryTargets, outputSources };
}

function expandNodes(initialNodes, containerId, context, stack) {
    let nodes = initialNodes;
    for (let index = 0; index < nodes.length; index += 1) {
        const instance = nodes[index];
        if (!isSubflowInstance(instance)) {
            continue;
        }

        const childId = instance.type.slice("subflow:".length);
        const child = context.definitions.get(childId);
        if (!child) {
            warnMissingDefinition(context.warnings, instance);
            continue;
        }
        if (stack.includes(childId)) {
            context.warnings.push(`subflow 嵌套循环，保留实例 ${instance.id} (${instance.type})`);
            continue;
        }

        const replacement = instantiate(child, instance, containerId, context, [...stack, childId]);
        rewriteIncomingWires(nodes, instance.id, replacement.entryTargets);
        nodes = replaceNode(nodes, index, replacement.nodes);
        index += replacement.nodes.length - 1;
    }
    return nodes;
}

function replaceNode(nodes, index, replacement) {
    return [
        ...nodes.slice(0, index),
        ...replacement,
        ...nodes.slice(index + 1)
    ];
}

function rewriteIncomingWires(nodes, targetId, replacements) {
    for (const node of nodes) {
        if (!node || !Array.isArray(node.wires)) {
            continue;
        }
        node.wires = node.wires.map(destinations => {
            if (!Array.isArray(destinations)) {
                return destinations;
            }
            const rewritten = [];
            for (const destination of destinations) {
                if (destination !== targetId) {
                    rewritten.push(destination);
                } else {
                    rewritten.push(...replacements);
                }
            }
            return rewritten;
        });
    }
}

function replaceBoundaryInputs(inputs, targetId, replacements) {
    return inputs.map(input => ({
        ...input,
        wires: (input.wires || []).flatMap(wire => {
            if (!wire || wire.id !== targetId) {
                return [wire];
            }
            return replacements.map(id => ({ ...wire, id }));
        })
    }));
}

function replaceBoundaryOutputs(outputs, targetId, outputSources) {
    return outputs.map(output => ({
        ...output,
        wires: (output.wires || []).flatMap(wire => {
            if (!wire || wire.id !== targetId) {
                return [wire];
            }
            return (outputSources[wire.port] || []).map(source => ({
                ...wire,
                ...source
            }));
        })
    }));
}

function buildOutputRoutes(outputs, instanceWires) {
    const routes = new Map();
    for (let outputIndex = 0; outputIndex < (outputs || []).length; outputIndex += 1) {
        const destinations = Array.isArray(instanceWires && instanceWires[outputIndex])
            ? instanceWires[outputIndex]
            : [];
        for (const wire of outputs[outputIndex].wires || []) {
            if (!wire || !wire.id || wire.port === undefined) {
                continue;
            }
            const key = `${wire.id}:${wire.port}`;
            const route = routes.get(key) || [];
            route.push(...destinations);
            routes.set(key, route);
        }
    }
    return routes;
}

function rewriteWires(wires, nodeId, prefix, internalIds, routes) {
    const rewritten = Array.isArray(wires) ? cloneValue(wires) : [];
    for (const [key, destinations] of routes.entries()) {
        const separator = key.lastIndexOf(":");
        const sourceId = key.slice(0, separator);
        const port = Number(key.slice(separator + 1));
        if (sourceId !== nodeId) {
            continue;
        }
        while (rewritten.length <= port) {
            rewritten.push([]);
        }
        if (!Array.isArray(rewritten[port])) {
            rewritten[port] = [];
        }
        rewritten[port].push(...destinations);
    }

    return rewritten.map(destinations => {
        if (!Array.isArray(destinations)) {
            return destinations;
        }
        return destinations.map(destination => internalIds.has(destination)
            ? `${prefix}${destination}`
            : destination);
    });
}

function buildEnvValues(defaults, overrides, warnings) {
    const definitions = new Map();
    for (const definition of [...(defaults || []), ...(overrides || [])]) {
        if (definition && definition.name) {
            definitions.set(definition.name, definition);
        }
    }

    const values = new Map();
    for (const definition of definitions.values()) {
        if (definition.type === "cred") {
            warnings.push("cred 类型 env 暂不支持");
            values.set(definition.name, { supported: false });
            continue;
        }
        try {
            values.set(definition.name, {
                supported: true,
                value: convertEnvValue(definition.value, definition.type)
            });
        } catch (error) {
            warnings.push(`env ${definition.name} 转换失败：${error.message}`);
            values.set(definition.name, { supported: false });
        }
    }
    return values;
}

function convertEnvValue(value, type) {
    if (type === "num") {
        return parseFloat(value);
    }
    if (type === "bool") {
        return value === "true" || value === true;
    }
    if (type === "json") {
        return JSON.parse(value);
    }
    return value;
}

function substituteNodeConfig(node, values) {
    for (const key of Object.keys(node)) {
        if (!STRUCTURAL_FIELDS.has(key)) {
            node[key] = substituteValue(node[key], values);
        }
    }
}

function substituteValue(value, values) {
    if (typeof value === "string") {
        const match = ENV_RE.exec(value);
        if (!match || !values.has(match[1])) {
            return value;
        }
        const envValue = values.get(match[1]);
        return envValue.supported && envValue.value !== undefined ? envValue.value : value;
    }
    if (Array.isArray(value)) {
        return value.map(item => substituteValue(item, values));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = substituteValue(item, values);
        }
        return result;
    }
    return value;
}

function cloneDefinition(definition) {
    return {
        nodes: cloneValue(definition.nodes),
        in: cloneValue(definition.in),
        out: cloneValue(definition.out)
    };
}

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map(item => cloneValue(item));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = cloneValue(item);
        }
        return result;
    }
    return value;
}

function isSubflowInstance(node) {
    return Boolean(node && typeof node.type === "string" && node.type.startsWith("subflow:"));
}

function warnMissingDefinition(warnings, instance) {
    warnings.push(`找不到 subflow 定义：${instance.type}（实例 ${instance.id}）`);
}

module.exports = { expandSubflows };
