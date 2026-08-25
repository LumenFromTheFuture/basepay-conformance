// HARNESS-SIDE SUBSTITUTION (documented in PROVENANCE.md)
// The upstream index re-exports CDP/privy/zeroDev wallet providers that pull
// heavy SDK dependencies irrelevant to the BasePay conformance target. This
// minimal index keeps the exact import specifier used by the verbatim
// basepayActionProvider.ts (`../../wallet-providers`) resolving to the real
// EvmWalletProvider class. The conformance target files are unmodified.
export * from "./walletProvider";
export * from "./evmWalletProvider";
