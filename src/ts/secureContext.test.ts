import { describe, expect, it } from 'vitest'
import { shouldBlockInsecureBoot } from './secureContext'

describe('shouldBlockInsecureBoot', () => {
    it.each([
        { isSecure: true, allowFlag: true, expected: false },
        { isSecure: true, allowFlag: false, expected: false },
        { isSecure: false, allowFlag: true, expected: false },
        { isSecure: false, allowFlag: false, expected: true },
    ])(
        'returns $expected when isSecure=$isSecure and allowFlag=$allowFlag',
        ({ isSecure, allowFlag, expected }) => {
            expect(shouldBlockInsecureBoot(isSecure, allowFlag)).toBe(expected)
        },
    )
})
