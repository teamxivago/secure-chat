import { z } from "zod";
import { evaluateBlinded } from "@veil/crypto";
import { authenticate, HttpError, json, limit, parseBody, route } from "@/lib/server/http";
import { env } from "@/lib/server/env";

/** OPRF evaluation of blinded phone numbers. The server learns nothing about the inputs. */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const { blinded } = await parseBody(req, z.object({ blinded: z.array(z.string().max(64)).min(1).max(2000) }));
  // Rate-limit evaluations to make enumeration through the oracle impractical.
  await limit(`oprf:${ctx.userId}`, 5000, 86400);
  await limit(`oprf-burst:${ctx.userId}`, 2000, 60);
  if (!env.discoveryKey) throw new HttpError(503, "contact discovery is not configured");
  try {
    return json({ evaluated: blinded.map((b) => evaluateBlinded(env.discoveryKey, b)) });
  } catch {
    throw new HttpError(400, "invalid blinded element");
  }
});
