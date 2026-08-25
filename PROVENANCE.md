# PROVENANCE — BasePay conformance fixture

This fixture tests the **real implementation** from coinbase/agentkit
PR #1349 ("feat: policy hook scaffolding for BasePayActionProvider"),
fetched from the PR head commit.

## Target

- Repo: `LumenFromTheFuture/agentkit` (fork of `coinbase/agentkit`)
- PR: https://github.com/coinbase/agentkit/pull/1349 (open, unmerged as of 2026-08-20)
- Head SHA: `8380c34b9769cc255ff50d78b4ad2bafdd3de354`
- Acceptance shape: issue #1141 — maintainer-agreed three pre-spend checks
  (`unbound_execution`, `policy_unverifiable`, `context_drift`), two-set
  `decision_ref` consumption, `recipient_allocation_hash` over sorted
  address+amount pairs, receipt outcome mapping.

## Verbatim files (byte-identical to the GitHub blobs at the head SHA)

Verified by computing the git blob hash of each local file
(`sha1("blob <len>\0" + content)`) and matching the blob SHA returned by the
GitHub API for the PR head tree. All listed files were fetched from
`raw.githubusercontent.com/LumenFromTheFuture/agentkit/8380c34…/typescript/agentkit/src/`.

### Conformance target (what the fixture exercises)

| File | Git blob SHA | Bytes |
|---|---|---|
| `src/action-providers/basepay/basepayActionProvider.ts` | `9fdb7263d25a48d2366f4e4e8bb5d527a7beef62` | 24770 |
| `src/action-providers/basepay/schemas.ts` | `fb8eddce438201b9724ccd7991f499d3b639664c` | 2397 |
| `src/action-providers/basepay/index.ts` | `6fd268e3c8a7e05a59576212b9e41f44c09e3bfe` | 285 |
| `src/policy/interfaces.ts` | `b6f7ec9c781f7779c854f269fbd1a212ee875cbb` | 1079 |
| `src/policy/utils.ts` | `480845eec76f2a96038169e893094ce11e71dc52` | 1300 |
| `src/policy/index.ts` | `795622a6e29c77a63fba743b3f1c049be969b768` | 55 |

### Supporting framework files (same head SHA, unmodified)

`src/action-providers/actionProvider.ts`, `src/action-providers/actionDecorator.ts`,
`src/network/network.ts`, `src/network/types.ts`, `src/wallet-providers/walletProvider.ts`,
`src/wallet-providers/evmWalletProvider.ts`, `src/analytics/index.ts`.

### Reference copy (not compiled)

`src/basepayActionProvider.test.ts` is the PR's own jest suite (verbatim,
`a8b758466f94e63afd04d2ef0693d1420474617f`, 31805 bytes). It is kept for
reference and excluded from the harness build because it requires the full
agentkit jest rig. The conformance fixture is an independent runner, not a
re-run of the PR's tests.

## Harness-side substitutions (NOT part of the conformance target)

Three files were replaced locally so the harness compiles and runs without
pulling the full agentkit dependency graph or phoning external services.
Each preserves the import specifier the verbatim code uses.

| File | Upstream behavior | Substitution |
|---|---|---|
| `src/wallet-providers/index.ts` | re-exports CDP/privy/zeroDev providers (heavy SDKs) | re-exports only `walletProvider` + `evmWalletProvider` |
| `src/network/index.ts` | re-exports `./svm` (Solana types) | re-exports `./network` + `./types` |
| `src/analytics/sendAnalyticsEvent.ts` | POSTs to `cca-lite.coinbase.com` on every action | no-op (same signature) |

Nothing in the conformance target files was modified. Any change to the
target files would break the blob-SHA match above.

## Re-verification

```bash
cd basepay-conformance
# recompute and compare against the table above
python3 - <<'EOF'
import hashlib, os
for root, _, files in os.walk("src"):
    for f in sorted(files):
        p = os.path.join(root, f)
        d = open(p, "rb").read()
        print(hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest(), p)
EOF
```

## Environment

Node v24.19.0 (type-stripped build via `tsc` 5.9.3, CommonJS output).
Deps: `zod`, `viem`, `canonicalize`, `md5`, `reflect-metadata`.
