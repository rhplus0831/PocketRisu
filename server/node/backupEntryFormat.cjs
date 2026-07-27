const {
    BACKUP_ENTRY_NAME_MAX_BYTES,
} = require('./pluginSaveKeys.cjs');

const BACKUP_ENTRY_DATA_MAX_BYTES = 0xffffffff;

function assertBackupEntryNameWithinLimit(name) {
    if (Buffer.byteLength(name, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new RangeError(
            `Backup entry name exceeds ${BACKUP_ENTRY_NAME_MAX_BYTES} UTF-8 bytes`,
        );
    }
}

function assertBackupEntrySizeWithinLimit(dataSize) {
    if (!Number.isSafeInteger(dataSize)
        || dataSize < 0
        || dataSize > BACKUP_ENTRY_DATA_MAX_BYTES) {
        throw new RangeError('Backup entry exceeds the 32-bit archive size limit');
    }
}

function encodeBackupEntryHeader(name, dataSize) {
    assertBackupEntryNameWithinLimit(name);
    assertBackupEntrySizeWithinLimit(dataSize);
    const encodedName = Buffer.from(name, 'utf-8');
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32LE(encodedName.length, 0);
    const dataLength = Buffer.allocUnsafe(4);
    dataLength.writeUInt32LE(dataSize, 0);
    return Buffer.concat([nameLength, encodedName, dataLength]);
}

function backupEntrySize(name, dataSize) {
    assertBackupEntryNameWithinLimit(name);
    assertBackupEntrySizeWithinLimit(dataSize);
    return 8 + Buffer.byteLength(name, 'utf-8') + dataSize;
}

function preflightBackupEntries(entries) {
    for (const entry of entries) {
        assertBackupEntryNameWithinLimit(entry.backupName);
        assertBackupEntrySizeWithinLimit(entry.size);
    }
}

module.exports = {
    BACKUP_ENTRY_DATA_MAX_BYTES,
    assertBackupEntryNameWithinLimit,
    assertBackupEntrySizeWithinLimit,
    encodeBackupEntryHeader,
    backupEntrySize,
    preflightBackupEntries,
};
