// BasePay action-provider conformance fixture.
//
// Runs the REAL implementation from coinbase/agentkit PR #1349 (LumenFromTheFuture
// fork, head SHA 8380c34b9769cc255ff50d78b4ad2bafdd3de354) against the acceptance
// shape agreed with the BasePay maintainer in issue #1141:
//   - deny / expired / context-drift decisions fail BEFORE any wallet contact
//   - the evaluated recipient-and-amount allocation equals the executed allocation
//   - decision and outcome are joined by a recomputable content-derived reference
//   - decision_ref consumption is atomic (no double-spend on replay or concurrency)
//   - on-chain revert is classified as failed, not executed
//
// All assertions run against the verbatim provider and policy code. The only
// harness-side substitutions are documented in PROVENANCE.md (analytics no-op,
// trimmed wallet-providers/network index files).
import { writeFileSync } from "node:fs";
import { decodeFunctionData, formatUnits, parseUnits, type Hex } from "viem";
import canonicalize from "canonicalize";
import { BasePayActionProvider } from "../src/action-providers/basepay/basepayActionProvider";
import { actionContextHash, recipientAllocationHash, sha256 } from "../src/policy/utils";
import { RecordingWallet, WALLET_ADDRESS } from "./recordingWallet";
import { FakePolicyProvider, MISSING_REF } from "./policyFakes";

// ---- public contract surfaces (mirror the provider's, for calldata decoding) ----
const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const BATCH_PAY_ABI = [
  {
    name: "batchSend",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "memo", type: "string" },
    ],
    outputs: [],
  },
] as const;

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const EVE = "0x3333333333333333333333333333333333333333";
const BIG_ALLOWANCE = 10_000_000_000_000_000n;
const FIXED_REF = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const PR_HEAD_SHA = "8380c34b9769cc255ff50d78b4ad2bafdd3de354";
const ACTION = (name: string) => `BasePayActionProvider_${name}`;

interface CaseResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
  evidence: Record<string, unknown>;
}

const results: CaseResult[] = [];

function record(
  id: string,
  name: string,
  pass: boolean,
  detail: string,
  evidence: Record<string, unknown> = {},
): void {
  results.push({ id, name, pass, detail, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}  --  ${detail}`);
}

function newProvider(policy?: FakePolicyProvider, relayUrl?: string): BasePayActionProvider {
  return new BasePayActionProvider(
    policy
      ? { policyProvider: policy, relayUrl: relayUrl ?? "https://relay.test.local" }
      : { relayUrl: relayUrl ?? "https://relay.test.local" },
  );
}

function actionOf(provider: BasePayActionProvider, wallet: RecordingWallet, name: string) {
  const action = provider.getActions(wallet).find(a => a.name === ACTION(name));
  if (!action) throw new Error(`action not registered: ${ACTION(name)}`);
  return action;
}

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; body: string }> = [];
function mockRelay(): void {
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ txHash: `0x${"cd".repeat(32)}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function main(): Promise<void> {
  // =========================================================================
  // P0 — no policy provider: default behavior unchanged (opt-in property)
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: 0n });
    const provider = newProvider();
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "10.5",
    });
    // sendUsdc is a direct ERC20 transfer — a single sendTransaction, no approve.
    const transfer = wallet.sentTxs[0];
    const decoded = transfer
      ? decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: transfer.data as Hex })
      : null;
    const pass =
      out.includes("[executed]") &&
      wallet.count("sendTransaction") === 1 &&
      decoded !== null &&
      decoded.args[0] === ALICE &&
      decoded.args[1] === parseUnits("10.5", 6);
    record(
      "P0",
      "baseline: no policy provider, behavior unchanged",
      pass,
      pass
        ? "transfer executed; calldata decodes to exactly (ALICE, 10.5 USDC atomic)"
        : `out=${out.slice(0, 80)} txs=${wallet.count("sendTransaction")}`,
      { out: out.slice(0, 160), decoded: decoded ? String(decoded.args) : null },
    );
  }

  // =========================================================================
  // F1 — allow path: executed, receipt joined, allocation preserved
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const decoded = wallet.sentTxs[0]
      ? decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: wallet.sentTxs[0].data as Hex })
      : null;
    const pass =
      out.includes("[executed]") &&
      wallet.count("sendTransaction") === 1 &&
      policy.lastReceipt()?.outcome === "executed" &&
      decoded !== null &&
      decoded.args[0] === ALICE &&
      decoded.args[1] === parseUnits("100", 6);
    record(
      "F1",
      "allow: executes, receipt outcome=executed, executed allocation == evaluated allocation",
      pass,
      pass ? "1 send; calldata == (ALICE, 100 USDC)" : `out=${out.slice(0, 80)}`,
      { receipt: policy.lastReceipt()?.outcome, evaluated: policy.evaluated[0] },
    );
  }

  // =========================================================================
  // F2 — deny: fails before any wallet contact
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ allowed: false, reasonCodes: ["daily_cap_exceeded"] });
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const pass =
      out.includes("policy_denied: daily_cap_exceeded") &&
      !wallet.walletTouched() &&
      policy.lastReceipt()?.outcome === "denied";
    record(
      "F2",
      "deny: policy_denied before read/sign/send",
      pass,
      pass ? "wallet untouched (0 reads, 0 sends, 0 signs)" : out.slice(0, 120),
      { walletCalls: wallet.calls.map(c => c.kind), receipt: policy.lastReceipt()?.outcome },
    );
  }

  // =========================================================================
  // F3 — unbound execution: decision without decision_ref
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ decisionRefOverride: MISSING_REF });
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const pass =
      out.includes("unbound_execution: missing decision_ref") &&
      !wallet.walletTouched() &&
      policy.lastReceipt()?.outcome === "unauditable_outcome";
    record(
      "F3",
      "unbound_execution: missing decision_ref fails before wallet contact",
      pass,
      pass ? "wallet untouched; receipt=unauditable_outcome" : out.slice(0, 120),
      { receipt: policy.lastReceipt()?.outcome },
    );
  }

  // =========================================================================
  // F4 — expired decision (policy_unverifiable)
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ expiresInMs: -1000 });
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const pass =
      out.includes("policy_unverifiable") &&
      !wallet.walletTouched() &&
      policy.lastReceipt()?.outcome === "expired";
    record(
      "F4",
      "policy_unverifiable: expired TTL fails before wallet contact",
      pass,
      pass ? "wallet untouched; receipt=expired" : out.slice(0, 120),
      { receipt: policy.lastReceipt()?.outcome },
    );
  }

  // =========================================================================
  // F5 — context drift (send): decision bound to a different action
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const forgedHash = await actionContextHash({
      action: "basepay_send_usdc",
      to: BOB,
      amount_usdc: "5",
      transfer_mechanism: "direct",
    });
    const policy = new FakePolicyProvider({ actionContextHashOverride: forgedHash });
    const provider = newProvider(policy);
    // The action evaluates ctx for (ALICE, 100); the decision is bound to (BOB, 5).
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const pass =
      out.includes("context_drift") && !wallet.walletTouched() && policy.lastReceipt()?.outcome === "context_drift";
    record(
      "F5",
      "context_drift: decision for (BOB,5) cannot execute (ALICE,100)",
      pass,
      pass ? "wallet untouched; receipt=context_drift" : out.slice(0, 120),
      { forgedHash: forgedHash.slice(0, 16), receipt: policy.lastReceipt()?.outcome },
    );
  }

  // =========================================================================
  // F6 — batch allow: executed allocation == evaluated allocation, hash join
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_batch_pay_usdc").invoke({
      recipients: [
        { address: ALICE, amount: "10" },
        { address: BOB, amount: "20" },
      ],
      memo: "payroll",
    });
    const decoded = wallet.sentTxs[0]
      ? decodeFunctionData({ abi: BATCH_PAY_ABI, data: wallet.sentTxs[0].data as Hex })
      : null;
    const executedRecipients = decoded?.args[1] as string[] | undefined;
    const executedAmounts = decoded?.args[2] as bigint[] | undefined;
    const execHash = await recipientAllocationHash(
      (executedRecipients ?? []).map((addr, i) => ({
        address: addr,
        amount: (executedAmounts ?? [])[i] ?? 0n,
      })),
    );
    const evaluatedHash = policy.evaluated[0]?.recipient_allocation_hash;
    const amountsMatch =
      JSON.stringify((executedAmounts ?? []).map(String)) ===
      JSON.stringify([parseUnits("10", 6), parseUnits("20", 6)].map(String));
    const pass =
      out.includes("[executed]") &&
      decoded !== null &&
      JSON.stringify(executedRecipients) === JSON.stringify([ALICE, BOB]) &&
      amountsMatch &&
      execHash === evaluatedHash &&
      policy.lastReceipt()?.outcome === "executed";
    record(
      "F6",
      "batch allow: executed (recipients,amounts) == evaluated; hash join holds",
      pass,
      pass
        ? "calldata recipients/amounts match evaluated allocation; recomputed exec hash == evaluated hash"
        : `out=${out.slice(0, 100)}`,
      pass
        ? {
            executedRecipients,
            executedAmounts: (executedAmounts ?? []).map(String),
            execHash: execHash.slice(0, 16),
            evaluatedHash: evaluatedHash?.slice(0, 16),
          }
        : { out: out.slice(0, 120), decoded: String(decoded?.args ?? []) },
    );
  }

  // =========================================================================
  // F7–F9 — batch drift variants: fail before ensureAllowance (no reads)
  // =========================================================================
  async function batchDriftCase(
    id: string,
    forgedAllocation: Array<{ address: string; amount: string }>,
    executedAllocation: Array<{ address: string; amount: string }>,
  ): Promise<void> {
    const wallet = new RecordingWallet({ allowance: 0n }); // allowance 0: any read would be visible
    const forgedTotal = forgedAllocation.reduce((s, r) => s + parseUnits(r.amount, 6), 0n);
    const forgedHash = await actionContextHash({
      action: "basepay_batch_pay_usdc",
      recipient_allocation_hash: await recipientAllocationHash(
        forgedAllocation.map(r => ({ address: r.address, amount: parseUnits(r.amount, 6) })),
      ),
      recipient_count: forgedAllocation.length,
      aggregate_usdc: formatUnits(forgedTotal, 6),
      transfer_mechanism: "direct",
    });
    const policy = new FakePolicyProvider({ actionContextHashOverride: forgedHash });
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_batch_pay_usdc").invoke({
      recipients: executedAllocation,
      memo: "",
    });
    const pass =
      out.includes("context_drift") &&
      wallet.count("readContract") === 0 &&
      wallet.count("sendTransaction") === 0 &&
      policy.lastReceipt()?.outcome === "context_drift";
    record(
      id,
      `batch context_drift: approved ${JSON.stringify(forgedAllocation.map(r => [r.address.slice(0, 6), r.amount]))} != executed ${JSON.stringify(executedAllocation.map(r => [r.address.slice(0, 6), r.amount]))}`,
      pass,
      pass ? "context_drift before ensureAllowance: 0 allowance reads, 0 sends" : out.slice(0, 120),
      { walletCalls: wallet.calls.map(c => c.kind), receipt: policy.lastReceipt()?.outcome },
    );
  }
  await batchDriftCase("F7", [{ address: BOB, amount: "10" }], [{ address: ALICE, amount: "10" }]);
  await batchDriftCase("F8", [{ address: ALICE, amount: "20" }], [{ address: ALICE, amount: "10" }]);
  await batchDriftCase(
    "F9",
    [
      { address: ALICE, amount: "10" },
      { address: BOB, amount: "20" },
    ],
    [
      { address: ALICE, amount: "20" },
      { address: BOB, amount: "10" },
    ],
  );

  // =========================================================================
  // F10 — sequential replay: consumed decision_ref cannot be reused
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ decisionRefOverride: FIXED_REF });
    const provider = newProvider(policy);
    const act = actionOf(provider, wallet, "basepay_send_usdc");
    const out1 = await act.invoke({ to: ALICE, amount: "100" });
    const out2 = await act.invoke({ to: ALICE, amount: "100" });
    const pass =
      out1.includes("[executed]") &&
      out2.includes("unbound_execution: duplicate decision_ref") &&
      wallet.count("sendTransaction") === 1 &&
      policy.receipts.map(r => r.outcome).join(",") === "executed,denied";
    record(
      "F10",
      "sequential replay: second use of same decision_ref denied; exactly one spend",
      pass,
      pass ? "1 send total; receipts=executed,denied" : `out1=${out1.slice(0, 60)} out2=${out2.slice(0, 60)}`,
      { receipts: policy.receipts.map(r => r.outcome), sends: wallet.count("sendTransaction") },
    );
  }

  // =========================================================================
  // F11 — concurrent duplicate submissions: exactly one spend
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE, sendDelayMs: 50 });
    const policy = new FakePolicyProvider({ decisionRefOverride: FIXED_REF });
    const provider = newProvider(policy);
    const act = actionOf(provider, wallet, "basepay_send_usdc");
    const [out1, out2] = await Promise.all([
      act.invoke({ to: ALICE, amount: "100" }),
      act.invoke({ to: ALICE, amount: "100" }),
    ]);
    const outcomes = policy.receipts.map(r => r.outcome).sort();
    const pass =
      wallet.count("sendTransaction") === 1 &&
      outcomes.join(",") === "denied,executed" &&
      (out1.includes("duplicate decision_ref") || out2.includes("duplicate decision_ref"));
    record(
      "F11",
      "concurrent duplicates: pending-set blocks second submission; exactly one spend",
      pass,
      pass ? `1 send; receipts=${outcomes.join(",")}` : `out1=${out1.slice(0, 60)} out2=${out2.slice(0, 60)}`,
      { receipts: outcomes, sends: wallet.count("sendTransaction") },
    );
  }

  // =========================================================================
  // F12 — gasless allow: signed message matches evaluated; relay_confirmed
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    mockRelay();
    try {
      const out = await actionOf(provider, wallet, "basepay_send_usdc_gasless").invoke({
        to: ALICE,
        amount: "5",
      });
      const msg = (wallet.signedTypedDataMessages[0] as { message?: Record<string, unknown> })
        ?.message;
      const pass =
        out.includes("[relay_confirmed]") &&
        msg?.to === ALICE &&
        msg?.from === WALLET_ADDRESS &&
        msg?.value === parseUnits("5", 6) &&
        fetchCalls.length === 1 &&
        fetchCalls[0].body.includes(ALICE.toLowerCase()) &&
        policy.lastReceipt()?.outcome === "relay_confirmed";
      record(
        "F12",
        "gasless allow: signed EIP-3009 message == evaluated (ALICE, 5 USDC); relay_confirmed",
        pass,
        pass
          ? "signTypedData message matches evaluated allocation; 1 relay call; receipt=relay_confirmed"
          : `out=${out.slice(0, 100)}`,
        {
          msg: msg
            ? { to: msg.to, from: msg.from, value: String(msg.value) }
            : null,
          relayBody: fetchCalls[0]?.body.slice(0, 120),
          receipt: policy.lastReceipt()?.outcome,
        },
      );
    } finally {
      restoreFetch();
    }
  }

  // =========================================================================
  // F13 — gasless deny: no signature, no relay contact (signed auth is spend-capable)
  // NOTE: the gasless action lacks the outer catch the other four actions have
  // (verified: try=3 catch=2 in the verbatim source), so policy failures here
  // REJECT the invoke() promise instead of returning a failure string. The
  // denial property (no wallet contact) still holds; the rejection is recorded
  // as finding FINDING-1 rather than a fixture failure.
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ allowed: false, reasonCodes: ["gasless_rate_limit"] });
    const provider = newProvider(policy);
    mockRelay();
    try {
      let out: string;
      let rejected = false;
      try {
        out = await actionOf(provider, wallet, "basepay_send_usdc_gasless").invoke({
          to: ALICE,
          amount: "5",
        });
      } catch (e) {
        rejected = true;
        out = `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
      }
      const pass =
        out.includes("policy_denied: gasless_rate_limit") &&
        wallet.count("signTypedData") === 0 &&
        fetchCalls.length === 0 &&
        policy.lastReceipt()?.outcome === "denied";
      record(
        "F13",
        "gasless deny: policy_denied before signature and relay",
        pass,
        pass
          ? `no signature produced, no relay call, receipt=denied${rejected ? " [manifested as rejection — FINDING-1]" : ""}`
          : out.slice(0, 100),
        { receipt: policy.lastReceipt()?.outcome, relayCalls: fetchCalls.length, rejected },
      );
    } finally {
      restoreFetch();
    }
  }

  // =========================================================================
  // F14 — gasless replay: decision_ref consumed before signing
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider({ decisionRefOverride: FIXED_REF });
    const provider = newProvider(policy);
    mockRelay();
    try {
      const act = actionOf(provider, wallet, "basepay_send_usdc_gasless");
      const out1 = await act.invoke({ to: ALICE, amount: "5" });
      let out2: string;
      let rejected = false;
      try {
        out2 = await act.invoke({ to: ALICE, amount: "5" });
      } catch (e) {
        rejected = true;
        out2 = `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
      }
      const pass =
        out1.includes("[relay_confirmed]") &&
        out2.includes("unbound_execution: duplicate decision_ref") &&
        wallet.count("signTypedData") === 1 &&
        fetchCalls.length === 1;
      record(
        "F14",
        "gasless replay: decision_ref consumed before signing; no second signature",
        pass,
        pass
          ? `1 signature, 1 relay call; second submission denied${rejected ? " [manifested as rejection — FINDING-1]" : ""}`
          : `out1=${out1.slice(0, 60)} out2=${out2.slice(0, 60)}`,
        { signatures: wallet.count("signTypedData"), relayCalls: fetchCalls.length, secondRejected: rejected },
      );
    } finally {
      restoreFetch();
    }
  }

  // =========================================================================
  // F15 — on-chain revert classified as failed, not executed
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE, receiptStatus: "reverted" });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    const out = await actionOf(provider, wallet, "basepay_send_usdc").invoke({
      to: ALICE,
      amount: "100",
    });
    const pass =
      out.includes("[failed]") && policy.lastReceipt()?.outcome === "failed";
    record(
      "F15",
      "revert classification: on-chain revert → [failed], not [executed]",
      pass,
      pass ? "receipt_outcome=failed" : out.slice(0, 120),
      { receipt: policy.lastReceipt()?.outcome, out: out.slice(0, 120) },
    );
  }

  // =========================================================================
  // F16 — hash properties: determinism, canonical form, sensitivity, join keys
  // =========================================================================
  {
    const alloc = [
      { address: ALICE, amount: parseUnits("10", 6) },
      { address: BOB, amount: parseUnits("20", 6) },
    ];
    const h1 = await recipientAllocationHash(alloc);
    const h2 = await recipientAllocationHash(alloc);
    const hReordered = await recipientAllocationHash([...alloc].reverse());
    const hDiffAmount = await recipientAllocationHash([
      { address: ALICE, amount: parseUnits("10.01", 6) },
      { address: BOB, amount: parseUnits("20", 6) },
    ]);
    const hDiffAddr = await recipientAllocationHash([
      { address: EVE, amount: parseUnits("10", 6) },
      { address: BOB, amount: parseUnits("20", 6) },
    ]);
    const jcsA = await actionContextHash({ a: 1, b: 2 } as never);
    const jcsB = await actionContextHash({ b: 2, a: 1 } as never);
    const pass =
      h1 === h2 &&
      h1 === hReordered &&
      h1 !== hDiffAmount &&
      h1 !== hDiffAddr &&
      jcsA === jcsB;
    record(
      "F16",
      "hash properties: deterministic, order-canonical, amount/address-sensitive, JCS key-order-independent",
      pass,
      pass ? "all six properties hold" : `h1=${h1.slice(0, 12)} h2=${h2.slice(0, 12)} reord=${hReordered.slice(0, 12)} amt=${hDiffAmount.slice(0, 12)} addr=${hDiffAddr.slice(0, 12)} jcs=${jcsA.slice(0, 12)}/${jcsB.slice(0, 12)}`,
      {
        deterministic: h1 === h2,
        orderCanonical: h1 === hReordered,
        amountSensitive: h1 !== hDiffAmount,
        addressSensitive: h1 !== hDiffAddr,
        jcsKeyOrderIndependent: jcsA === jcsB,
      },
    );

    // Recomputable reference: a third party with only the stored decision
    // fields (no agentkit dependency) can re-derive both join keys.
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    await actionOf(provider, wallet, "basepay_send_usdc").invoke({ to: ALICE, amount: "100" });
    const ctx = policy.evaluated[0]!;
    const decision = (() => {
      // Reconstruct the decision the same way the policy fake issued it.
      return policy.lastReceipt()!.decision;
    })();
    const recomputedCtxHash = await sha256(canonicalize(ctx) ?? "{}");
    const recomputedRef = await sha256(
      canonicalize({
        action_context_hash: decision.action_context_hash,
        policy_version: decision.policy_version,
        issued_at_ms: decision.issued_at_ms,
        expires_at_ms: decision.expires_at_ms,
      }) ?? "{}",
    );
    const joinPass =
      recomputedCtxHash === decision.action_context_hash && recomputedRef === decision.decision_ref;
    record(
      "F16b",
      "recomputable join: action_context_hash and decision_ref re-derived from stored fields alone",
      joinPass,
      joinPass ? "both keys recompute from the receipt fields" : "join key mismatch",
      {
        action_context_hash: recomputedCtxHash.slice(0, 16),
        decision_ref: recomputedRef.slice(0, 16),
      },
    );
  }

  // =========================================================================
  // F17 — escrow & subscription carry the risk signals agreed in #1141
  // =========================================================================
  {
    const wallet = new RecordingWallet({ allowance: BIG_ALLOWANCE });
    const policy = new FakePolicyProvider();
    const provider = newProvider(policy);
    const outEscrow = await actionOf(provider, wallet, "basepay_create_escrow").invoke({
      payee: BOB,
      amount: "100",
      unlockAfterSeconds: 86400,
      memo: "retainer",
    });
    const escrowCtx = policy.evaluated[0];
    const escrowPass = outEscrow.includes("[executed]") && escrowCtx?.creates_commitment === true;

    const policy2 = new FakePolicyProvider();
    const provider2 = newProvider(policy2);
    const outSub = await actionOf(provider2, wallet, "basepay_subscribe").invoke({
      payee: BOB,
      amount: "9.99",
      intervalSeconds: 2592000,
      memo: "pro",
    });
    const subCtx = policy2.evaluated[0];
    const subPass =
      outSub.includes("[executed]") && subCtx?.creates_recurring_obligation === true;

    const pass = escrowPass && subPass;
    record(
      "F17",
      "escrow/subscribe carry creates_commitment / creates_recurring_obligation risk signals",
      pass,
      pass
        ? "both signals present on evaluated ctx; both actions executed"
        : `escrow=${escrowPass} sub=${subPass}`,
      {
        escrowCtx: escrowCtx
          ? { creates_commitment: escrowCtx.creates_commitment, action: escrowCtx.action }
          : null,
        subCtx: subCtx
          ? { creates_recurring_obligation: subCtx.creates_recurring_obligation, action: subCtx.action }
          : null,
      },
    );
  }

  // =========================================================================
  // Report
  // =========================================================================
  const passed = results.filter(r => r.pass).length;
  const report = {
    fixture: "basepay-conformance",
    target: {
      repo: "LumenFromTheFuture/agentkit (coinbase/agentkit PR #1349)",
      head_sha: PR_HEAD_SHA,
      acceptance_shape: "issue #1141, maintainer-agreed three pre-spend checks + two-set consumption",
    },
    environment: { node: process.version, platform: process.platform },
    summary: { total: results.length, passed, failed: results.length - passed },
    cases: results,
    generated_at: new Date().toISOString(),
  };
  writeFileSync("dist/conformance-report.json", JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${results.length} conformance cases passed → dist/conformance-report.json`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(err => {
  console.error("harness failed:", err);
  process.exitCode = 1;
});
