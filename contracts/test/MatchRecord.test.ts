/**
 * MatchRecord contract tests, run with `npm test` (npx hardhat test).
 *
 * Uses the default in-memory Hardhat network -- no chain, no env, no secrets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";

const { viem } = await hre.network.create();

test("registering a match emits a header event and one PlayerScored per racer", async () => {
  const [deployer] = await viem.getWalletClients();
  assert.ok(deployer, "default network must expose a wallet client");
  const registrar = deployer.account.address;
  const nobody = "0x0000000000000000000000000000000000000000";

  const record = await viem.deployContract("MatchRecord", [registrar]);
  assert.ok(record.address, "deployed MatchRecord has an address");

  const players = [
    { wallet: registrar, holdMs: 12_345n, finishMs: -1n, coresFound: 0 },
    { wallet: nobody, holdMs: 0n, finishMs: 9_876n, coresFound: 5 },
  ];
  const tx = await record.write.registerMatch(["takk-test", 2, registrar, players]);
  const publicClient = await viem.getPublicClient();
  await publicClient.waitForTransactionReceipt({ hash: tx });

  assert.equal(await record.read.matchCount(), 1n);
  // The public `matches(uint256)` getter decodes the struct as a row:
  // (winner, courseId, mode, endedAt, playerCount). hardhat-viem doesn't type
  // the decode against artifacts, so cast the row explicitly.
  const row = (await record.read.matches([1n])) as unknown as readonly [
    winner: string,
    courseId: string,
    mode: number,
    endedAt: bigint,
    playerCount: number,
  ];
  assert.equal(row[1], "takk-test");
  assert.equal(row[2], 2);
  assert.equal(row[4], 2);
  assert.equal(row[0].toLowerCase(), registrar.toLowerCase());
});

test("only the registrar may register a match", async () => {
  const [deployer] = await viem.getWalletClients();
  assert.ok(deployer);
  const stranger = "0x1111111111111111111111111111111111111111";

  // The deployer is NOT the registrar: the registrar was set to `stranger`.
  const record = await viem.deployContract("MatchRecord", [stranger]);
  await assert.rejects(
    record.write.registerMatch(["takk-arena", 0, stranger, []]),
    /NotRegistrar/,
  );
});