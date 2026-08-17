/**
 * Credential handling for the standalone runtime.
 *
 * Two sources are supported:
 *  - credentials.json next to the generated project: plaintext { nodeId: { key: value } }
 *  - an encrypted Node-RED flows_cred.json, decrypted when settings.credentialSecret
 *    is set (Node-RED uses aes-256-ctr with a sha256 of the secret as the key).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function decryptSecret(secret, encrypted) {
    const data = Buffer.from(encrypted, "base64");
    const iv = data.subarray(0, 16);
    const ciphertext = data.subarray(16);
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

class Credentials {
    constructor() {
        this.map = {};
    }

    /**
     * @param userDir  project directory containing credentials.json / flows_cred.json
     * @param secret   settings.credentialSecret (may be undefined)
     * @param log      logger with warn()
     */
    load(userDir, secret, log) {
        const plainFile = path.join(userDir, "credentials.json");
        if (fs.existsSync(plainFile)) {
            try {
                this.map = JSON.parse(fs.readFileSync(plainFile, "utf8"));
            } catch (err) {
                log.warn(`Failed to parse credentials.json: ${err.message}`);
            }
            return;
        }
        const credFile = path.join(userDir, "flows_cred.json");
        if (fs.existsSync(credFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(credFile, "utf8"));
                if (data.$) {
                    if (!secret) {
                        log.warn("flows_cred.json is encrypted; set credentialSecret in settings.js " +
                                 "(or the NR_CREDENTIAL_SECRET env var) to decrypt it");
                    } else {
                        this.map = decryptSecret(secret, data.$);
                    }
                } else {
                    this.map = data;
                }
            } catch (err) {
                log.warn(`Failed to load flows_cred.json: ${err.message}`);
            }
        }
    }

    get(nodeId) {
        return this.map[nodeId];
    }
}

module.exports = { Credentials };
