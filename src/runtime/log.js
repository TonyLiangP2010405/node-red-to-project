/**
 * Minimal console logger for the standalone runtime.
 *
 * Log entries follow the Node-RED shape: { level, id, type, name, msg }.
 * Handlers can be attached (used by tests and debug capture).
 */
"use strict";

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, metric: 98, audit: 99 };
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));

let logLevel = LEVELS.info;
const handlers = [];

function log(entry) {
    if (typeof entry === "string") {
        entry = { level: LEVELS.info, msg: entry };
    }
    if (typeof entry.level === "string") {
        entry.level = LEVELS[entry.level] || LEVELS.info;
    }
    for (const h of handlers) {
        try { h(entry); } catch (err) { /* never let a handler break the runtime */ }
    }
    if (entry.level < logLevel || entry.level >= LEVELS.metric) {
        return;
    }
    const lvl = LEVEL_NAMES[entry.level] || "info";
    let where = "";
    if (entry.name) { where = `[${entry.type || ""}:${entry.name}]`; }
    else if (entry.type && entry.id) { where = `[${entry.type}:${entry.id}]`; }
    else if (entry.type) { where = `[${entry.type}]`; }
    let text = entry.msg;
    if (text instanceof Error) { text = text.stack || text.toString(); }
    else if (typeof text === "object") { try { text = JSON.stringify(text); } catch (err) { text = "" + text; } }
    const line = `${where ? where + " " : ""}${text}`;
    if (entry.level >= LEVELS.error) { console.error(`[${lvl}] ${line}`); }
    else if (entry.level >= LEVELS.warn) { console.warn(`[${lvl}] ${line}`); }
    else { console.log(`[${lvl}] ${line}`); }
}

module.exports = {
    log,
    TRACE: LEVELS.trace, DEBUG: LEVELS.debug, INFO: LEVELS.info,
    WARN: LEVELS.warn, ERROR: LEVELS.error, METRIC: LEVELS.metric, AUDIT: LEVELS.audit,
    addHandler(h) { handlers.push(h); },
    removeHandler(h) { const i = handlers.indexOf(h); if (i > -1) { handlers.splice(i, 1); } },
    setLevel(l) { logLevel = typeof l === "string" ? (LEVELS[l] || LEVELS.info) : l; },
    metric() { return false; },
    trace(m) { log({ level: LEVELS.trace, msg: m }); },
    debug(m) { log({ level: LEVELS.debug, msg: m }); },
    info(m) { log({ level: LEVELS.info, msg: m }); },
    warn(m) { log({ level: LEVELS.warn, msg: m }); },
    error(m) { log({ level: LEVELS.error, msg: m }); },
    audit(m) { log({ level: LEVELS.audit, msg: m }); },
    _(id, opts) { return (opts && opts.defaultValue) || id; }
};
