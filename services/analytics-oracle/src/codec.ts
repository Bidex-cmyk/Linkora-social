import { encode } from "cbor-x";
import { sha256 } from "@noble/hashes/sha256";
import { AnalyticsReport } from "./types.js";

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

const CREATOR_BYTE_LENGTH = 32;
const U8_MAX = 255;

function isNonNegativeBigint(v: bigint): boolean {
  return v >= 0n;
}

function isPositiveBigint(v: bigint): boolean {
  return v > 0n;
}

/**
 * Validates all fields of an AnalyticsReport against the on-chain schema constraints.
 *
 * @throws {ValidationError} if any field fails validation.
 */
export function validateReport(report: AnalyticsReport): void {
  if (!Number.isInteger(report.version) || report.version < 0 || report.version > U8_MAX) {
    throw new ValidationError(
      `version must be a u8 integer (0-255), got ${report.version}`,
      "version",
      report.version
    );
  }

  if (!(report.creator instanceof Uint8Array) || report.creator.length !== CREATOR_BYTE_LENGTH) {
    throw new ValidationError(
      `creator must be a ${CREATOR_BYTE_LENGTH}-byte Ed25519 public key, got ${report.creator?.length ?? typeof report.creator} bytes`,
      "creator",
      report.creator
    );
  }

  if (!isPositiveBigint(report.windowStart)) {
    throw new ValidationError(
      `windowStart must be a positive integer, got ${report.windowStart}`,
      "windowStart",
      report.windowStart
    );
  }

  if (!isPositiveBigint(report.windowEnd)) {
    throw new ValidationError(
      `windowEnd must be a positive integer, got ${report.windowEnd}`,
      "windowEnd",
      report.windowEnd
    );
  }

  if (report.windowStart >= report.windowEnd) {
    throw new ValidationError(
      `windowStart (${report.windowStart}) must be less than windowEnd (${report.windowEnd})`,
      "windowStart",
      report.windowStart
    );
  }

  if (!isNonNegativeBigint(report.totalTips)) {
    throw new ValidationError(
      `totalTips must be non-negative, got ${report.totalTips}`,
      "totalTips",
      report.totalTips
    );
  }

  if (!isNonNegativeBigint(report.postCount)) {
    throw new ValidationError(
      `postCount must be non-negative, got ${report.postCount}`,
      "postCount",
      report.postCount
    );
  }

  if (!isNonNegativeBigint(report.followerDelta)) {
    throw new ValidationError(
      `followerDelta must be non-negative, got ${report.followerDelta}`,
      "followerDelta",
      report.followerDelta
    );
  }

  if (!Number.isInteger(report.uniqueTippers) || report.uniqueTippers < 0) {
    throw new ValidationError(
      `uniqueTippers must be a non-negative integer, got ${report.uniqueTippers}`,
      "uniqueTippers",
      report.uniqueTippers
    );
  }
}

/**
 * Encodes an AnalyticsReport as a CBOR array in canonical field order.
 *
 * Field order matches the on-chain schema defined in ADR-006:
 *   [version, creator, window_start, window_end, total_tips, post_count, follower_delta, unique_tippers]
 *
 * @throws {ValidationError} if the report fields are invalid.
 */
export function encodeReport(report: AnalyticsReport): Buffer {
  validateReport(report);

  const array = [
    report.version,
    report.creator,
    report.windowStart,
    report.windowEnd,
    report.totalTips,
    report.postCount,
    report.followerDelta,
    report.uniqueTippers,
  ];
  return Buffer.from(encode(array));
}

/**
 * Returns the SHA-256 digest of the serialised report bytes.
 */
export function hashReport(reportCbor: Buffer): Buffer {
  return Buffer.from(sha256(reportCbor));
}
