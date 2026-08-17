/**
 * Flow-level environment variables and $(VAR) substitution.
 *
 * Simplified from @node-red/runtime lib/flows/util.js (Apache-2.0):
 * supports str/num/bool/json/env/cred types and whole-string "$(NAME)"
 * substitution in node configs. jsonata env values are not supported.
 */
"use strict";

const ENV_RE = /^\$\((\S+)\)$/;

/**
 * Evaluate a flow's env definitions into a name -> value map.
 * @param flow   the Flow (used for getSetting lookups and error logging)
 * @param defs   array of { name, value, type }
 * @param credentials  decrypted credentials for this flow (for type "cred")
 */
function evaluateEnvProperties(flow, defs, credentials) {
    credentials = credentials || {};
    const result = {};
    const deferred = [];
    for (const def of defs || []) {
        let { name, value, type } = def;
        if (type === "env") {
            deferred.push(def);
            continue;
        }
        try {
            if (type === "bool") {
                value = (value === "true") || (value === true);
            } else if (type === "num") {
                value = parseFloat(value);
            } else if (type === "json") {
                value = JSON.parse(value);
            } else if (type === "cred") {
                value = Object.prototype.hasOwnProperty.call(credentials, name) ? credentials[name] : undefined;
            } else if (type === "jsonata") {
                flow.warn(`jsonata env property '${name}' is not supported by the standalone runtime; treated as undefined`);
                value = undefined;
            }
            // "str" and unknown types pass through as-is
        } catch (err) {
            flow.error(`Error evaluating env property '${name}': ${err.toString()}`);
            value = undefined;
        }
        result[name] = value;
    }
    // "env" types last: they may reference env vars defined at this same level
    for (const def of deferred) {
        const ref = evaluateEnvValue(flow, def.value);
        result[def.name] = ref !== undefined ? ref : process.env[def.value];
    }
    return result;
}

function evaluateEnvValue(flow, value) {
    if (typeof value !== "string") { return value; }
    const m = ENV_RE.exec(value);
    if (m) { return flow.getSetting(m[1]); }
    return undefined;
}

/**
 * Walk a node config and replace whole-string "$(NAME)" values with the
 * corresponding env var, like Node-RED's mapEnvVarProperties.
 */
function substituteEnvVars(config, flow) {
    for (const prop of Object.keys(config)) {
        mapProp(config, prop, flow);
    }
    return config;
}

function mapProp(obj, prop, flow) {
    const v = obj[prop];
    if (v === null || v === undefined || Buffer.isBuffer(v)) { return; }
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) { mapProp(v, i, flow); }
    } else if (typeof v === "string") {
        const m = ENV_RE.exec(v);
        if (m) {
            const r = flow.getSetting(m[1]);
            if (r !== undefined) { obj[prop] = r; }
        }
    } else if (typeof v === "object") {
        for (const p of Object.keys(v)) { mapProp(v, p, flow); }
    }
}

module.exports = { evaluateEnvProperties, substituteEnvVars };
