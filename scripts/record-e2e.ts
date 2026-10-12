/**
 * On-chain record, end to end.
 *
 * The harness proves the game; the contract test proves the contract. Nothing
 * proves the seam between them: that a match *finishing in the real room* turns
 * into a real Monad tx. The harness cannot show it -- it ends with
 * `process.exit(0)`, which kills the fire-and-forget write before the receipt
 * lands (see matchRecord.ts). So this script does the one thing neither suite
 * can: it boots the real server with short phases, plays a single client
 * through `ready -> countdown -> playing -> results`, then *waits on the chain*
 * until `matchCount()` increments, and reads the tx hash back out of the logs.
 *
 * It requires the hook to actually be configured (MATCH_RECORD_ENABLED=1 plus
 * MONAD_RPC_URL, MATCH_SIGNER_KEY and MATCH_RECORD_ADDRESS in tekk2/.env).
 * With the hook off it proves nothing, so it refuses to run and says why. It
 * never prints the signer key -- only the public address, tx and id.
 *
 * Run from tekk2/:  npx tsx scripts/record-e2e.ts
 * Costs one tiny testnet transaction (a fraction of a MON).
 */
import { Client } from '@colyseus/sdk';
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem } from 'viem';
import type { Address } from 'viem';

// Importing the hook loads tekk2/.env (loadEnvFile) and tells us whether the
// write path is even armed, so the guard below uses the same truth the server
// does -- not a second, drifting copy of the gate.
import { matchRecordingEnabled } from '../server/matchRecord.ts';
import { createGameServer } from '../server/index.ts';

/** Short phases: one whole match in a few seconds, with room to see results. */
const TIMINGS = { lobbyMs: 1500, countdownMs: 1000, durationMs: 4000, resultsMs: 3000 };

const EXPLORER = 'https://testnet.monadvision.com';

const MATCH_COUNT_ABI = parseAbi(['function matchCount() view returns (uint256)']);
const MATCH_REGISTERED = parseAbiItem(
  'event MatchRegistered(uint256 indexed matchId, address indexed winner, string courseId, uint8 mode, uint64 endedAt, uint8 playerCount)',
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `cond` holds or the deadline passes; returns the final verdict. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function bail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// --- gate: refuse to pretend ------------------------------------------------

if (!matchRecordingEnabled) {
  const missing = [
    ['MATCH_RECORD_ENABLED=1', process.env.MATCH_RECORD_ENABLED === '1'],
    ['MONAD_RPC_URL', Boolean(process.env.MONAD_RPC_URL)],
    ['MATCH_SIGNER_KEY', Boolean(process.env.MATCH_SIGNER_KEY)],
    ['MATCH_RECORD_ADDRESS', Boolean(process.env.MATCH_RECORD_ADDRESS)],
  ]
    .map(([name, ok]) => `  ${ok ? '[x]' : '[ ]'} ${name}`)
    .join('\n');
  bail(
    'The on-chain hook is not configured, so there is nothing to prove.\n' +
      'Set these in tekk2/.env and run again:\n' +
      missing,
  );
}

const rawAddress = process.env.MATCH_RECORD_ADDRESS;
const rpcUrl = process.env.MONAD_RPC_URL;
if (!rawAddress || !rpcUrl) bail('Missing MATCH_RECORD_ADDRESS or MONAD_RPC_URL.');

let address: Address;
try {
  address = getAddress(rawAddress);
} catch {
  bail(`MATCH_RECORD_ADDRESS is not a valid address: ${rawAddress}`);
}

// --- chain: baseline before we play -----------------------------------------

const chain = createPublicClient({ transport: http(rpcUrl) });

const chainId = await chain.getChainId();
if (chainId !== 10_143) {
  bail(`RPC answers chain ${chainId}, expected 10143 (Monad Testnet).`);
}

const matchCountBefore = await chain.readContract({
  address,
  abi: MATCH_COUNT_ABI,
  functionName: 'matchCount',
});
const startBlock = await chain.getBlockNumber();

console.log(
  `\nMatchRecord: ${address}\n` +
    `chain 10143, matchCount=${matchCountBefore}, watching from block ${startBlock}\n`,
);

// --- play one match to results ----------------------------------------------

const PORT = 25700 + Math.floor(Math.random() * 300);
const { gameServer } = createGameServer({ matchTimings: TIMINGS });
await gameServer.listen(PORT, '127.0.0.1');

const client = new Client(`ws://127.0.0.1:${PORT}`);
let exitCode = 1;
try {
  const room = await client.joinOrCreate('race', { name: 'OnChainProof' });
  console.log(`joined room ${room.roomId} on 127.0.0.1:${PORT}`);

  if (!(await until(() => (room.state.catalog?.length ?? 0) > 0, 10_000))) {
    bail('the catalog never arrived -- the room did not finish booting');
  }

  // One client is enough to end a match: the vote skips the lobby, the clock
  // runs out, and enterResults records the room's racers even if nobody held
  // the Core (a `hold` draw still has players to write).
  const courseId: string = room.state.catalog[0]!.id;
  room.send('vote', { courseId });
  console.log(`voted for ${courseId}; waiting for the match to end...`);

  const finished = await until(() => room.state.phase === 'results', 20_000);
  if (!finished) bail(`the match never reached results (phase=${room.state.phase})`);
  console.log('results reached; waiting for the record to land on Monad...');

  // The server writes fire-and-forget, so the tx is in flight now: poll the
  // chain (not the server) until matchCount grows, with a generous deadline.
  let matchCountAfter = matchCountBefore;
  const landed = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      matchCountAfter = await chain.readContract({
        address,
        abi: MATCH_COUNT_ABI,
        functionName: 'matchCount',
      });
      if (matchCountAfter > matchCountBefore) return true;
      await sleep(1500);
    }
    return false;
  })();

  if (!landed) {
    console.error(
      `\nmatchCount stayed at ${matchCountBefore} for 60s -- the write did not\n` +
        'land. Check the server log above for a [matchRecord] error.\n',
    );
    await room.leave();
    process.exit(1);
  }

  // Recover the tx itself from the new logs so the output is a link, not a claim.
  const logs = await chain.getLogs({
    address,
    event: MATCH_REGISTERED,
    fromBlock: startBlock,
    toBlock: 'latest',
  });
  const latest = logs.at(-1);

  console.log(`\nPASS: matchCount ${matchCountBefore} -> ${matchCountAfter}`);
  if (latest) {
    const { matchId, courseId: logged, playerCount } = latest.args;
    console.log(
      `  tx           ${latest.transactionHash}\n` +
        `  matchId      ${matchId} (${logged}, ${playerCount} player${playerCount === 1 ? '' : 's'})\n` +
        `  explorer     ${EXPLORER}/tx/${latest.transactionHash}`,
    );
  } else {
    console.log('  (no MatchRegistered log seen in range, but matchCount grew)');
  }
  exitCode = 0;

  await room.leave();
} catch (err) {
  console.error('\nFAIL:', err instanceof Error ? err.message : err);
} finally {
  await gameServer.gracefullyShutdown(false).catch(() => {});
}

process.exit(exitCode);
