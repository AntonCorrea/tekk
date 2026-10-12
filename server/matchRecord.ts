/**
 * MatchRecord -- the on-chain hook (Stage 1).
 *
 * When a match ends, the room asks this module to write the result to the
 * MatchRecord contract on Monad testnet, so every finished match produces a
 * real tx hash the demo can point at.
 *
 * Fail-open by design: unless MATCH_RECORD_ENABLED=1 AND MONAD_RPC_URL AND
 * MATCH_SIGNER_KEY AND MATCH_RECORD_ADDRESS are all present, `recordMatch` is
 * a silent no-op. The game, the harness and the smoke suites run unchanged
 * with no chain wired up, and nothing here ever blocks the match loop -- a
 * write is fire-and-forget, errors only logged.
 *
 * Secrets stay in env: this file reads process.env (loading tekk2/.env via
 * Node's built-in `process.loadEnvFile`, so there is no dotenv dependency)
 * and never prints or persists a key.
 *
 * Stage 1 honesty: racers have no on-chain identities yet, so `winner` and
 * every player `wallet` go out as the zero address. Stage 3 (Privy) replaces
 * them with real embedded-wallet addresses without touching the contract.
 */
import { loadEnvFile } from 'node:process';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { GameMode } from '../src/shared/course.ts';

try {
  loadEnvFile(); // tekk2/.env, optional -- otherwise env comes from the shell
} catch {
  // no .env present; rely on the shell environment
}

/** Zero address: the guest placeholder until Stage 3 attaches wallets. */
export const ZERO_WALLET = '0x0000000000000000000000000000000000000000' as Hex;

/** Course mode -> on-chain mode code (matches MatchRecord.sol constants). */
const MODE_CODES: Record<GameMode, number> = { hold: 0, reach: 1, hunt: 2 };

const monadTestnet = defineChain({
  id: 10_143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' },
  },
});

const MATCH_RECORD_ABI = [
  {
    type: 'function',
    name: 'registerMatch',
    inputs: [
      { type: 'string', name: 'courseId' },
      { type: 'uint8', name: 'mode' },
      { type: 'address', name: 'winner' },
      {
        type: 'tuple[]',
        name: 'players',
        components: [
          { type: 'address', name: 'wallet' },
          { type: 'uint64', name: 'holdMs' },
          { type: 'int64', name: 'finishMs' },
          { type: 'uint8', name: 'coresFound' },
        ],
      },
    ],
    outputs: [{ type: 'uint256', name: 'matchId' }],
    stateMutability: 'nonpayable',
  },
] as const;

const cfg = {
  enabled: process.env.MATCH_RECORD_ENABLED === '1',
  rpcUrl: process.env.MONAD_RPC_URL,
  signerKey: process.env.MATCH_SIGNER_KEY,
  rawAddress: process.env.MATCH_RECORD_ADDRESS,
};

let contractAddress: Hex | null = null;
try {
  contractAddress = cfg.rawAddress ? getAddress(cfg.rawAddress) : null;
} catch {
  contractAddress = null; // malformed MATCH_RECORD_ADDRESS -> stay disabled
}

/** True when the server will actually write match records to Monad. */
export const matchRecordingEnabled =
  cfg.enabled && Boolean(cfg.rpcUrl && cfg.signerKey && contractAddress);

const account =
  matchRecordingEnabled && cfg.signerKey
    ? privateKeyToAccount(cfg.signerKey as Hex)
    : undefined;
const transport = http(cfg.rpcUrl ?? 'https://testnet-rpc.monad.xyz');
const walletClient = createWalletClient({ account, chain: monadTestnet, transport });
const publicClient = createPublicClient({ chain: monadTestnet, transport });

/** One racer's result, ready to encode. */
export interface PlayerRecord {
  wallet: Hex;
  holdMs: number;
  finishMs: number;
  coresFound: number;
}

/** A finished match, as the server sees it. */
export interface MatchRecord {
  courseId: string;
  mode: GameMode;
  winner: Hex | null;
  players: PlayerRecord[];
}

/**
 * Count set bits in a hunt `coreMask` -- how many hidden cores a racer found.
 */
export function popcount(mask: number): number {
  let count = 0;
  for (let m = mask; m > 0; m &= m - 1) count += 1;
  return count;
}

/**
 * Record a finished match on-chain. Fire-and-forget: never blocks the room,
 * never throws into the match loop; failures are logged and the game goes on.
 * No-op when the hook is not configured.
 */
export function recordMatch(record: MatchRecord): void {
  if (!matchRecordingEnabled || !contractAddress) return;
  void writeMatch(record).catch((error) => {
    console.error(`[matchRecord] failed to record match (${record.courseId}):`, error);
  });
}

async function writeMatch(record: MatchRecord): Promise<void> {
  if (!contractAddress || !account) return;
  const winner = record.winner ?? ZERO_WALLET;
  const players = record.players.map((p) => ({
    wallet: p.wallet,
    holdMs: BigInt(Math.max(0, Math.trunc(p.holdMs))),
    finishMs: BigInt(Math.trunc(p.finishMs)),
    coresFound: p.coresFound,
  }));

  const hash = await walletClient.writeContract({
    address: contractAddress,
    account,
    abi: MATCH_RECORD_ABI,
    functionName: 'registerMatch',
    args: [record.courseId, MODE_CODES[record.mode], winner, players],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    `[matchRecord] match ${receipt.transactionHash} on-chain` +
      ` (course ${record.courseId}, ${players.length} players, mode ${record.mode})`,
  );
}