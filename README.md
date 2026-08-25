# basepay-conformance

A minimal, runnable conformance fixture for the **BasePay action-provider
policy gate** — the opt-in pre-spend authority boundary built in
[coinbase/agentkit PR #1349](https://github.com/coinbase/agentkit/pull/1349)
(design agreed with the BasePay maintainer in
[issue #1141](https://github.com/coinbase/agentkit/issues/1141)).

It runs the **verbatim PR-head implementation** against a recording mock
wallet and a configurable policy provider, and checks the properties that make
the gate worth paying for:

1. deny / expired / context-drift decisions fail **before any wallet contact**
   (zero allowance reads, zero sends, zero signatures);
2. the executed recipient-and-amount allocation equals the evaluated
   allocation, joined by a recomputable content-derived hash;
3. `decision_ref` consumption is atomic — replay and concurrent duplicates
   cannot double-spend;
4. on-chain reverts are classified `failed`, not `executed`;
5. gasless EIP-3009 signing binds exactly the evaluated message, and the
   decision is consumed before the signature is produced;
6. the hash utilities are deterministic, order-canonical, and sensitive to
   address/amount changes; both join keys recompute from stored fields alone.

## Run

```bash
cd basepay-conformance
npm install
npm run conformance      # tsc && node dist/harness/run.js
```

Output: per-case PASS/FAIL on stdout and
`dist/conformance-report.json` (machine-readable, includes evidence per case).

## Layout

- `src/` — verbatim PR-head code (see `PROVENANCE.md` for the byte-level
  checksums and the three documented harness-side substitutions)
- `harness/recordingWallet.ts` — wallet mock that records every wallet call
- `harness/policyFakes.ts` — configurable policy provider (allow/deny/forged/
  expired/missing-ref) built on the real hashing utilities
- `harness/run.ts` — the 19-case conformance runner
- `PROVENANCE.md` — what code was tested and how to re-verify it
- `FINDINGS.md` — defects and design observations surfaced by the run

## Current status

19/19 cases pass against PR #1349 head `8380c34`. One defect surfaced:
**FINDING-1** — the gasless action lacks the outer `catch` the other four
actions have, so policy failures on the gasless path reject the `invoke()`
promise instead of returning a structured failure string. See `FINDINGS.md`.
