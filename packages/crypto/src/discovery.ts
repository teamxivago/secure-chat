import { ristretto255_oprf } from "@noble/curves/ed25519.js";
import { fromB64, toB64, utf8, type Bytes } from "./bytes";

/**
 * Private contact discovery with an OPRF (RFC 9497, ristretto255-SHA512).
 * The client blinds each normalized phone number; the server evaluates the blinded point with
 * its secret key without learning the input; the client unblinds to obtain a token. Tokens of
 * registered users are precomputed server-side. The server never receives raw or plainly
 * hashed numbers from the address book, and unregistered contacts are never revealed.
 */

const oprf = ristretto255_oprf.oprf;

export interface BlindedContact {
  input: string;
  blind: Bytes;
  blinded: string;
}

export function normalizePhone(raw: string, defaultCountryCode = ""): string | null {
  let s = raw.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (!defaultCountryCode) return null;
    s = "+" + defaultCountryCode.replace(/\D/g, "") + s.replace(/^0+/, "");
  }
  return /^\+\d{7,15}$/.test(s) ? s : null;
}

export function blindContacts(phones: string[]): BlindedContact[] {
  return phones.map((input) => {
    const { blind, blinded } = oprf.blind(utf8(input));
    return { input, blind, blinded: toB64(blinded) };
  });
}

export function finalizeContacts(blinded: BlindedContact[], evaluated: string[]): Map<string, string> {
  const out = new Map<string, string>();
  blinded.forEach((b, i) => {
    out.set(toB64(oprf.finalize(utf8(b.input), b.blind, fromB64(evaluated[i]))), b.input);
  });
  return out;
}

/* ----- server side ----- */
export function generateDiscoveryKey(): string {
  return toB64(oprf.generateKeyPair().secretKey);
}

export function evaluateBlinded(secretKey: string, blinded: string): string {
  return toB64(oprf.blindEvaluate(fromB64(secretKey), fromB64(blinded)));
}

/** Token for a registered phone number (server computes this at sign-up). */
export function discoveryToken(secretKey: string, phone: string): string {
  const { blind, blinded } = oprf.blind(utf8(phone));
  const evaluated = oprf.blindEvaluate(fromB64(secretKey), blinded);
  return toB64(oprf.finalize(utf8(phone), blind, evaluated));
}
