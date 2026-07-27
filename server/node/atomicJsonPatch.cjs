'use strict';

const { JsonPatchError, applyOperation, deepClone } = require('fast-json-patch');

const MUTATING_OPERATIONS = new Set(['add', 'remove', 'replace', 'move', 'copy']);

function cloneContainer(value) {
    if (Array.isArray(value)) return value.slice();
    if (value !== null && typeof value === 'object') return { ...value };
    return value;
}

function pointerSegments(pointer) {
    return pointer.slice(1).split('/').map(segment => (
        segment.replace(/~1/g, '/').replace(/~0/g, '~')
    ));
}

function arrayIndex(key, length) {
    if (key === '-') return length;
    for (let index = 0; index < key.length; index++) {
        const code = key.charCodeAt(index);
        if (code < 48 || code > 57) return key;
    }
    return ~~key;
}

function isUnsafePointerSegment(segments, index) {
    return segments[index] === '__proto__'
        || (segments[index] === 'prototype' && segments[index - 1] === 'constructor');
}

// The root is already private. Copy each traversed container before the patch
// library can mutate its final parent; untouched branches remain shared.
function cloneMutationParents(document, pointer) {
    if (typeof pointer !== 'string' || pointer === '' || pointer[0] !== '/') return;
    const segments = pointerSegments(pointer);
    let parent = document;
    for (let index = 0; index < segments.length - 1; index++) {
        if (parent === null || typeof parent !== 'object') return;
        if (isUnsafePointerSegment(segments, index)) return;
        const key = Array.isArray(parent)
            ? arrayIndex(segments[index], parent.length)
            : segments[index];
        const child = parent[key];
        if (child === null || typeof child !== 'object') return;
        const clonedChild = cloneContainer(child);
        parent[key] = clonedChild;
        parent = clonedChild;
    }
}

function applyPatchAtomic(document, patch) {
    if (!Array.isArray(patch)) {
        throw new JsonPatchError('Patch sequence must be an array', 'SEQUENCE_NOT_AN_ARRAY');
    }

    const hasMutation = patch.some(operation => (
        operation && MUTATING_OPERATIONS.has(operation.op)
    ));
    let nextDocument = hasMutation ? cloneContainer(document) : document;
    const results = new Array(patch.length);

    for (let index = 0; index < patch.length; index++) {
        const operation = patch[index];
        if (operation && MUTATING_OPERATIONS.has(operation.op)) {
            if (operation.op === 'move') {
                cloneMutationParents(nextDocument, operation.from);
            }
            cloneMutationParents(nextDocument, operation.path);
        }
        results[index] = applyOperation(nextDocument, operation, true, true, true, index);
        nextDocument = results[index].newDocument;

        // A root copy/move returns the referenced object itself. The whole
        // referenced subtree is the operation's payload, so copy it fully to
        // keep later ops and post-patch normalization isolated from the source.
        if (operation && operation.path === ''
            && (operation.op === 'copy' || operation.op === 'move')) {
            nextDocument = deepClone(nextDocument);
            results[index].newDocument = nextDocument;
        }
    }

    results.newDocument = nextDocument;
    return results;
}

module.exports = { applyPatchAtomic };
