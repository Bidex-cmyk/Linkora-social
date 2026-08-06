/**
 * Tests for submitAttestation — verifies that the rpc.Server instance is
 * accepted as a parameter and reused across multiple calls (not recreated).
 */

import { submitAttestation } from "../submitter.js";
import { rpc, Keypair } from "@stellar/stellar-sdk";
import { jest } from "@jest/globals";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock rpc.Server that records how many times it is used. */
function mockServer(): rpc.Server & { callCount: number } {
  const account = {
    accountId: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
    sequence: "100",
  };

  const mock = {
    callCount: 0,
    getAccount: jest.fn(async () => {
      mock.callCount++;
      return account;
    }),
    prepareTransaction: jest.fn(async (tx: unknown) => {
      // Return a transaction-like object with a sign() stub
      return { ...(tx as object), sign: jest.fn() };
    }),
    sendTransaction: jest.fn(async () => ({ hash: "mock-tx-hash" })),
    pollTransaction: jest.fn(async () => ({ status: "SUCCESS" })),
  };

  return mock as unknown as rpc.Server & { callCount: number };
}

function makeKeypair(): Keypair {
  return Keypair.random();
}

// Silence logger
jest.mock("../logger.js", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("submitAttestation — rpc.Server reuse", () => {
  it("accepts an rpc.Server instance and uses it without creating a new one", async () => {
    const server = mockServer();
    const keypair = makeKeypair();

    await submitAttestation(
      server,
      "Test SDF Network ; September 2015",
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      "oracle",
      Buffer.from("report"),
      Buffer.from("signature"),
      keypair,
      keypair.publicKey(),
      1000n,
      2000n
    );

    // The server's getAccount was called — confirming the passed instance was used
    expect(server.getAccount).toHaveBeenCalledTimes(1);
    expect(server.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("reuses the same server instance across multiple submitAttestation calls", async () => {
    const server = mockServer();
    const keypair = makeKeypair();

    const args = [
      server,
      "Test SDF Network ; September 2015",
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      "oracle",
      Buffer.from("report"),
      Buffer.from("sig"),
      keypair,
    ] as const;

    await submitAttestation(...args, keypair.publicKey(), 1000n, 2000n);
    await submitAttestation(...args, keypair.publicKey(), 2001n, 3000n);
    await submitAttestation(...args, keypair.publicKey(), 3001n, 4000n);

    // getAccount called once per submission — all on the same server instance
    expect(server.getAccount).toHaveBeenCalledTimes(3);
    expect(server.callCount).toBe(3);

    // All three calls went to the exact same mock object
    const allCalls = (server.getAccount as unknown as jest.Mock).mock.instances;
    expect(allCalls.every((inst) => inst === server)).toBe(true);
  });
});
