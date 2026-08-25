// HARNESS-SIDE SUBSTITUTION (documented in PROVENANCE.md)
// Upstream re-exports ./svm, which pulls Solana types not needed by the EVM
// BasePay conformance target. Keeps the verbatim import `../../network`
// resolving to the real Network interface.
export * from "./network";
export * from "./types";
