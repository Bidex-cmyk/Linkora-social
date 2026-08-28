import { LinkoraClient } from "../../../../packages/sdk/src/client";

const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "CDUMMY";
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";

export interface PoolData {
  id: string;
  token: string;
  balance: bigint;
  adminCount: number;
  threshold: number;
}

/**
 * Fetch all pools from the indexer.
 * Falls back to an empty array when the indexer is unreachable.
 */
export async function fetchPools(): Promise<PoolData[]> {
  try {
    const res = await fetch(`${INDEXER_URL}/api/pools`);
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.pools ?? [];
    return list.map((p: any) => ({
      id: p.pool_id ?? p.id,
      token: p.token,
      balance: BigInt(p.balance ?? 0),
      adminCount: Array.isArray(p.admins) ? p.admins.length : (p.admin_count ?? 0),
      threshold: p.threshold ?? 1,
    }));
  } catch {
    return [];
  }
}

/**
 * Check whether the contract is currently paused. While paused, write
 * operations (compose/tip/follow) will fail simulation.
 * Fails open (returns false) if the RPC can't be reached, so a transient
 * network error doesn't falsely block the whole app.
 */
export async function fetchIsPaused(): Promise<boolean> {
  try {
    const client = new LinkoraClient({ contractId: CONTRACT_ID, rpcUrl: RPC_URL });
    return await client.isPaused();
  } catch {
    return false;
  }
}
