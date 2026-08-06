import { describe, expect, test } from 'vitest'
import backupEntryFormatPkg from './backupEntryFormat.cjs'

const {
  BACKUP_ENTRY_DATA_MAX_BYTES,
  assertBackupEntrySizeWithinLimit,
  encodeBackupEntryHeader,
  preflightBackupEntries,
} = backupEntryFormatPkg as {
  BACKUP_ENTRY_DATA_MAX_BYTES: number
  assertBackupEntrySizeWithinLimit: (size: number) => void
  encodeBackupEntryHeader: (name: string, size: number) => Buffer
  preflightBackupEntries: (
    entries: Array<{ backupName: string; size: number }>,
  ) => void
}

describe('backup entry 32-bit size boundary', () => {
  test('accepts exactly uint32 max without allocating its payload', () => {
    expect(BACKUP_ENTRY_DATA_MAX_BYTES).toBe(0xffffffff)
    expect(() => assertBackupEntrySizeWithinLimit(0xffffffff)).not.toThrow()
    expect(() => preflightBackupEntries([
      { backupName: 'database.risudat', size: 0xffffffff },
    ])).not.toThrow()

    const header = encodeBackupEntryHeader('database.risudat', 0xffffffff)
    expect(header.readUInt32LE(header.length - 4)).toBe(0xffffffff)
  })

  test('rejects uint32 max plus one deterministically during preflight', () => {
    expect(() => assertBackupEntrySizeWithinLimit(0x1_0000_0000)).toThrow(
      /32-bit archive size limit/,
    )
    expect(() => preflightBackupEntries([
      { backupName: 'oversized.bin', size: 0x1_0000_0000 },
    ])).toThrow(/32-bit archive size limit/)
    expect(() => encodeBackupEntryHeader('oversized.bin', 0x1_0000_0000)).toThrow(
      /32-bit archive size limit/,
    )
  })

  test('rejects duplicate planned names before archive emission', () => {
    expect(() => preflightBackupEntries([
      { backupName: 'inlay/x.meta.json', size: 1 },
      { backupName: 'inlay/x.meta.json', size: 2 },
    ])).toThrowError(expect.objectContaining({
      code: 'DUPLICATE_BACKUP_ENTRY',
      statusCode: 409,
    }))
  })
})
