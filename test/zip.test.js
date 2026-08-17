"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { createZip } = require("../src/zip");

function readCentralDirectory(zip) {
    const eocdOffset = zip.length - 22;
    assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50);

    const entryCount = zip.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = zip.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);
    assert.equal(centralDirectoryOffset + centralDirectorySize, eocdOffset);

    const entries = [];
    let offset = centralDirectoryOffset;
    while (offset < eocdOffset) {
        assert.equal(zip.readUInt32LE(offset), 0x02014b50);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        entries.push({
            path: zip.toString("utf8", offset + 46, offset + 46 + nameLength),
            flags: zip.readUInt16LE(offset + 8),
            method: zip.readUInt16LE(offset + 10),
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    assert.equal(entries.length, entryCount);
    assert.equal(offset, eocdOffset);
    return entries;
}

test("creates an empty ZIP with a valid end record", () => {
    const zip = createZip([]);

    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.equal(zip.readUInt16LE(zip.length - 12), 0);
    assert.equal(zip.readUInt16LE(zip.length - 10), 0);
    assert.equal(zip.readUInt32LE(zip.length - 6), 0);
    assert.equal(zip.length, 22);
});

test("writes stored entries with UTF-8 names and the expected central directory", () => {
    const files = [
        { path: "flows/basic.js", data: "module.exports = 1;\n" },
        { path: "nested/中文.txt", data: Buffer.from("内容\n", "utf8") },
    ];
    const zip = createZip(files);
    const entries = readCentralDirectory(zip);

    assert.deepEqual(entries.map((entry) => entry.path), files.map((file) => file.path));
    assert.deepEqual(entries.map((entry) => entry.method), [0, 0]);
    assert.deepEqual(entries.map((entry) => entry.flags), [0x800, 0x800]);

    let localOffset = 0;
    for (const file of files) {
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
        assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
        assert.equal(zip.readUInt16LE(localOffset + 6), 0x800);
        assert.equal(zip.readUInt16LE(localOffset + 8), 0);
        const nameLength = zip.readUInt16LE(localOffset + 26);
        assert.equal(zip.toString("utf8", localOffset + 30, localOffset + 30 + nameLength), file.path);
        localOffset += 30 + nameLength + data.length;
    }
});

test("is accepted by unzip for nested, UTF-8, empty, and large files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-to-project-zip-"));
    const zipPath = path.join(root, "archive.zip");
    const extractDir = path.join(root, "extracted");
    const largeData = Buffer.alloc(3 * 1024 * 1024, 0xab);
    const files = [
        { path: "flows/basic.js", data: "module.exports = 'basic';\n" },
        { path: "nested/deep/中文.txt", data: "嵌套内容\n" },
        { path: "nested/marker.txt", data: "nested content\n" },
        { path: "empty.txt", data: "" },
        { path: "assets/large.bin", data: largeData },
    ];

    try {
        fs.mkdirSync(extractDir);
        fs.writeFileSync(zipPath, createZip(files));

        let unicodePathExtracted = true;
        try {
            execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "pipe" });
        } catch (error) {
            const diagnostic = `${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`;
            if (!/Illegal byte sequence|write error \(disk full\?\)|probably truncated/i.test(diagnostic)) {
                throw error;
            }

            unicodePathExtracted = false;
            fs.rmSync(extractDir, { recursive: true, force: true });
            fs.mkdirSync(extractDir);
            execFileSync(
                "unzip",
                [
                    "-o",
                    zipPath,
                    "flows/basic.js",
                    "nested/marker.txt",
                    "empty.txt",
                    "assets/large.bin",
                    "-d",
                    extractDir,
                ],
                { stdio: "pipe" }
            );
            assert.deepEqual(
                execFileSync("unzip", ["-p", zipPath, "nested/deep/*"], { stdio: "pipe" }),
                Buffer.from(files[1].data, "utf8")
            );
        }

        assert.equal(
            fs.readFileSync(path.join(extractDir, "flows", "basic.js"), "utf8"),
            files[0].data
        );
        assert.equal(
            fs.readFileSync(path.join(extractDir, "nested", "marker.txt"), "utf8"),
            files[2].data
        );
        if (unicodePathExtracted) {
            assert.equal(
                fs.readFileSync(path.join(extractDir, "nested", "deep", "中文.txt"), "utf8"),
                files[1].data
            );
        }
        assert.equal(fs.readFileSync(path.join(extractDir, "empty.txt"), "utf8"), "");
        assert.deepEqual(
            fs.readFileSync(path.join(extractDir, "assets", "large.bin")),
            largeData
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
