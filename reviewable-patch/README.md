# Reviewable patch — BasePayActionProvider conformance pass (invited)

Invited by osr21 (BasePay maintainer) in coinbase/agentkit#1141,
issuecomment-5392540482 (2026-08-24):

> "A reviewable patch with the catch regression, precise batch wording, and the
>  direct-path receipt checks would still be useful on its own merits."

This bundle is the deliverable for that invitation. It applies to the
**verbatim PR #1349 head** (`8380c34b9769cc255ff50d78b4ad2bafdd3de354`) with
zero context drift — each patch below was verified to apply cleanly with
`patch -p1` and to produce a tree byte-identical to the locally-built
`src-patched/`.

## Contents

| Patch | File(s) | Purpose |
|---|---|---|
| `0001-fix-gasless-outer-catch.patch` | `typescript/agentkit/src/action-providers/basepay/basepayActionProvider.ts` | Fix FINDING-1: add the outer `catch` to `sendUsdcGasless` so pre-spend policy failures **resolve** to a classified failure string instead of rejecting the `invoke()` promise. Matches the shape of the other four actions; `recordPolicyOutcome(null, …)` is a no-op so policy receipts already recorded inside `checkPolicy` are not duplicated. |
| `0002-precise-batch-wording.patch` | `typescript/agentkit/src/policy/utils.ts` | Fix the `recipientAllocationHash` docstring per osr21's exact wording: *"order-insensitive (permutation is intentionally invisible); catches address substitution, amount changes, and redistribution"* — replaces the overstating "silent reordering" claim. |
| `0003-jest-regressions.patch` | `typescript/agentkit/src/basepayActionProvider.test.ts` | Load-bearing regressions against the actual exported provider (the PR's own Jest suite): each pre-spend policy failure on `sendUsdcGasless` **resolves** to its classified string (`.resolves.toContain`), `pending` is released, and a direct-path on-chain revert maps to `[failed]`. |

## Verification (run against verbatim head vs patched tree)

Independent conformance runner `harness/resolveContract.ts` (same provider code,
`PROVIDER_ROOT` selects the tree):

| | Verbatim head (`src`) | Patched (`src-patched`) |
|---|---|---|
| resolve-contract cases | **7/12 pass — 5 rejections** (all gasless: deny, expired, drift, missing ref, duplicate ref) | **12/12 pass — 0 rejections** |
| original 19-case conformance | 19/19 | 19/19 (no regression; FINDING-1 rejection no longer manifested) |

The 5 verbatim failures are exactly FINDING-1: the gasless action rejects the
`invoke()` promise on every pre-spend policy failure. After the one-block catch
fix the same calls resolve to classified strings with the wallet untouched.

## osr21's corrections, incorporated

1. **No missing `receipt.status` mapping on gasless.** `sendUsdcGasless` never
   calls `waitForTransactionReceipt`; `relay_confirmed` is the agreed outcome.
   The gasless fixture continues expecting `relay_confirmed`. Only the four
   **direct** onchain paths map receipt status (asserted in `0003`).
2. **`CounterpartyContext` on `evaluate()` is type scaffolding**, not wired
   plumbing. Not added to this patch (no explicit source for the context yet).
3. **Two-set `pending`/`consumed` are process-local** (per-provider in-memory
   sets), not global single-use across instances or restarts. Durable atomic
   consumption belongs in the policy backend. Regressions assert the
   process-local contract only.
4. **Packaging constraint honored:** minimal regressions live in #1349's own
   Jest suite (`0003`); the full provenance report/harness stays outside the
   repo tree (see `basepay-conformance/` PROVENANCE.md, FINDINGS.md).

## Scope note

osr21 declined a $4,000 engagement in-thread (kept separate from technical
acceptance). This patch is the invited technical contribution "on its own
merits"; commercial terms are out of scope for the thread.
