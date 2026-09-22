// A simplified, in-memory phone verifier: send a one-time code, then check it.
//
// It follows the rules described in docs/06-phone-verification.md, without the database, sessions, HTTP or the
// WhatsApp API. Each call returns a plain object with an HTTP-style status so
// the demo can assert on what a client would see.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const SEND_WINDOW_MS = 60 * 60 * 1000; // one hour
export const MAX_SENDS = 3; // codes per number per window
export const CODE_TTL_MS = 10 * 60 * 1000; // a code is good for ten minutes
export const MAX_ATTEMPTS = 5; // wrong tries before a code is burned

/** Digits only, last ten, so "+91 00000 00001" and "00000-00001" are one number. */
export function normalisePhone(raw) {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

/**
 * What gets stored instead of the code. It has to be keyed: there are only a
 * million six-digit codes, so an unkeyed hash is undone by hashing them all.
 * The phone goes in too, so one code on two numbers never stores the same value.
 */
export function hashCode(key, phone, code) {
  return createHmac("sha256", key).update(`${phone}:${code}`).digest("hex");
}

const refuse = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * @param {object} opts
 * @param {string} opts.key                      hashing key (the demo passes a fake one)
 * @param {() => number} opts.clock              "now" in ms, so the demo can move time
 * @param {(phone: string, code: string) => void} opts.deliver  stands in for WhatsApp
 */
export function createVerifier({ key, clock, deliver }) {
  const accounts = new Map(); // id -> { phone, verified }

  // One pending code per number, keyed by the number. That is what makes the
  // send allowance belong to the phone rather than to whoever is asking.
  const pending = new Map(); // phone -> row

  const account = (id) => {
    if (!accounts.has(id)) accounts.set(id, { phone: null, verified: false });
    return accounts.get(id);
  };

  function send(accountId, rawPhone) {
    account(accountId); // stands in for "signed in"
    const phone = normalisePhone(rawPhone);
    if (phone.length !== 10) return refuse(400, "Enter a 10-digit mobile number.");

    // A number proved by one account isn't handed to another. Checked before a
    // code exists, so the owner's phone doesn't even get a message.
    for (const [id, other] of accounts) {
      if (id !== accountId && other.verified && other.phone === phone) {
        return refuse(409, "That number is already verified on another account.");
      }
    }

    const now = clock();
    const row = pending.get(phone);

    // A fixed window from the first send; three codes inside it, whoever asks.
    const inWindow = row && now - row.windowStart < SEND_WINDOW_MS;
    if (inWindow && row.sends >= MAX_SENDS) {
      return refuse(429, "Too many codes for this number. Try again in an hour.");
    }

    // randomInt draws from the CSPRNG; padStart keeps codes like 004211 six long.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

    // A new code replaces the old one, starts with fresh tries and belongs to
    // the account that asked. Only the hash is kept.
    pending.set(phone, {
      hash: hashCode(key, phone, code),
      expiresAt: now + CODE_TTL_MS,
      wrongTries: 0,
      sends: inWindow ? row.sends + 1 : 1,
      windowStart: inWindow ? row.windowStart : now,
      requestedBy: accountId,
    });

    deliver(phone, code);
    return { ok: true, status: 200 };
  }

  function verify(accountId, rawPhone, rawCode) {
    const me = account(accountId);
    const phone = normalisePhone(rawPhone);
    const code = String(rawCode ?? "").replace(/\D/g, "");
    if (phone.length !== 10) return refuse(400, "Enter a 10-digit mobile number.");
    if (code.length !== 6) return refuse(400, "Enter the 6-digit code.");

    const row = pending.get(phone);
    // No code, or someone else's: the same answer, and nobody's tries are spent.
    if (!row || row.requestedBy !== accountId) return refuse(400, "Ask for a new code.");
    if (row.expiresAt < clock()) return refuse(400, "That code has expired. Ask for a new one.");
    // Checked before the comparison, so a burned code stays burned even when
    // the next guess would have been right.
    if (row.wrongTries >= MAX_ATTEMPTS) return refuse(429, "Too many wrong tries. Ask for a new code.");

    const typed = Buffer.from(hashCode(key, phone, code));
    const stored = Buffer.from(row.hash);
    const match = typed.length === stored.length && timingSafeEqual(typed, stored);

    if (!match) {
      row.wrongTries += 1;
      return refuse(400, "That code doesn't match.", { triesLeft: MAX_ATTEMPTS - row.wrongTries });
    }

    // Spent on first use: the row goes before the account is marked, so there
    // is nothing left to replay.
    pending.delete(phone);
    me.phone = phone;
    me.verified = true;
    return { ok: true, status: 200, verified: true };
  }

  // Changing the number drops the tick: it was earned by the old number.
  function editPhone(accountId, rawPhone) {
    const me = account(accountId);
    me.phone = normalisePhone(rawPhone) || null;
    me.verified = false;
  }

  return {
    send,
    verify,
    editPhone,
    account: (id) => ({ ...account(id) }),
    // What a leaked record would show for a number: the row, never the code.
    leakRow: (phone) => (pending.has(phone) ? { ...pending.get(phone) } : undefined),
  };
}
