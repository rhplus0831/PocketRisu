// Feature-test this at module initialization: the browser build can run in
// WebViews older than String.prototype.isWellFormed(). Vite's target setting
// does not polyfill missing built-ins.
const nativeStringIsWellFormed = typeof String.prototype.isWellFormed === "function"
    ? String.prototype.isWellFormed
    : null;

export const hasNativeStringWellFormed = nativeStringIsWellFormed !== null;

export function isWellFormedUnicode(value: string): boolean {
    if (nativeStringIsWellFormed) {
        return nativeStringIsWellFormed.call(value);
    }

    for (let index = 0; index < value.length; index++) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
            if (index + 1 >= value.length) return false;
            const trailing = value.charCodeAt(index + 1);
            if (trailing < 0xDC00 || trailing > 0xDFFF) return false;
            index++;
        } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
            return false;
        }
    }
    return true;
}

export function assertWellFormedUnicode(value: string): void {
    if (!isWellFormedUnicode(value)) {
        throw new Error(
            `Plugin storage keys must be well-formed Unicode (no unpaired surrogates): ${JSON.stringify(value)}`,
        );
    }
}
