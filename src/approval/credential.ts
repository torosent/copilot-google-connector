import { createPublicKey } from "node:crypto";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { StateStore } from "../core/state.js";

export const APPROVAL_ENROLLMENT_KEY = "approval-enrollment";
export const RP_ID = "localhost";
export const ALGORITHMS = [-7, -8, -257] as const;

export function base64url(maxBytes: number) {
  return z.string().min(1).max(Math.ceil(maxBytes * 4 / 3)).regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
}

const transports = z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).max(8);
const counter = z.number().int().min(0).max(0xffffffff);
const enrollmentSchema = z.object({
  version: z.literal(1),
  rpID: z.literal(RP_ID),
  generation: z.uuid(),
  userId: base64url(64).refine((value) => Buffer.from(value, "base64url").length >= 16),
  createdAt: z.number().int().positive(),
  credential: z.object({
    id: base64url(1024),
    publicKey: base64url(8192),
    counter,
    transports: transports.optional(),
  }).strict(),
  credentialDeviceType: z.enum(["singleDevice", "multiDevice"]),
  credentialBackedUp: z.boolean(),
}).strict();

export type EnrollmentRecord = z.infer<typeof enrollmentSchema>;

// Validate the stored COSE key as well as its JSON envelope. Corruption must never
// turn a configured installation into an unconfigured, enrollable installation.
export function validateEnrollment(value: unknown): EnrollmentRecord {
  try {
    const record = enrollmentSchema.parse(value);
    if (record.credentialDeviceType === "singleDevice" && record.credentialBackedUp) throw new Error();
    const key = decodeCredentialPublicKey(new Uint8Array(Buffer.from(record.credential.publicKey, "base64url")));
    if (!(key instanceof Map)) throw new Error();
    const component = (id: number, min: number, max = min) => {
      const bytes: unknown = key.get(id);
      if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) throw new Error();
      return Buffer.from(bytes).toString("base64url");
    };
    if (key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1) {
      createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: component(-2, 32), y: component(-3, 32) } });
    } else if (key.get(1) === 1 && key.get(3) === -8 && key.get(-1) === 6) {
      createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: component(-2, 32) } });
    } else if (key.get(1) === 3 && key.get(3) === -257) {
      createPublicKey({ format: "jwk", key: { kty: "RSA", n: component(-1, 256, 1024), e: component(-2, 1, 4) } });
    } else {
      throw new Error();
    }
    return record;
  } catch {
    throw new ConnectorError("approval_enrollment_corrupt", "The approval enrollment is invalid. Do not automatically reset it; use the documented trusted maintenance procedure.");
  }
}

export async function readEnrollment(state: StateStore): Promise<EnrollmentRecord | undefined> {
  const value = await state.read<unknown>(APPROVAL_ENROLLMENT_KEY);
  return value === undefined ? undefined : validateEnrollment(value);
}

const credentialCommon = {
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
};

export const authenticationSchema = z.object({
  ...credentialCommon,
  response: z.object({
    clientDataJSON: base64url(4096),
    authenticatorData: base64url(4096),
    signature: base64url(2048),
    userHandle: base64url(64).optional(),
  }).strict(),
}).strict().refine((value) => value.id === value.rawId);

export const registrationSchema = z.object({
  ...credentialCommon,
  response: z.object({
    clientDataJSON: base64url(4096),
    attestationObject: base64url(49152),
    transports: transports.optional(),
  }).strict(),
}).strict().refine((value) => value.id === value.rawId);
