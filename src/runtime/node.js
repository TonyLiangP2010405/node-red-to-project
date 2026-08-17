/**
 * Node base class for the standalone runtime.
 *
 * Adapted from @node-red/runtime lib/nodes/Node.js (Apache-2.0,
 * Copyright JS Foundation and other contributors, http://js.foundation),
 * simplified: no metrics, no hooks, single-tenant.
 */
"use strict";

const util = require("util");
const EventEmitter = require("events").EventEmitter;
const redUtil = require("@node-red/util").util;
const Log = require("./log");

const NOOP_SEND = function () {};

function Node(n) {
    this.id = n.id;
    this.type = n.type;
    this.z = n.z;
    this.g = n.g;
    this._closeCallbacks = [];
    this._inputCallback = null;
    this._inputCallbacks = null;
    this._expectedDoneCount = 0;

    if (n.name) { this.name = n.name; }
    if (n._flow) {
        Object.defineProperty(this, "_flow", { value: n._flow, enumerable: false, writable: true });
    }
    this.updateWires(n.wires);
}

util.inherits(Node, EventEmitter);

Node.prototype.updateWires = function (wires) {
    this.wires = wires || [];
    delete this._wire;
    let wc = 0;
    this.wires.forEach(function (w) { wc += w.length; });
    this._wireCount = wc;
    if (wc === 0) {
        this.send = NOOP_SEND;
    } else {
        this.send = Node.prototype.send;
        if (this.wires.length === 1 && this.wires[0].length === 1) {
            this._wire = this.wires[0][0];
        }
    }
};

Node.prototype.context = function () {
    if (!this._context) {
        this._context = this._flow.contexts.getNodeContext(this.id, this.z);
    }
    return this._context;
};

Node.prototype._complete = function (msg, error) {
    if (error) {
        this.error(error, msg);
    } else {
        this._flow.handleComplete(this, msg);
    }
};

Node.prototype._on = Node.prototype.on;

Node.prototype.on = function (event, callback) {
    if (event === "close") {
        this._closeCallbacks.push(callback);
    } else if (event === "input") {
        if (callback.length === 3) { this._expectedDoneCount++; }
        if (this._inputCallback) {
            this._inputCallbacks = [this._inputCallback, callback];
            this._inputCallback = null;
        } else if (this._inputCallbacks) {
            this._inputCallbacks.push(callback);
        } else {
            this._inputCallback = callback;
        }
    } else {
        this._on(event, callback);
    }
};

Node.prototype._emit = Node.prototype.emit;

Node.prototype.emit = function (event, ...args) {
    if (event === "input") {
        this._emitInput.apply(this, args);
    } else {
        this._emit.apply(this, arguments);
    }
};

Node.prototype._emitInput = function (arg) {
    const node = this;
    if (node._inputCallback) {
        try {
            node._inputCallback(
                arg,
                function () { node.send.apply(node, arguments); },
                function (err) { node._complete(arg, err); }
            );
        } catch (err) {
            node.error(err, arg);
        }
    } else if (node._inputCallbacks) {
        const cbs = node._inputCallbacks.slice();
        let doneCount = 0;
        for (const cb of cbs) {
            try {
                cb.call(
                    node,
                    arg,
                    function () { node.send.apply(node, arguments); },
                    function (err) {
                        doneCount++;
                        if (doneCount === node._expectedDoneCount) {
                            node._complete(arg, err);
                        }
                    }
                );
            } catch (err) {
                node.error(err, arg);
            }
        }
    }
};

Node.prototype._removeListener = Node.prototype.removeListener;

Node.prototype.removeListener = function (name, listener) {
    if (name === "input") {
        if (listener.length === 3) { this._expectedDoneCount--; }
        if (this._inputCallback === listener) {
            this._inputCallback = null;
        } else if (this._inputCallbacks) {
            const index = this._inputCallbacks.indexOf(listener);
            if (index > -1) { this._inputCallbacks.splice(index, 1); }
            if (this._inputCallbacks.length === 1) {
                this._inputCallback = this._inputCallbacks[0];
                this._inputCallbacks = null;
            }
        }
    } else if (name === "close") {
        const index = this._closeCallbacks.indexOf(listener);
        if (index > -1) { this._closeCallbacks.splice(index, 1); }
    } else {
        this._removeListener(name, listener);
    }
};

Node.prototype._removeAllListeners = Node.prototype.removeAllListeners;

Node.prototype.removeAllListeners = function (name) {
    if (name === "input") {
        this._inputCallback = null;
        this._inputCallbacks = null;
    } else if (name === "close") {
        this._closeCallbacks = [];
    } else {
        this._removeAllListeners(name);
    }
};

Node.prototype.close = function (removed) {
    const node = this;
    const promises = [];
    for (const callback of this._closeCallbacks) {
        if (callback.length > 0) {
            promises.push(new Promise((resolve) => {
                let resolved = false;
                const done = () => { if (!resolved) { resolved = true; resolve(); } };
                try {
                    const args = callback.length === 2 ? [!!removed, done] : [done];
                    callback.apply(node, args);
                } catch (err) { done(); }
            }));
        } else {
            try { callback.call(node); } catch (err) { /* ignore */ }
        }
    }
    const cleanup = () => {
        this.removeAllListeners("input");
        if (this._context) {
            return this._flow.contexts.deleteNodeContext(this.id, this.z);
        }
        return Promise.resolve();
    };
    if (promises.length > 0) {
        return Promise.all(promises).then(cleanup);
    }
    return Promise.resolve(cleanup());
};

Node.prototype.send = function (msg) {
    let msgSent = false;

    if (msg === null || typeof msg === "undefined") {
        return;
    } else if (!Array.isArray(msg)) {
        if (typeof msg !== "object") {
            this.error("Non-message returned: " + typeof msg);
            return;
        }
        if (this._wire) {
            if (!msg._msgid) { msg._msgid = redUtil.generateId(); }
            this._flow.send([{
                msg,
                source: { id: this.id, node: this, port: 0 },
                destination: { id: this._wire, node: undefined },
                cloneMessage: false
            }]);
            return;
        }
        msg = [msg];
    }

    const numOutputs = this.wires.length;
    const sendEvents = [];
    let sentMessageId = null;
    let hasMissingIds = false;

    for (let i = 0; i < numOutputs; i++) {
        const wires = this.wires[i];
        if (i < msg.length) {
            let msgs = msg[i];
            if (msgs !== null && typeof msgs !== "undefined") {
                if (!Array.isArray(msgs)) { msgs = [msgs]; }
                for (let j = 0; j < wires.length; j++) {
                    for (let k = 0; k < msgs.length; k++) {
                        const m = msgs[k];
                        if (m !== null && m !== undefined) {
                            if (typeof m !== "object") {
                                this.error("Non-message returned: " + typeof m);
                            } else {
                                if (!m._msgid) { hasMissingIds = true; }
                                if (!sentMessageId) { sentMessageId = m._msgid; }
                                sendEvents.push({
                                    msg: m,
                                    source: { id: this.id, node: this, port: i },
                                    destination: { id: wires[j], node: undefined },
                                    cloneMessage: msgSent
                                });
                                msgSent = true;
                            }
                        }
                    }
                }
            }
        }
    }
    if (!sentMessageId) { sentMessageId = redUtil.generateId(); }
    if (hasMissingIds) {
        for (const ev of sendEvents) {
            if (!ev.msg._msgid) { ev.msg._msgid = sentMessageId; }
        }
    }
    this._flow.send(sendEvents);
};

Node.prototype.receive = function (msg) {
    if (!msg) { msg = {}; }
    if (!msg._msgid) { msg._msgid = redUtil.generateId(); }
    this.emit("input", msg);
};

function log_helper(self, level, msg) {
    const o = { level, id: self.id, type: self.type, msg };
    if (self.z) { o.z = self.z; }
    if (self.name) { o.name = self.name; }
    if (self._flow) {
        self._flow.log(o);
    } else {
        Log.log(o);
    }
}

Node.prototype.log = function (msg) { log_helper(this, Log.INFO, msg); };
Node.prototype.warn = function (msg) { log_helper(this, Log.WARN, msg); };
Node.prototype.debug = function (msg) { log_helper(this, Log.DEBUG, msg); };
Node.prototype.trace = function (msg) { log_helper(this, Log.TRACE, msg); };

Node.prototype.error = function (logMessage, msg) {
    if (typeof logMessage !== "boolean") { logMessage = logMessage || ""; }
    let handled = false;
    if (this._flow && msg && typeof msg === "object") {
        handled = this._flow.handleError(this, logMessage, msg);
    }
    if (!handled) {
        log_helper(this, Log.ERROR, logMessage);
    }
};

Node.prototype.metric = function (eventname) {
    if (typeof eventname === "undefined") { return false; }
};

Node.prototype.status = function (status) {
    switch (typeof status) {
        case "string":
        case "number":
        case "boolean":
            status = { text: "" + status };
    }
    this._flow.handleStatus(this, status);
};

module.exports = Node;
