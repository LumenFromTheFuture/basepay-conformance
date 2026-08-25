// FakePolicyProvider: a configurable policy provider that produces decisions
// through the REAL hashing utilities (actionContextHash / sha256 + RFC 8785
// JCS) from the verbatim policy module. It can also emit forged/stale
// decisions (hash bound to a different action, expired TTL, missing
// decision_ref) to exercise the gate's negative paths.
import canonicalize from "canonicalize";
import {
  ActionContext,
  PolicyDecision,
  PolicyProvider,
  PolicyReceipt,
} from "../src/policy/interfaces";
import { actionContextHash, sha256 } from "../src/policy/utils";

export interface FakePolicyOptions {
  allowed: boolean;
  reasonCodes: string[];
  /** TTL in ms. Negative => already expired when evaluated. */
  expiresInMs: number;
  /**
   * Decision reference policy:
   *   ""            => auto-compute a fresh ref per evaluation
   *   "__MISSING__" => no decision_ref at all (unbound_execution)
   *   other string  => fixed, replayable ref
   */
  decisionRefOverride: string;
  /** Hash bound to a DIFFERENT action than the one being evaluated (forged/stale). */
  actionContextHashOverride: string;
  policyVersion: string;
}

export const MISSING_REF = "__MISSING__";

export class FakePolicyProvider implements PolicyProvider {
  public readonly receipts: PolicyReceipt[] = [];
  public readonly evaluated: ActionContext[] = [];
  private readonly opts: FakePolicyOptions;

  constructor(opts?: Partial<FakePolicyOptions>) {
    this.opts = {
      allowed: true,
      reasonCodes: [],
      expiresInMs: 60_000,
      decisionRefOverride: "",
      actionContextHashOverride: "",
      policyVersion: "conformance-v1",
      ...opts,
    };
  }

  async evaluate(ctx: ActionContext): Promise<PolicyDecision> {
    this.evaluated.push(ctx);
    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + this.opts.expiresInMs;
    const actionContextHashValue =
      this.opts.actionContextHashOverride || (await actionContextHash(ctx));
    const decisionRef =
      this.opts.decisionRefOverride === MISSING_REF
        ? ""
        : this.opts.decisionRefOverride ||
          (await sha256(
        canonicalize({
          action_context_hash: actionContextHashValue,
          policy_version: this.opts.policyVersion,
          issued_at_ms: issuedAtMs,
          expires_at_ms: expiresAtMs,
        }) ?? "{}",
      ));
    return {
      allowed: this.opts.allowed,
      reason_codes: this.opts.reasonCodes,
      policy_version: this.opts.policyVersion,
      action_context_hash: actionContextHashValue,
      decision_ref: decisionRef,
      issued_at_ms: issuedAtMs,
      expires_at_ms: expiresAtMs,
    };
  }

  async record(receipt: PolicyReceipt): Promise<void> {
    this.receipts.push(receipt);
  }

  lastReceipt(): PolicyReceipt | undefined {
    return this.receipts[this.receipts.length - 1];
  }
}
