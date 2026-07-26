/**
 * Guest-side helper for publishing sharded plugin records without allowing an
 * old manifest to resolve to new body rows. Keep this function self-contained:
 * its source is installed in the V3 iframe by factory.ts.
 */
export function createPluginStorageGenerationHelpers(
    storage: {
        getWithRevision(key: string, unloadSignal?: AbortSignal): Promise<
            | { status: "missing"; value: null; revision: null; generation: string | null }
            | { status: "value"; value: unknown; revision: string; generation: string | null }
        >;
        atomicBatch(
            operations: readonly (
                | { type: "set"; key: string; value: unknown; expectedRevision?: string | null }
                | { type: "remove"; key: string; expectedRevision?: string | null }
            )[],
            unloadSignal?: AbortSignal,
        ): Promise<
            | { committed: true; generation: string; revisions: { key: string; revision: string | null }[] }
            | { committed: false; conflicts: { key: string; revision: string | null; generation: string | null }[] }
        >;
    },
    snapshotBatch: (operations: unknown) => unknown[],
    cryptoApi: Pick<Crypto, "randomUUID" | "subtle">,
) {
    const HEAD_PROTOCOL = "risu-plugin-generation-head-v1";
    const REPOSITORY_PROTOCOL = "risu-plugin-generation-repository-v1";
    const MANIFEST_PROTOCOL = "risu-plugin-generation-manifest-v1";
    const BODY_PROTOCOL = "risu-plugin-generation-body-v1";
    const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

    type GenerationReference = {
        generation: string;
        manifestKey: string;
        manifestHash: string;
        repositoryHash: string;
    };

    type GenerationRepository = {
        protocol: typeof REPOSITORY_PROTOCOL;
        headKey: string;
        bodyKeyPrefix: string;
        repositoryHash: string;
    };

    type GenerationHead = {
        protocol: typeof HEAD_PROTOCOL;
        repository: GenerationRepository;
        current: GenerationReference;
        previous: GenerationReference | null;
        headHash: string;
    };

    type GenerationEntry = {
        id: string;
        key: string;
        hash: string;
        count: number;
    };

    type GenerationManifest = {
        protocol: typeof MANIFEST_PROTOCOL;
        repository: GenerationRepository;
        generation: string;
        previous: GenerationReference | null;
        entries: GenerationEntry[];
        totalCount: number;
    };

    const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
    const exactKeys = (value: object, keys: readonly string[]) => {
        const actual = Object.keys(value).sort();
        const expected = [...keys].sort();
        return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
    };
    const isObject = (value: unknown): value is Record<string, unknown> => (
        value !== null && typeof value === "object" && !Array.isArray(value)
    );
    const readRecord = (
        value: unknown,
        required: readonly string[],
        optional: readonly string[],
        label: string,
    ): Record<string, unknown> => {
        if (!isObject(value)
            || (Reflect.getPrototypeOf(value) !== Object.prototype
                && Reflect.getPrototypeOf(value) !== null)) {
            throw new TypeError(`${label} must be a plain object.`);
        }
        const allowed = new Set([...required, ...optional]);
        const output = Object.create(null) as Record<string, unknown>;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string" || !allowed.has(key)) {
                throw new TypeError(`${label} has an invalid property.`);
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                throw new TypeError(`${label}.${key} must be an enumerable data property.`);
            }
            output[key] = descriptor.value;
        }
        for (const key of required) {
            if (!own(output, key)) throw new TypeError(`${label}.${key} is required.`);
        }
        return output;
    };
    const isReference = (value: unknown): value is GenerationReference => (
        isObject(value)
        && exactKeys(value, ["generation", "manifestKey", "manifestHash", "repositoryHash"])
        && typeof value.generation === "string"
        && GENERATION_PATTERN.test(value.generation)
        && typeof value.manifestKey === "string"
        && value.manifestKey.length > 0
        && typeof value.manifestHash === "string"
        && HASH_PATTERN.test(value.manifestHash)
        && typeof value.repositoryHash === "string"
        && HASH_PATTERN.test(value.repositoryHash)
    );
    const isRepository = (value: unknown): value is GenerationRepository => (
        isObject(value)
        && exactKeys(value, ["protocol", "headKey", "bodyKeyPrefix", "repositoryHash"])
        && value.protocol === REPOSITORY_PROTOCOL
        && typeof value.headKey === "string"
        && value.headKey.length > 0
        && typeof value.bodyKeyPrefix === "string"
        && value.bodyKeyPrefix.length > 0
        && !value.bodyKeyPrefix.endsWith("/")
        && typeof value.repositoryHash === "string"
        && HASH_PATTERN.test(value.repositoryHash)
    );
    const sameReference = (
        left: GenerationReference | null,
        right: GenerationReference | null,
    ): boolean => left === null || right === null
        ? left === right
        : left.generation === right.generation
            && left.manifestKey === right.manifestKey
            && left.manifestHash === right.manifestHash
            && left.repositoryHash === right.repositoryHash;
    const cloneReference = (value: GenerationReference): GenerationReference => ({
        generation: value.generation,
        manifestKey: value.manifestKey,
        manifestHash: value.manifestHash,
        repositoryHash: value.repositoryHash,
    });

    const stableStringify = (value: unknown): string => {
        if (value === null || typeof value === "boolean" || typeof value === "string") {
            return JSON.stringify(value);
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new TypeError("Generation values require finite numbers.");
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(",")}]`;
        }
        if (!isObject(value)) throw new TypeError("Generation values must be JSON values.");
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${stableStringify(value[key])}`
        )).join(",")}}`;
    };
    const hashValue = async (value: unknown): Promise<string> => {
        const bytes = new TextEncoder().encode(stableStringify(value));
        const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
        return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    const snapshotValue = (value: unknown): unknown => {
        const operation = snapshotBatch([{ type: "set", key: "generation-snapshot", value }])[0] as {
            value: unknown;
        };
        return operation.value;
    };
    const assertString = (value: unknown, label: string): string => {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError(`${label} must be a non-empty string.`);
        }
        return value;
    };
    const bodyKey = (prefix: string, generation: string, hash: string) => (
        `${prefix}/body/${generation}/${hash.slice("sha256:".length)}`
    );
    const generationManifestKey = (prefix: string, generation: string) => (
        `${prefix}/manifest/${generation}`
    );
    const repositoryPayload = (
        headKey: string,
        bodyKeyPrefix: string,
    ): Omit<GenerationRepository, "repositoryHash"> => ({
        protocol: REPOSITORY_PROTOCOL,
        headKey,
        bodyKeyPrefix,
    });
    const createRepository = async (
        headKey: string,
        bodyKeyPrefix: string,
    ): Promise<GenerationRepository> => ({
        ...repositoryPayload(headKey, bodyKeyPrefix),
        repositoryHash: await hashValue(repositoryPayload(headKey, bodyKeyPrefix)),
    });
    const headPayload = (
        repository: GenerationRepository,
        current: GenerationReference,
        previous: GenerationReference | null,
    ): Omit<GenerationHead, "headHash"> => ({
        protocol: HEAD_PROTOCOL,
        repository,
        current,
        previous,
    });
    const corrupt = (message: string, cause?: unknown): Error => {
        const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
            code?: string;
        };
        error.name = "PluginStorageGenerationError";
        error.code = "PLUGIN_GENERATION_CORRUPT";
        return error;
    };
    const lineage = (message: string): Error => {
        const error = corrupt(message) as Error & { code?: string };
        error.code = "PLUGIN_GENERATION_LINEAGE_INVALID";
        return error;
    };
    const isCorrupt = (error: unknown): boolean => (
        isObject(error) && error.code === "PLUGIN_GENERATION_CORRUPT"
    );

    const validateRepository = async (
        value: unknown,
        requestedHeadKey?: string,
    ): Promise<GenerationRepository> => {
        if (!isRepository(value)
            || (requestedHeadKey !== undefined && value.headKey !== requestedHeadKey)
            || await hashValue(repositoryPayload(value.headKey, value.bodyKeyPrefix)) !== value.repositoryHash) {
            throw lineage("The generation repository identity is invalid.");
        }
        return {
            protocol: REPOSITORY_PROTOCOL,
            headKey: value.headKey,
            bodyKeyPrefix: value.bodyKeyPrefix,
            repositoryHash: value.repositoryHash,
        };
    };

    const validateHead = async (
        requestedHeadKey: string,
        value: unknown,
    ): Promise<GenerationHead> => {
        if (!isObject(value)
            || !exactKeys(value, ["protocol", "repository", "current", "previous", "headHash"])
            || value.protocol !== HEAD_PROTOCOL
            || !isReference(value.current)
            || (value.previous !== null && !isReference(value.previous))
            || typeof value.headHash !== "string"
            || !HASH_PATTERN.test(value.headHash)) {
            throw lineage("The generation head is invalid.");
        }
        const repository = await validateRepository(value.repository, requestedHeadKey);
        const current = value.current;
        const previous = value.previous as GenerationReference | null;
        if (current.repositoryHash !== repository.repositoryHash
            || current.manifestKey !== generationManifestKey(repository.bodyKeyPrefix, current.generation)
            || (previous !== null
                && (previous.repositoryHash !== repository.repositoryHash
                    || previous.manifestKey !== generationManifestKey(
                        repository.bodyKeyPrefix,
                        previous.generation,
                    )
                    || previous.generation === current.generation))
            || await hashValue(headPayload(repository, current, previous)) !== value.headHash) {
            throw lineage("The generation head does not belong to this repository.");
        }
        return {
            protocol: HEAD_PROTOCOL,
            repository,
            current: cloneReference(current),
            previous: previous === null ? null : cloneReference(previous),
            headHash: value.headHash as string,
        };
    };

    const validateManifest = async (
        reference: GenerationReference,
        repository: GenerationRepository,
        value: unknown,
        expectedPrevious?: GenerationReference | null,
    ): Promise<GenerationManifest> => {
        if (!isObject(value)
            || !exactKeys(value, [
                "protocol", "repository", "generation", "previous", "entries", "totalCount",
            ])
            || value.protocol !== MANIFEST_PROTOCOL
            || value.generation !== reference.generation
            || (value.previous !== null && !isReference(value.previous))
            || !Array.isArray(value.entries)
            || value.entries.length < 1
            || value.entries.length > 126
            || !Number.isSafeInteger(value.totalCount)
            || (value.totalCount as number) < 0) {
            throw corrupt(`Generation ${reference.generation} has an invalid manifest.`);
        }
        const manifestRepository = await validateRepository(value.repository);
        const manifestPrevious = value.previous as GenerationReference | null;
        if (manifestRepository.repositoryHash !== repository.repositoryHash
            || manifestRepository.headKey !== repository.headKey
            || manifestRepository.bodyKeyPrefix !== repository.bodyKeyPrefix
            || reference.repositoryHash !== repository.repositoryHash
            || reference.manifestKey !== generationManifestKey(
                repository.bodyKeyPrefix,
                reference.generation,
            )
            || (manifestPrevious !== null
                && (manifestPrevious.repositoryHash !== repository.repositoryHash
                    || manifestPrevious.manifestKey !== generationManifestKey(
                        repository.bodyKeyPrefix,
                        manifestPrevious.generation,
                    )))
            || (expectedPrevious !== undefined
                && !sameReference(manifestPrevious, expectedPrevious))) {
            throw lineage(`Generation ${reference.generation} has an invalid lineage.`);
        }
        const entries: GenerationEntry[] = [];
        const ids = new Set<string>();
        const keys = new Set<string>();
        let totalCount = 0;
        for (const raw of value.entries) {
            const expectedBodyKey = bodyKey(repository.bodyKeyPrefix, reference.generation,
                typeof raw === "object" && raw !== null && "hash" in raw && typeof raw.hash === "string"
                    ? raw.hash
                    : ""
            );
            if (!isObject(raw)
                || !exactKeys(raw, ["id", "key", "hash", "count"])
                || typeof raw.id !== "string"
                || raw.id.length === 0
                || typeof raw.key !== "string"
                || raw.key.length === 0
                || typeof raw.hash !== "string"
                || !HASH_PATTERN.test(raw.hash)
                || !Number.isSafeInteger(raw.count)
                || (raw.count as number) < 0
                || raw.key !== expectedBodyKey
                || ids.has(raw.id)
                || keys.has(raw.key)) {
                throw corrupt(`Generation ${reference.generation} has an invalid manifest entry.`);
            }
            ids.add(raw.id);
            keys.add(raw.key);
            totalCount += raw.count as number;
            if (!Number.isSafeInteger(totalCount)) {
                throw corrupt(`Generation ${reference.generation} has an invalid aggregate count.`);
            }
            entries.push({
                id: raw.id,
                key: raw.key,
                hash: raw.hash,
                count: raw.count as number,
            });
        }
        if (totalCount !== value.totalCount) {
            throw corrupt(`Generation ${reference.generation} count does not match its manifest.`);
        }
        if (await hashValue(value) !== reference.manifestHash) {
            throw corrupt(`Generation ${reference.generation} manifest hash does not match.`);
        }
        return {
            protocol: MANIFEST_PROTOCOL,
            repository: manifestRepository,
            generation: reference.generation,
            previous: manifestPrevious === null ? null : cloneReference(manifestPrevious),
            entries,
            totalCount: value.totalCount as number,
        };
    };

    const readManifest = async (
        reference: GenerationReference,
        repository: GenerationRepository,
        signal?: AbortSignal,
        expectedPrevious?: GenerationReference | null,
    ) => {
        const manifestState = await storage.getWithRevision(reference.manifestKey, signal);
        if (manifestState.status !== "value") {
            throw corrupt(`Generation ${reference.generation} manifest is missing.`);
        }
        const manifest = await validateManifest(
            reference,
            repository,
            manifestState.value,
            expectedPrevious,
        );
        return { manifest, manifestState };
    };

    const loadBodies = async (
        reference: GenerationReference,
        repository: GenerationRepository,
        manifest: GenerationManifest,
        signal?: AbortSignal,
    ) => {
        const bodies = [] as { id: string; count: number; value: unknown }[];
        for (const entry of manifest.entries) {
            const state = await storage.getWithRevision(entry.key, signal);
            if (state.status !== "value" || !isObject(state.value)) {
                throw corrupt(`Generation ${reference.generation} body ${entry.id} is missing.`);
            }
            const body = state.value;
            if (!exactKeys(body, [
                "protocol", "repositoryHash", "generation", "id", "hash", "count", "value",
            ])
                || body.protocol !== BODY_PROTOCOL
                || body.repositoryHash !== repository.repositoryHash
                || body.generation !== reference.generation
                || body.id !== entry.id
                || body.hash !== entry.hash
                || body.count !== entry.count
                || await hashValue({
                    repositoryHash: repository.repositoryHash,
                    id: body.id,
                    count: body.count,
                    value: body.value,
                }) !== entry.hash) {
                throw corrupt(`Generation ${reference.generation} body ${entry.id} failed verification.`);
            }
            bodies.push({ id: entry.id, count: entry.count, value: body.value });
        }
        return { generation: reference.generation, bodies, totalCount: manifest.totalCount };
    };

    return Object.freeze({
        /**
         * Publishes bodies, their immutable manifest, and the mutable head in
         * one AA3 transaction. No generation key is ever reused.
         */
        async publish(options: {
            manifestKey: string;
            bodyKeyPrefix: string;
            bodies: readonly { id: string; count: number; value: unknown }[];
            expectedRevision?: string | null;
            unloadSignal?: AbortSignal;
        }) {
            // Detach the whole plan before the first await so accessors or
            // concurrent plugin tasks cannot change what is hashed/published.
            const optionValues = readRecord(
                options,
                ["manifestKey", "bodyKeyPrefix", "bodies"],
                ["expectedRevision", "unloadSignal"],
                "Generation publish options",
            );
            const manifestKey = assertString(optionValues.manifestKey, "manifestKey");
            let prefix = assertString(optionValues.bodyKeyPrefix, "bodyKeyPrefix");
            while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
            if (prefix.length === 0) {
                throw new TypeError("bodyKeyPrefix must not normalize to an empty prefix.");
            }
            const unloadSignal = optionValues.unloadSignal as AbortSignal | undefined;
            const inputBodies = optionValues.bodies;
            if (!Array.isArray(inputBodies)
                || Reflect.getPrototypeOf(inputBodies) !== Array.prototype
                || inputBodies.length < 1
                || inputBodies.length > 126
                || Reflect.ownKeys(inputBodies).length !== inputBodies.length + 1) {
                throw new RangeError("Generation publish requires 1-126 bodies.");
            }
            const preparedBodies: { id: string; count: number; value: unknown }[] = [];
            const ids = new Set<string>();
            let totalCount = 0;
            for (let index = 0; index < inputBodies.length; index += 1) {
                const descriptor = Reflect.getOwnPropertyDescriptor(inputBodies, String(index));
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                    throw new TypeError(`Generation bodies[${index}] must be an enumerable data property.`);
                }
                const raw = readRecord(
                    descriptor.value,
                    ["id", "count", "value"],
                    [],
                    `Generation bodies[${index}]`,
                );
                const id = assertString(raw.id, "body.id");
                if (ids.has(id)) throw new TypeError(`Duplicate generation body id ${id}.`);
                ids.add(id);
                if (!Number.isSafeInteger(raw.count) || (raw.count as number) < 0) {
                    throw new TypeError(`Generation body ${id} has an invalid count.`);
                }
                const count = raw.count as number;
                totalCount += count;
                if (!Number.isSafeInteger(totalCount)) throw new RangeError("Generation total count is too large.");
                preparedBodies.push({ id, count, value: snapshotValue(raw.value) });
            }
            const expectedRevision = optionValues.expectedRevision;
            if (own(optionValues, "expectedRevision")
                && expectedRevision !== null
                && (typeof expectedRevision !== "string" || !HASH_PATTERN.test(expectedRevision))) {
                throw new TypeError("Generation publish expectedRevision is invalid.");
            }
            const repository = await createRepository(manifestKey, prefix);
            const priorState = await storage.getWithRevision(manifestKey, unloadSignal);
            const priorHead = priorState.status === "value"
                ? await validateHead(manifestKey, priorState.value)
                : null;
            if (priorHead !== null
                && (priorHead.repository.repositoryHash !== repository.repositoryHash
                    || priorHead.repository.bodyKeyPrefix !== prefix)) {
                throw lineage("The requested body prefix does not match the existing repository.");
            }
            let verifiedPrevious: GenerationReference | null = null;
            if (priorHead !== null) {
                try {
                    const current = await readManifest(
                        priorHead.current,
                        repository,
                        unloadSignal,
                        priorHead.previous,
                    );
                    await loadBodies(
                        priorHead.current,
                        repository,
                        current.manifest,
                        unloadSignal,
                    );
                    verifiedPrevious = priorHead.current;
                } catch (currentError) {
                    // A corrupt generation must never become the new sole
                    // fallback. Lineage and I/O failures remain hard errors.
                    if (!isCorrupt(currentError) || priorHead.previous === null) {
                        throw currentError;
                    }
                    const previous = await readManifest(
                        priorHead.previous,
                        repository,
                        unloadSignal,
                    );
                    await loadBodies(
                        priorHead.previous,
                        repository,
                        previous.manifest,
                        unloadSignal,
                    );
                    verifiedPrevious = priorHead.previous;
                }
            }
            if (own(optionValues, "expectedRevision") && expectedRevision !== priorState.revision) {
                return {
                    committed: false as const,
                    conflicts: [{
                        key: manifestKey,
                        revision: priorState.revision,
                        generation: priorState.generation,
                    }],
                };
            }

            const generation = cryptoApi.randomUUID();
            if (!GENERATION_PATTERN.test(generation)) {
                throw new Error("crypto.randomUUID() returned an invalid generation identifier.");
            }
            const entries: GenerationEntry[] = [];
            const bodyOperations: { type: "set"; key: string; value: unknown; expectedRevision: null }[] = [];
            for (const { id, count, value } of preparedBodies) {
                const hash = await hashValue({
                    repositoryHash: repository.repositoryHash,
                    id,
                    count,
                    value,
                });
                const key = bodyKey(prefix, generation, hash);
                entries.push({ id, key, hash, count });
                bodyOperations.push({
                    type: "set",
                    key,
                    value: {
                        protocol: BODY_PROTOCOL,
                        repositoryHash: repository.repositoryHash,
                        generation,
                        id,
                        hash,
                        count,
                        value,
                    },
                    expectedRevision: null,
                });
            }
            if (new Set(entries.map(entry => entry.key)).size !== entries.length) {
                throw new Error("Generation body hash collision detected.");
            }
            const previous = verifiedPrevious;
            const manifest: GenerationManifest = {
                protocol: MANIFEST_PROTOCOL,
                repository,
                generation,
                previous,
                entries,
                totalCount,
            };
            const reference: GenerationReference = {
                generation,
                manifestKey: generationManifestKey(prefix, generation),
                manifestHash: await hashValue(manifest),
                repositoryHash: repository.repositoryHash,
            };
            const head: GenerationHead = {
                ...headPayload(repository, reference, previous),
                headHash: await hashValue(headPayload(repository, reference, previous)),
            };
            const operations = [
                ...bodyOperations,
                { type: "set" as const, key: reference.manifestKey, value: manifest, expectedRevision: null },
                {
                    type: "set" as const,
                    key: manifestKey,
                    value: head,
                    expectedRevision: priorState.revision,
                },
            ];
            const result = await storage.atomicBatch(
                operations,
                unloadSignal,
            );
            if (result.committed === false) return result;
            return {
                ...result,
                current: reference,
                previous,
            };
        },

        /** Loads only a fully verified generation, falling back once to the prior one. */
        async load(manifestKeyInput: string, unloadSignal?: AbortSignal) {
            const manifestKey = assertString(manifestKeyInput, "manifestKey");
            const headState = await storage.getWithRevision(manifestKey, unloadSignal);
            if (headState.status === "missing") {
                return { status: "missing" as const, value: null, revision: null };
            }
            const head = await validateHead(manifestKey, headState.value);
            try {
                // A readable manifest must agree with the head before its
                // previous reference is eligible for fallback. Lineage errors
                // use a distinct code and are never caught below.
                const current = await readManifest(
                    head.current,
                    head.repository,
                    unloadSignal,
                    head.previous,
                );
                const value = await loadBodies(
                    head.current,
                    head.repository,
                    current.manifest,
                    unloadSignal,
                );
                return {
                    status: "value" as const,
                    value,
                    revision: headState.revision,
                    recoveredFromPrevious: false,
                };
            } catch (currentError) {
                // Transport/auth/import failures are not evidence of corruption
                // and must never silently select an older repository.
                if (!isCorrupt(currentError)) throw currentError;
                if (head.previous === null) throw currentError;
                try {
                    const previous = await readManifest(
                        head.previous,
                        head.repository,
                        unloadSignal,
                    );
                    const value = await loadBodies(
                        head.previous,
                        head.repository,
                        previous.manifest,
                        unloadSignal,
                    );
                    return {
                        status: "value" as const,
                        value,
                        revision: headState.revision,
                        recoveredFromPrevious: true,
                    };
                } catch (previousError) {
                    if (!isCorrupt(previousError)) throw previousError;
                    throw corrupt("Neither the current nor previous generation passed verification.", {
                        currentError,
                        previousError,
                    });
                }
            }
        },

        /**
         * Removes a retired immutable generation after publication. The
         * current and immediately previous generations are always retained.
         */
        async garbageCollect(options: {
            manifestKey: string;
            generation: GenerationReference;
            unloadSignal?: AbortSignal;
        }) {
            const optionValues = readRecord(
                options,
                ["manifestKey", "generation"],
                ["unloadSignal"],
                "Generation garbage collection options",
            );
            const referenceValues = readRecord(
                optionValues.generation,
                ["generation", "manifestKey", "manifestHash", "repositoryHash"],
                [],
                "Generation garbage collection reference",
            );
            const retired = {
                generation: referenceValues.generation,
                manifestKey: referenceValues.manifestKey,
                manifestHash: referenceValues.manifestHash,
                repositoryHash: referenceValues.repositoryHash,
            };
            if (!isReference(retired)) {
                throw new TypeError("Generation garbage collection requires a valid generation reference.");
            }
            const manifestKey = assertString(optionValues.manifestKey, "manifestKey");
            const unloadSignal = optionValues.unloadSignal as AbortSignal | undefined;
            const headState = await storage.getWithRevision(manifestKey, unloadSignal);
            if (headState.status !== "value") {
                throw corrupt("A valid generation head is required before garbage collection.");
            }
            const head = await validateHead(manifestKey, headState.value);
            if (retired.repositoryHash !== head.repository.repositoryHash) {
                throw lineage("The retired generation belongs to another repository.");
            }
            if (sameReference(retired, head.current)
                || sameReference(retired, head.previous)) {
                throw new Error("The current and previous generations cannot be garbage-collected.");
            }
            const current = await readManifest(
                head.current,
                head.repository,
                unloadSignal,
                head.previous,
            );
            let cursor = current.manifest.previous;
            let retiredManifest: Awaited<ReturnType<typeof readManifest>> | null = null;
            for (let depth = 0; cursor !== null && depth < 1_024; depth += 1) {
                const candidate = await readManifest(cursor, head.repository, unloadSignal);
                if (sameReference(cursor, retired)) {
                    retiredManifest = candidate;
                    break;
                }
                cursor = candidate.manifest.previous;
            }
            if (retiredManifest === null) {
                throw lineage("The retired generation is not in this repository's verified lineage.");
            }
            const { manifest, manifestState } = retiredManifest;
            const operations = [
                ...manifest.entries.map(entry => ({
                    type: "remove" as const,
                    key: entry.key,
                })),
                { type: "remove" as const, key: retired.manifestKey, expectedRevision: manifestState.revision },
                {
                    type: "set" as const,
                    key: manifestKey,
                    value: head,
                    expectedRevision: headState.revision,
                },
            ];
            const result = await storage.atomicBatch(operations, unloadSignal);
            return result.committed ? { ...result, removed: true as const } : result;
        },
    });
}
