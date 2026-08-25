// RecordingWallet: a deterministic EvmWalletProvider mock that records every
// wallet interaction. The conformance fixture asserts on the *absence* of
// wallet contact for denied/drifted/expired decisions and on the exact payload
// of each executed transaction.
import { EvmWalletProvider } from "../src/wallet-providers/evmWalletProvider";
import { Network } from "../src/network/types";
import type { TransactionRequest } from "viem";

export type CallKind =
  | "readContract"
  | "sendTransaction"
  | "waitForTransactionReceipt"
  | "signTypedData";

/** JSON.stringify replacer that renders bigint as a decimal string. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export interface WalletCall {
  kind: CallKind;
  detail: string;
}

export interface RecordingWalletOptions {
  /** Value returned by the allowance() read. 0n forces the approve path. */
  allowance: bigint;
  /** Receipt status returned for executed transactions. */
  receiptStatus: "success" | "reverted";
  /** Artificial delay in sendTransaction, to force interleaving in the concurrency case. */
  sendDelayMs: number;
}

export const WALLET_ADDRESS = "0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeee" as const;

export class RecordingWallet extends EvmWalletProvider {
  public readonly calls: WalletCall[] = [];
  public readonly sentTxs: TransactionRequest[] = [];
  public readonly signedTypedDataMessages: unknown[] = [];
  private readonly opts: RecordingWalletOptions;

  constructor(opts?: Partial<RecordingWalletOptions>) {
    super();
    this.opts = {
      allowance: 0n,
      receiptStatus: "success",
      sendDelayMs: 0,
      ...opts,
    };
  }

  getAddress(): string {
    return WALLET_ADDRESS;
  }

  getName(): string {
    return "recording-wallet";
  }

  getNetwork(): Network {
    return { networkId: "base-mainnet", chainId: "8453", protocolFamily: "evm" };
  }

  async getBalance(): Promise<bigint> {
    return 0n;
  }

  async nativeTransfer(_to: string, _value: string): Promise<string> {
    throw new Error("nativeTransfer not used by BasePay actions");
  }

  async sign(_hash: `0x${string}`): Promise<`0x${string}`> {
    throw new Error("sign not used by BasePay actions");
  }

  async signMessage(_message: string | Uint8Array): Promise<`0x${string}`> {
    throw new Error("signMessage not used by BasePay actions");
  }

  async signTypedData(typedData: unknown): Promise<`0x${string}`> {
    this.calls.push({
      kind: "signTypedData",
      detail: JSON.stringify(typedData, bigintSafe).slice(0, 200),
    });
    this.signedTypedDataMessages.push(typedData);
    // 65-byte signature: r (32) | s (32) | v (0x1b = 27)
    return `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  }

  async signTransaction(_transaction: TransactionRequest): Promise<`0x${string}`> {
    throw new Error("signTransaction not used by BasePay actions");
  }

  async sendTransaction(transaction: TransactionRequest): Promise<`0x${string}`> {
    this.calls.push({
      kind: "sendTransaction",
      detail: `to=${transaction.to} data=${String(transaction.data).slice(0, 66)}...`,
    });
    this.sentTxs.push(transaction);
    if (this.opts.sendDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.opts.sendDelayMs));
    }
    return `0x${"ab".repeat(32)}`;
  }

  async waitForTransactionReceipt(_txHash: `0x${string}`): Promise<unknown> {
    this.calls.push({ kind: "waitForTransactionReceipt", detail: this.opts.receiptStatus });
    return { status: this.opts.receiptStatus, transactionHash: `0x${"ab".repeat(32)}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async readContract(params: any): Promise<any> {
    this.calls.push({ kind: "readContract", detail: `allowance=${this.opts.allowance}` });
    return this.opts.allowance;
  }

  getPublicClient(): never {
    throw new Error("getPublicClient not used by BasePay actions");
  }

  // ---- harness helpers -------------------------------------------------

  count(kind: CallKind): number {
    return this.calls.filter(c => c.kind === kind).length;
  }

  /** True if any wallet authority step was reached (read, sign, or send). */
  walletTouched(): boolean {
    return this.count("readContract") + this.count("sendTransaction") + this.count("signTypedData") > 0;
  }
}
