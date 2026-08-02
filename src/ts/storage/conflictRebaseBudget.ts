export const CONFLICT_REBASE_PREVIOUS_GRAPH_BOUND = 6;
export const CONFLICT_REBASE_GRAPH_BOUND = 3;

export type ConflictRebaseGraphRole =
    | "local-working"
    | "latest-authoritative-working"
    | "old-patcher-baseline"
    | "replacement-patcher-baseline";

export type ConflictRebaseGraphBudgetSample = {
    phase:
        | "candidate-decoded"
        | "old-codecs-retired"
        | "replacement-baseline-ready"
        | "authoritative-graph-installed";
    liveGraphs: readonly ConflictRebaseGraphRole[];
};

let testHook: ((sample: ConflictRebaseGraphBudgetSample) => void) | null = null;

export function recordConflictRebaseGraphBudget(
    sample: ConflictRebaseGraphBudgetSample,
): void {
    testHook?.(sample);
}

/** Test-only structural allocation hook used by the Track 6 budget scenario. */
export function setConflictRebaseGraphBudgetHookForTests(
    hook: ((sample: ConflictRebaseGraphBudgetSample) => void) | null,
): void {
    testHook = hook;
}
