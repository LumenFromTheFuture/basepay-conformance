# Reviewable patch — BasePayActionProvider conformance pass (invited)

Invited by osr21 (BasePay maintainer) in coinbase/agentkit#1141,
issuecomment-5392540482 (2026-08-24) and refined in
issuecomment-5402678431 (2026-08-24):

> "A reviewable patch with the catch regression, precise batch wording, and the
>  direct-path receipt checks would still be useful on its own merits."
> … "Please push the focused changes directly to your `feat/basepay-action-provider`
> branch so they update #1349 and run in the canonical CI."

## Status: SHIPPED (2026-08-25)

These three patches were applied to the rebased PR branch and are **already
pushed** as commit `15bdc2e31750874c6c618ea31b0dcfa87abbf8f3` on
`LumenFromTheFuture/agentkit` `feat/basepay-action-provider`, updating
[coinbase/agentkit PR #1349](https://github.com/coinbase/agentkit/pull/1349).
The copies below are the exact per-file diffs of that commit.

- Original (pre-rebase) PR head: `8380c34b9769cc255ff50d78b4ad2bafdd3de354`
- Rebased + fix head: `15bdc2e31750874c6c618ea31b0dcfa87abbf8f3`

## Contents

| Patch | File(s) | Purpose |
|---|---|---|
| `0001-fix-gasless-outer-catch.patch` | `typescript/agentkit/src/action-providers/basepay/basepayActionProvider.ts` | Fix FINDING-1: add the outer `catch` to `sendUsdcGasless` so pre-spend policy failures **resolve** to a classified failure string instead of rejecting the `invoke()` promise. Matches the shape of the other four actions; `recordPolicyOutcome(null, …)` is a no-op so policy receipts already recorded inside `checkPolicy` are not duplicated. |
| `0002-precise-batch-wording.patch` | `typescript/agentkit/src/policy/utils.ts` | Fix the `recipientAllocationHash` docstring per osr21's exact wording: *"order-insensitive (permutation is intentionally invisible); catches address substitution, amount changes, and redistribution"* — replaces the overstating "silent reordering" claim. |
| `0003-jest-regressions.patch` | `typescript/agentkit/src/action-providers/basepay/basepayActionProvider.test.ts` | Load-bearing regressions against the actual exported provider (the PR's own Jest suite). Five gasless policy-resolution cases per osr21's spec: `.resolves.toContain(<classification>)`, `signTypedData` AND `fetch` untouched, `record` called exactly once (outer catch does not duplicate the receipt emitted by `checkPolicy`). Receipt matrix not duplicated (existing Layer-2 cases already cover the four direct paths + gasless `[relay_confirmed]`). Plus a **white-box** cleanup regression: a post-gate failure after `checkPolicy` succeeds releases `pending` while `consumed` is intentionally retained — kept distinct from the black-box conformance claim. |

## Verification (native, from `typescript/agentkit`)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| Full Jest suite | 63 suites / 965 tests, all passing |
| BasePay suite | 68/68 |
| Unpatched head baseline | **8 gasless policy tests failed** (incl. 2 pre-existing tests silently red at `8380c34`) |

## osr21's corrections, incorporated

1. **No missing `receipt.status` mapping on gasless.** `sendUsdcGasless` never
   calls `waitForTransactionReceipt`; `relay_confirmed` is the agreed outcome.
2. **`CounterpartyContext` on `evaluate()` is type scaffolding**, not wired
   plumbing. Not added (no explicit source for the context yet).
3. **Two-set `pending`/`consumed` are process-local** (per-provider in-memory
   sets). Regressions assert the process-local contract only; the black-box
   "retry same ref" claim was replaced by the white-box post-gate assertion.
4. **Packaging constraint honored:** minimal regressions live in #1349's own
   Jest suite (`0003`); this report/harness stays outside the repo tree.

## Scope note

osr21 declined a $4,000 engagement in-thread (kept separate from technical
acceptance). This patch is the invited technical contribution "on its own
merits"; commercial terms are out of scope for the thread.
