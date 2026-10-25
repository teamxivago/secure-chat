import { blindContacts, finalizeContacts, normalizePhone } from "@veil/crypto";
import type { PublicUser } from "@veil/shared";
import { kvGet, kvSet } from "../lib/db";
import { isNative } from "../lib/platform";
import { ctx } from "./context";
import { primeUser, setLocalName } from "./users";
import { vaultWrite } from "./vault";

/**
 * Private contact discovery: phone numbers are blinded on-device (OPRF), the server evaluates
 * blinded points it can't invert, and matching happens on tokens. Raw numbers never leave the device.
 */

export interface PhoneContact {
  name: string;
  phones: string[];
}

export async function readDeviceContacts(): Promise<PhoneContact[]> {
  if (isNative()) {
    const { Contacts } = await import("@capacitor-community/contacts");
    const perm = await Contacts.requestPermissions();
    if (perm.contacts !== "granted") throw new Error("Contacts permission denied");
    const r = await Contacts.getContacts({ projection: { name: true, phones: true } });
    return r.contacts.map((c) => ({ name: c.name?.display ?? [c.name?.given, c.name?.family].filter(Boolean).join(" "), phones: (c.phones ?? []).map((p) => p.number ?? "").filter(Boolean) }));
  }
  // Web: Contact Picker API (Chrome Android) — user picks contacts explicitly.
  const nav = navigator as Navigator & { contacts?: { select(props: string[], opts: { multiple: boolean }): Promise<{ name?: string[]; tel?: string[] }[]> } };
  if (!nav.contacts) throw new Error("Contact access isn't supported in this browser");
  const picked = await nav.contacts.select(["name", "tel"], { multiple: true });
  return picked.map((p) => ({ name: p.name?.[0] ?? "", phones: p.tel ?? [] }));
}

export async function syncPhoneContacts(contacts: PhoneContact[], defaultCountryCode: string): Promise<PublicUser[]> {
  const nameByPhone = new Map<string, string>();
  for (const c of contacts) for (const p of c.phones) {
    const n = normalizePhone(p, defaultCountryCode);
    if (n) nameByPhone.set(n, c.name);
  }
  const phones = [...nameByPhone.keys()];
  const matched: PublicUser[] = [];
  for (let i = 0; i < phones.length; i += 1000) {
    const blinded = blindContacts(phones.slice(i, i + 1000));
    const { evaluated } = await ctx.api.contacts.discover(blinded.map((b) => b.blinded));
    const tokens = finalizeContacts(blinded, evaluated);
    const { matches } = await ctx.api.contacts.match([...tokens.keys()]);
    for (const m of matches) {
      const phone = tokens.get(m.token);
      const local = phone ? nameByPhone.get(phone) : undefined;
      primeUser(m.user);
      if (local) {
        await setLocalName(m.user.id, local);
        vaultWrite("contact", m.user.id, { name: local });
      }
      matched.push(m.user);
    }
  }
  if (matched.length) await ctx.api.contacts.add(matched.map((u) => u.id));
  await kvSet("contacts:lastSync", Date.now());
  return matched;
}

export async function addContact(user: PublicUser, localName?: string) {
  await ctx.api.contacts.add([user.id]);
  if (localName) {
    await setLocalName(user.id, localName);
    vaultWrite("contact", user.id, { name: localName });
  }
}

export async function removeContact(userId: string) {
  await ctx.api.contacts.remove([userId]);
  await setLocalName(userId, undefined);
  vaultWrite("contact", userId, null);
}


export async function setBlocked(userId: string, block: boolean) {
  if (block) await ctx.api.users.block(userId);
  else await ctx.api.users.unblock(userId);
  const list = new Set((await kvGet<string[]>("blocked")) ?? []);
  if (block) list.add(userId);
  else list.delete(userId);
  await kvSet("blocked", [...list]);
  vaultWrite("settings", "blocked", [...list]);
}
