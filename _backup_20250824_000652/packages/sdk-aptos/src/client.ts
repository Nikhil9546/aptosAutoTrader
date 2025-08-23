/**
 * Placeholder for Aptos SDK wrapper.
 * Later: import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
 */
export class AptosClientPlaceholder {
  constructor(readonly network: 'TESTNET'|'DEVNET'|'LOCAL'='TESTNET') {}
  async publishInfo() { return { network: this.network, ok: true }; }
}
