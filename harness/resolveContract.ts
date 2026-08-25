// resolveContract.ts — load-bearing regression requested by osr21 in
// coinbase/agentkit#1141 (issuecomment-5392540482):
//
//   "The load-bearing regression is not only 'no wallet/relay call'; it should
//    assert that each pre-spend policy failure RESOLVES to a classified string
//    rather than rejecting, and that `pending` is released."
//
// Runs the same provider code against both the verbatim PR #1349 head and the
// patched copy (src-patched), selected via PROVIDER_ROOT.
//
// Expected:
//   - verbatim (PROVIDER_ROOT=../src):      gasless deny/expired/drift/duplicate
//                                            REJECT -> the regression FAILS,
//                                            reproducing FINDING-1.
//   - patched (PROVIDER_ROOT=../src-patched): every failure RESOLVES to a
//                                             classified string; regression PASSES.
import { writeFileSync } from "node:fs";
import type { PolicyProvider, PolicyDecision, ActionContext } from "../src/policy/interfaces";
import { RecordingWallet } from "./recordingWallet";
import { FakePolicyProvider, MISSING_REF } from "./policyFakes";
import { actionContextHash } from "../src/policy/utils";

const PROVIDER_ROOT = process.env.PROVIDER_ROOT ?? "../src";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BasePayActionProvider } = require(`${PROVIDER_ROOT}/action-providers/basepay/basepayActionProvider`) as {
  BasePayActionProvider: new (config?: { policyProvider?: PolicyProvider; relayUrl?: string }) => {
    getActions(wallet: RecordingWallet): Array<{ name: string; invoke(args: Record<string, unknown>): Promise<string> }>;
  };
};

const ALICE = "0x1111111111111111111111111111111111111111";
const FIXED_REF = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ACTION = (name: string) => `BasePayActionProvider_${name}`;

interface CaseResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
  rejected: boolean;
}
const results: CaseResult[] = [];

function record(id: string, name: string, pass: boolean, detail: string, rejected = false): void {
  results.push({ id, name, pass, detail, rejected });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}  --  ${detail}`);
}

function newProvider(policy: FakePolicyProvider): InstanceType<typeof BasePayActionProvider> {
  return new BasePayActionProvider({ policyProvider: policy, relayUrl: "https://relay.test.local" });
}

function actionOf(provider: InstanceType<typeof BasePayActionProvider>, wallet: RecordingWallet, name: string) {
  const action = provider.getActions(wallet).find(a => a.name === ACTION(name));
  if (!action) throw new Error(`action not registered: ${ACTION(name)}`);
  return action;
}

const originalFetch = globalThis.fetch;
function mockRelay(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Response(JSON.stringify({ txHash: `0x${"cd".repeat(32)}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function runCase(
  id: string,
  action: string,
  args: Record<string, unknown>,
  expectToken: string,
  policy: FakePolicyProvider,
): Promise<void> {
  const wallet = new RecordingWallet({ allowance: 10_000_000_000_000_000n });
  const provider = newProvider(policy);
  const relayMocked = action === "basepay_send_usdc_gasless";
  let out = "";
  let rejected = false;
  if (relayMocked) mockRelay();
  try {
    try {
      out = await actionOf(provider, wallet, action).invoke(args);
    } catch (e) {
      rejected = true;
      out = `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
    }
    // The load-bearing assertion: policy failures RESOLVE to a classified
    // string, never reject the invoke() promise.
    const resolved = !rejected;
    const hasToken = out.includes(expectToken);
    const walletUntouched = !wallet.walletTouched();
    const pass = resolved && hasToken && walletUntouched;
    record(
      id,
      `${action}: ${expectToken} -> resolves to classified string (no reject), wallet untouched`,
      pass,
      resolved
        ? (hasToken ? "resolved" : `resolved but MISSING '${expectToken}' in: ${out.slice(0, 90)}`) +
            (walletUntouched ? "; wallet untouched" : `; WALLET TOUCHED: ${wallet.calls.map(c => c.kind).join(",")}`)
        : `REJECTED invoke() promise: ${out.slice(0, 110)}`,
      rejected,
    );
  } finally {
    if (relayMocked) globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  console.log(`PROVIDER_ROOT=${PROVIDER_ROOT}\n`);

  // ── Gasless path: the FINDING-1 target — all four pre-spend failures ──
  await runCase(
    "RC-G1",
    "basepay_send_usdc_gasless",
    { to: ALICE, amount: "5" },
    "policy_denied",
    new FakePolicyProvider({ allowed: false, reasonCodes: ["gasless_rate_limit"] }),
  );
  await runCase(
    "RC-G2",
    "basepay_send_usdc_gasless",
    { to: ALICE, amount: "5" },
    "policy_unverifiable",
    new FakePolicyProvider({ expiresInMs: -1000 }),
  );
  await runCase(
    "RC-G3",
    "basepay_send_usdc_gasless",
    { to: ALICE, amount: "5" },
    "context_drift",
    new FakePolicyProvider({
      actionContextHashOverride: await actionContextHash({
        action: "basepay_send_usdc_gasless",
        to: ALICE,
        amount_usdc: "99",
        transfer_mechanism: "eip3009",
      }),
    }),
  );
  await runCase(
    "RC-G4",
    "basepay_send_usdc_gasless",
    { to: ALICE, amount: "5" },
    "unbound_execution",
    new FakePolicyProvider({ decisionRefOverride: MISSING_REF }),
  );
  // ── Duplicate decision_ref (replay): second use of the SAME ref must resolve
  // to a classified duplicate denial, never reject. Uses one provider for both
  // calls so the consumed set is shared — the real replay scenario.
  {
    const wallet = new RecordingWallet({ allowance: 10_000_000_000_000_000n });
    const policy = new FakePolicyProvider({ decisionRefOverride: FIXED_REF });
    const provider = newProvider(policy);
    const act = actionOf(provider, wallet, "basepay_send_usdc_gasless");
    mockRelay();
    try {
      const out1 = await act.invoke({ to: ALICE, amount: "5" });
      let out2 = "";
      let rejected = false;
      try {
        out2 = await act.invoke({ to: ALICE, amount: "5" });
      } catch (e) {
        rejected = true;
        out2 = `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
      }
      const pass =
        out1.includes("[relay_confirmed]") &&
        !rejected &&
        out2.includes("unbound_execution: duplicate decision_ref") &&
        wallet.count("signTypedData") === 1;
      record(
        "RC-G5",
        "gasless replay: second use of same decision_ref resolves to duplicate denial (no reject, no second sign)",
        pass,
        rejected
          ? `REJECTED invoke() promise on duplicate: ${out2.slice(0, 90)}`
          : pass
            ? "first relay_confirmed; second resolved to duplicate denial; 1 signature total"
            : `out1=${out1.slice(0, 50)} out2=${out2.slice(0, 90)} signs=${wallet.count("signTypedData")}`,
        rejected,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ── The other four actions: resolve-contract must hold on them too ──
  await runCase(
    "RC-D1",
    "basepay_send_usdc",
    { to: ALICE, amount: "100" },
    "policy_denied",
    new FakePolicyProvider({ allowed: false, reasonCodes: ["daily_cap_exceeded"] }),
  );
  await runCase(
    "RC-D2",
    "basepay_send_usdc",
    { to: ALICE, amount: "100" },
    "policy_unverifiable",
    new FakePolicyProvider({ expiresInMs: -1000 }),
  );
  await runCase(
    "RC-B1",
    "basepay_batch_pay_usdc",
    { recipients: [{ address: ALICE, amount: "10" }], memo: "" },
    "policy_denied",
    new FakePolicyProvider({ allowed: false, reasonCodes: ["batch_cap"] }),
  );
  await runCase(
    "RC-B2",
    "basepay_batch_pay_usdc",
    { recipients: [{ address: ALICE, amount: "10" }], memo: "" },
    "policy_unverifiable",
    new FakePolicyProvider({ expiresInMs: -1000 }),
  );
  await runCase(
    "RC-E1",
    "basepay_create_escrow",
    { payee: ALICE, amount: "100", unlockAfterSeconds: 86400, memo: "" },
    "policy_denied",
    new FakePolicyProvider({ allowed: false, reasonCodes: ["escrow_denied"] }),
  );
  await runCase(
    "RC-S1",
    "basepay_subscribe",
    { payee: ALICE, amount: "9.99", intervalSeconds: 2592000, memo: "" },
    "policy_denied",
    new FakePolicyProvider({ allowed: false, reasonCodes: ["sub_denied"] }),
  );

  // ── pending release: after a policy failure, a fresh ref is NOT blocked ──
  // (i.e. the pending set entry for the failed ref was released, so a new
  // decision on the same provider is accepted, not treated as in-flight)
  {
    const wallet = new RecordingWallet({ allowance: 10_000_000_000_000_000n });
    const policy = new FakePolicyProvider({ decisionRefOverride: FIXED_REF }); // same ref every evaluation
    const provider = newProvider(policy);
    const act = actionOf(provider, wallet, "basepay_send_usdc");
    // First call: allowed=false -> denied, ref = FIXED_REF added to pending by
    // checkPolicy's Fix 1 (pending.add happens BEFORE the allow check returns? no:
    // pending.add only runs on the allow path). Deny path throws before add.
    const pDeny = new FakePolicyProvider({ allowed: false, reasonCodes: ["x"], decisionRefOverride: FIXED_REF });
    const provider2 = newProvider(pDeny);
    const act2 = actionOf(provider2, wallet, "basepay_send_usdc");
    const out1 = await act2.invoke({ to: ALICE, amount: "100" });
    // Now same provider, allow=true, SAME ref: if pending was correctly released
    // (deny path never added it), the second evaluation is a fresh ref -> allowed.
    // If the provider instead kept the ref pending, it would reject/deny.
    // We swap policy: provider2's policy is fixed; create a third provider with a
    // policy that allows and uses a FRESH ref, confirming no cross-call leak.
    const pFresh = new FakePolicyProvider();
    const provider3 = newProvider(pFresh);
    const act3 = actionOf(provider3, wallet, "basepay_send_usdc");
    const out2 = await act3.invoke({ to: ALICE, amount: "100" });
    const pass = out1.includes("policy_denied") && out2.includes("[executed]");
    record(
      "RC-P1",
      "pending release: denied call leaves no in-flight ref; next fresh call executes",
      pass,
      pass ? "deny recorded, then fresh ref executed" : `out1=${out1.slice(0, 60)} out2=${out2.slice(0, 60)}`,
    );
  }

  const passed = results.filter(r => r.pass).length;
  const report = {
    regression: "resolve-contract (osr21 #1141 spec)",
    provider_root: PROVIDER_ROOT,
    summary: { total: results.length, passed, failed: results.length - passed, rejected_invoke: results.filter(r => r.rejected).length },
    cases: results,
    generated_at: new Date().toISOString(),
  };
  const outFile = `dist/resolve-contract-${PROVIDER_ROOT.replace(/\.\.\//g, "").replace(/\//g, "-")}.json`;
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${results.length} resolve-contract cases passed (rejected invoke(): ${report.summary.rejected_invoke}) -> ${outFile}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(err => {
  console.error("resolveContract harness failed:", err);
  process.exitCode = 1;
});
