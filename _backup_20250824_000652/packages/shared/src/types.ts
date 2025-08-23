export type Side = 'LONG' | 'SHORT';

export interface OrderIntent {
  symbol: string;
  side: Side;
  orderType: 'MARKET' | 'LIMIT';
  quantity: string; // decimal as string
  price?: string;
  leverage: number;
  clientId: string; // nonce/ulid
}

export interface EncryptedSignal {
  version: '1';
  strategy_id: string;
  user: string; // 0x…
  ts: number;
  payload: {
    symbol: string;
    side: Side;
    qty: number;
    tp?: number;
    sl?: number;
    leverage?: number;
  };
  cipher: {
    alg: 'AES-256-GCM';
    iv: string;       // base64 12B
    aad: string;      // base64
    ciphertext: string;
    tag: string;      // base64
  };
  payload_hash: string; // sha3-256-hex
  nonce: string;        // ulid
}
