"use strict";

function unitMilliseconds(unit) {
    switch (String(unit || "seconds").toLowerCase()) {
    case "millisecond":
    case "milliseconds":
    case "ms":
        return 1;
    case "minute":
    case "minutes":
        return 60 * 1000;
    case "hour":
    case "hours":
        return 60 * 60 * 1000;
    case "second":
    case "seconds":
    case "s":
    default:
        return 1000;
    }
}

function asBoolean(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function deliver(send, done, msg) {
    try {
        send(msg);
        done();
    } catch (err) {
        done(err);
    }
}

module.exports = {
    type: "delay",
    requires: [],
    register(runtime) {
        runtime.registerNode("delay", (node, config) => {
            const pauseType = config.pauseType || "delay";
            if (pauseType !== "delay" && pauseType !== "rate") {
                throw new Error("不支持的 pauseType");
            }

            if (pauseType === "delay") {
                const timers = new Set();
                let closed = false;
                const timeout = Number(config.timeout);
                const delay = Number.isFinite(timeout) ? Math.max(0, timeout) * unitMilliseconds(config.timeoutUnits) : 0;

                node.onClose(() => {
                    closed = true;
                    for (const timer of timers) { clearTimeout(timer); }
                    timers.clear();
                });

                return {
                    input(msg, send, done) {
                        if (closed) { return; }
                        const timer = setTimeout(() => {
                            timers.delete(timer);
                            if (!closed) { deliver(send, done, msg); }
                        }, delay);
                        timers.add(timer);
                    }
                };
            }

            const rate = Number(config.rate);
            const numberOfUnits = Number(config.nbRateUnits || 1);
            const interval = numberOfUnits * unitMilliseconds(config.rateUnits);
            if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(interval) || interval <= 0) {
                throw new Error("rate must be greater than zero");
            }

            const drop = asBoolean(config.drop);
            const queue = [];
            const capacity = rate;
            let tokens = capacity;
            let lastRefill = Date.now();
            let timer = null;
            let closed = false;

            const refill = () => {
                const now = Date.now();
                tokens = Math.min(capacity, tokens + ((now - lastRefill) * rate / interval));
                lastRefill = now;
            };
            const schedulePump = () => {
                if (closed || timer || queue.length === 0) { return; }
                refill();
                const wait = Math.max(1, Math.ceil((1 - tokens) * interval / rate));
                timer = setTimeout(() => {
                    timer = null;
                    pump();
                }, wait);
            };
            const pump = () => {
                if (closed) { return; }
                refill();
                while (queue.length > 0 && tokens >= 1) {
                    tokens -= 1;
                    const item = queue.shift();
                    deliver(item.send, item.done, item.msg);
                    refill();
                }
                schedulePump();
            };

            node.onClose(() => {
                closed = true;
                queue.length = 0;
                if (timer) { clearTimeout(timer); timer = null; }
            });

            return {
                input(msg, send, done) {
                    if (closed) { return; }
                    refill();
                    if (tokens >= 1) {
                        tokens -= 1;
                        deliver(send, done, msg);
                    } else if (!drop) {
                        queue.push({ msg, send, done });
                        schedulePump();
                    }
                }
            };
        });
    }
};
