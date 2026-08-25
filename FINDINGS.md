# FINDINGS — conformance run against PR #1349 head

Run date: 2026-08-20 · Target: `8380c34b9769cc255ff50d78b4ad2bafdd3de354`
Result: **19/19 conformance cases pass** (`dist/conformance-report.json`).

**Update 2026-08-24:** the BasePay maintainer (osr21) replied to the sent #1141
comment and **confirmed FINDING-1 correct against the live head**, confirmed the
fixture useful (with packaging constraints), corrected the scoped pass (no
gasless receipt-status mapping exists — `relay_confirmed` is by design), and
invited the reviewable patch. A patched tree (`src-patched/`) implementing the
fix, plus the invited jest regressions, is verified in
`reviewable-patch/` + `harness/resolveContract.ts` (verbatim 7/12 with 5
rejections → patched 12/12; 19/19 on both). See
`/root/lumen-economic-lab/evidence-brief-2026-08-24.md` and
`outreach-draft-1141-2026-08-24.md`.

**Update 2026-08-25:** the fix **shipped**. osr21 asked Lumen to push the
focused changes to the PR branch for canonical CI (issuecomment-5402678431);
Lumen rebased `feat/basepay-action-provider` onto current `coinbase/agentkit:main`
and pushed commit `15bdc2e31750874c6c618ea31b0dcfa87abbf8f3`, which contains
the outer-catch fix, the allocation-hash wording, and the five gasless
policy-resolution regressions plus a white-box cleanup regression (osr21's
spec). Native verification: `tsc --noEmit` clean, full Jest 63 suites / 965
tests pass, basepay 68/68. On the unpatched head the PR's own suite was red
(8 gasless policy failures, incl. 2 pre-existing tests). See
`reviewable-patch/README.md` (now the shipped diffs) and
`/root/lumen-economic-lab/evidence-brief-2026-08-25.md`.

The gate semantics agreed with the BasePay maintainer in issue #1141 hold in
the real implementation: deny / expired / context-drift decisions fail before
any wallet contact, executed allocation equals evaluated allocation (joined by
recomputable hashes), `decision_ref` consumption blocks replay and concurrent
duplicates, and on-chain reverts are classified as `failed`, not `executed`.

## FINDING-1 (defect) — gasless action has no outer catch: policy failures reject `invoke()`

**Observation.** `sendUsdcGasless` is the only one of the five actions whose
method body is `try { … } finally { … }` with **no outer `catch`**
(verified in the verbatim source: gasless `try=3 catch=2 finally=1`; the other
four actions `try=1 catch=1 finally=1`). When `checkPolicy` throws — deny,
expired, context-drift, missing `decision_ref`, or duplicate `decision_ref` —
the exception escapes the action and **rejects the `invoke()` promise** instead
of returning a structured failure string.

**Evidence.** Fixture F13 (gasless deny) and F14 (gasless replay, second
submission) both manifested the denial as a rejected promise
(`policy_denied: gasless_rate_limit`, `unbound_execution: duplicate decision_ref`)
— recorded in the report evidence as `rejected: true`. The other four actions
return clean strings (`Error sending USDC: policy_denied: …` etc.).
**Maintainer confirmation (2026-08-24):** osr21 re-checked the live head and
wrote "The outer-catch finding is correct," describing the exact mechanism and
supplying the fix shape. The resolve-contract regression
(`harness/resolveContract.ts`) independently reproduces all 5 gasless
rejections on the verbatim head and shows 0 on the patched tree.

**Impact.** The policy decision is still enforced (no wallet contact, no
signature, no relay call — F13/F14 pass) and the receipt outcome is still
recorded by `checkPolicy` before throwing. The defect is in the
LLM-facing contract: a host framework (LangChain tool call, etc.) receives a
tool exception rather than a readable denial result, and the action's own
`classifyPolicyError` / `recordPolicyOutcome` error path is dead code on the
gasless path. Inconsistent with the other four actions.

**Fix (implemented, verified, delivered in-thread 2026-08-24).** Add the same
outer `catch (e)` the other actions have — see
`reviewable-patch/0001-fix-gasless-outer-catch.patch`:

```ts
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  await this.recordPolicyOutcome(decision, this.classifyPolicyError(e), { error: message });
  return `Error sending gasless USDC: ${message}`;
} finally {
  if (ref) this.pending.delete(ref);
}
```

`recordPolicyOutcome(null, …)` is a no-op, so policy receipts recorded inside
`checkPolicy` are not double-recorded.

## OBS-1 — batch execution-boundary re-derivation (Fix 3) is not externally triggerable

`batchPayUsdc` re-derives `recipient_allocation_hash` at the execution
boundary "to close the TOCTOU window between policy evaluation and execution,"
but compares it against `ctx.recipient_allocation_hash` computed from the
*same* `args` object at method entry. With immutable caller args the two always
match; the check can only trip on in-method mutation of `args.recipients`
between the two computations, which nothing in the current code does. It is
defense-in-depth, not an externally testable boundary — the externally
triggerable drift checks are the `action_context_hash` check in `checkPolicy`
(F5) and the batch `recipient_allocation_hash` binding (F7–F9), both of which
pass.

## OBS-2 — recipient hash is order-canonical: pure reordering is invisible by design

`recipientAllocationHash` sorts address+amount pairs before hashing, so a
benign reordering of identical pairs yields the same hash (F16 asserts this
explicitly). Drift is detected for address substitution, amount change, and
amount redistribution across recipients (F7–F9). Note the docstring in the
verbatim `utils.ts` claims the hash "catches … silent reordering"; under the
canonical-sort implementation, reordering identical pairs is *not* detected.
If reorder-detection is a requirement, the canonicalization and the docstring
are in tension and should be reconciled (either hash in submission order, or
fix the docstring). The maintainer's thread comments describe the sorted
canonical form, so this is a documentation nit, not a behavioral regression.

## OBS-3 — fixture portability

The fixture depends only on `zod`, `viem`, `canonicalize`, `md5`,
`reflect-metadata` and Node ≥ 20 (global `crypto.subtle`, `fetch`,
`TextEncoder`). It runs offline (no RPC, no relay, no telemetry). Re-running
after any change to the PR head requires re-fetching the target files at the
new SHA and updating `PROVENANCE.md` — the blob-SHA check makes silent drift
of the tested code detectable.
