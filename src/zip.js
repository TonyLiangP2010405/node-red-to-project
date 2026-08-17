"use strict";

const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1
            ? 0xedb88320 ^ (value >>> 1)
            : value >>> 1;
    }
    CRC32_TABLE[index] = value >>> 0;
}

function crc32(data) {
    let value = 0xffffffff;
    for (const byte of data) {
        value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function toBuffer(data) {
    if (typeof data === "string") {
        return Buffer.from(data, "utf8");
    }
    if (Buffer.isBuffer(data)) {
        return data;
    }
    throw new TypeError("ZIP file data must be a string or Buffer");
}

function createZip(files) {
    if (!Array.isArray(files)) {
        throw new TypeError("ZIP files must be an array");
    }
    if (files.length > MAX_UINT16) {
        throw new RangeError("ZIP file count exceeds the classic ZIP limit");
    }

    const localChunks = [];
    const centralEntries = [];
    let localOffset = 0;

    for (const file of files) {
        if (!file || typeof file.path !== "string") {
            throw new TypeError("ZIP file path must be a string");
        }

        const name = Buffer.from(file.path, "utf8");
        const data = toBuffer(file.data);
        if (name.length > MAX_UINT16) {
            throw new RangeError("ZIP file path exceeds the classic ZIP limit");
        }
        if (data.length > MAX_UINT32) {
            throw new RangeError("ZIP file data exceeds the classic ZIP limit");
        }
        if (localOffset > MAX_UINT32) {
            throw new RangeError("ZIP archive exceeds the classic ZIP limit");
        }

        const checksum = crc32(data);
        const localHeader = Buffer.alloc(30 + name.length);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(UTF8_FLAG, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(DOS_TIME, 10);
        localHeader.writeUInt16LE(DOS_DATE, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);
        name.copy(localHeader, 30);

        localChunks.push(localHeader, data);

        const centralEntry = Buffer.alloc(46 + name.length);
        centralEntry.writeUInt32LE(0x02014b50, 0);
        centralEntry.writeUInt16LE(20, 4);
        centralEntry.writeUInt16LE(20, 6);
        centralEntry.writeUInt16LE(UTF8_FLAG, 8);
        centralEntry.writeUInt16LE(0, 10);
        centralEntry.writeUInt16LE(DOS_TIME, 12);
        centralEntry.writeUInt16LE(DOS_DATE, 14);
        centralEntry.writeUInt32LE(checksum, 16);
        centralEntry.writeUInt32LE(data.length, 20);
        centralEntry.writeUInt32LE(data.length, 24);
        centralEntry.writeUInt16LE(name.length, 28);
        centralEntry.writeUInt16LE(0, 30);
        centralEntry.writeUInt16LE(0, 32);
        centralEntry.writeUInt16LE(0, 34);
        centralEntry.writeUInt16LE(0, 36);
        centralEntry.writeUInt32LE(0, 38);
        centralEntry.writeUInt32LE(localOffset, 42);
        name.copy(centralEntry, 46);
        centralEntries.push(centralEntry);

        localOffset += localHeader.length + data.length;
    }

    const centralDirectoryOffset = localOffset;
    const centralDirectory = Buffer.concat(centralEntries);
    if (centralDirectoryOffset > MAX_UINT32 || centralDirectory.length > MAX_UINT32) {
        throw new RangeError("ZIP central directory exceeds the classic ZIP limit");
    }

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(centralDirectoryOffset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat(
        [...localChunks, centralDirectory, endRecord],
        centralDirectoryOffset + centralDirectory.length + endRecord.length
    );
}

module.exports = { createZip };
