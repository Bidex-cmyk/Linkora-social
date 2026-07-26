/**
 * Authentication utilities for DM relay service.
 *
 * Verifies Stellar signatures to prevent unauthorized message submission.
 */

import { randomUUID } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { sha256 } from "@noble/hashes/sha256";

export interface AuthData {
  sender: string;
  to: string;
  nonce: number;
  timestamp: number;
  signature: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  private readonly maxTimestampSkew: number;
  private readonly stellarNetwork: string;

  constructor(maxTimestampSkew: number = 30, stellarNetwork: string = "Testnet") {
    this.maxTimestampSkew = maxTimestampSkew;
    this.stellarNetwork = stellarNetwork;
  }

  /**
   * Verify that a message submission is authentically signed by the sender.
   *
   * @param authData - Authentication data from the request
   * @returns true if authentication is valid
   * @throws AuthError if authentication fails
   */
  verifyMessageAuth(authData: AuthData): boolean {
    const { sender, to, nonce, timestamp, signature } = authData;

    // Validate Stellar address formats
    if (!StrKey.isValidEd25519PublicKey(sender)) {
      throw new AuthError("Invalid sender address format");
    }
    if (!StrKey.isValidEd25519PublicKey(to)) {
      throw new AuthError("Invalid recipient address format");
    }

    // Check timestamp freshness (prevent replay attacks)
    const now = Math.floor(Date.now() / 1000);
    const timestampSkew = Math.abs(now - timestamp);

    if (timestampSkew > this.maxTimestampSkew) {
      throw new AuthError(
        `Timestamp too old or too far in future. Skew: ${timestampSkew}s, max: ${this.maxTimestampSkew}s`
      );
    }

    // Verify signature over {to, nonce, timestamp}
    try {
      const isValid = this.verifySignature(sender, to, nonce, timestamp, signature);
      if (!isValid) {
        throw new AuthError("Invalid signature");
      }
      return true;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError(`Signature verification failed: ${error}`);
    }
  }

  /**
   * Verify the Stellar signature. Message is sha256(to + ":" + nonce + ":" + timestamp).
   */
  private verifySignature(
    sender: string,
    to: string,
    nonce: number,
    timestamp: number,
    signatureHex: string
  ): boolean {
    const authMessage = `${to}:${nonce}:${timestamp}`;
    const hash = sha256(new TextEncoder().encode(authMessage));

    const signature = Buffer.from(signatureHex, "hex");
    if (signature.length !== 64) {
      throw new AuthError("Invalid signature length");
    }

    const keypair = Keypair.fromPublicKey(sender);
    return keypair.verify(Buffer.from(hash), signature);
  }

  /**
   * Create an auth signature for testing: signs sha256(to + ":" + nonce + ":" + timestamp).
   */
  static createAuthSignature(
    keypair: Keypair,
    to: string,
    nonce: number,
    timestamp: number
  ): string {
    const authMessage = `${to}:${nonce}:${timestamp}`;
    const hash = sha256(new TextEncoder().encode(authMessage));
    const signature = keypair.sign(Buffer.from(hash));
    return Buffer.from(signature).toString("hex");
  }

  /**
   * Create a WebSocket challenge for the given address.
   * Returns the challenge string the client must sign and the timestamp.
   */
  createWsChallenge(address: string): { challenge: string; timestamp: number } {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new AuthError("Invalid address format");
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const challenge = `ws_challenge:${address}:${nonce}:${timestamp}`;
    return { challenge, timestamp };
  }

  /**
   * Verify a WebSocket challenge-response signature.
   *
   * @param address - The Stellar address claiming to own the connection
   * @param challenge - The original challenge string sent by the server
   * @param timestamp - The timestamp from the challenge
   * @param signatureHex - The client's Ed25519 signature (hex-encoded)
   * @throws AuthError if verification fails
   */
  verifyWsChallenge(
    address: string,
    challenge: string,
    timestamp: number,
    signatureHex: string
  ): void {
    // Validate address format
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new AuthError("Invalid address format");
    }

    // Check timestamp freshness
    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - timestamp);
    if (skew > this.maxTimestampSkew) {
      throw new AuthError(
        `Challenge timestamp expired. Skew: ${skew}s, max: ${this.maxTimestampSkew}s`
      );
    }

    // Verify the challenge format matches what we'd generate
    const expectedPrefix = `ws_challenge:${address}:`;
    if (!challenge.startsWith(expectedPrefix)) {
      throw new AuthError("Invalid challenge format");
    }

    // Verify signature
    const hash = sha256(new TextEncoder().encode(challenge));
    const signature = Buffer.from(signatureHex, "hex");
    if (signature.length !== 64) {
      throw new AuthError("Invalid signature length");
    }

    const keypair = Keypair.fromPublicKey(address);
    const valid = keypair.verify(Buffer.from(hash), signature);
    if (!valid) {
      throw new AuthError("Invalid WebSocket challenge signature");
    }
  }
}
