# Verifying a phone number over WhatsApp (one-time codes)

Shipped in July 2026.

## What problem it solves

An account's phone field that accepts anything proves nothing about the number on it. The aim here is to make the number trustworthy enough to act as an identity: a verified flag shows in account settings, and the send step will not start verifying a number that another account has already verified.

The proof is a six-digit code sent to the number over WhatsApp and typed back by the signed-in user. The work is in resisting four abuses: guessing a code, replaying one, using the send endpoint to make a stranger's phone buzz, and claiming a number another account has already proved.

## How it works

There are two endpoints, one that sends a code and one that checks it, and both require a signed-in account. Each normalises the number by keeping only digits and taking the last ten, so the same number typed with or without `+91`, spaces or dashes maps to the same pending code.

```
 settings page                server                              WhatsApp
 POST send {phone}  ------->  digits only, last ten
                              verified on another account? --> 409
                              3 codes to this number this hour? --> 429
                              code = random 000000..999999
                              upsert the row for this number:
                                hash(code), expires in 10 min,
                                tries 0, sends + 1, who asked
                              send the code  -------------------->  phone

 POST verify {phone, code} -> no row, or another account's? --> 400
                              expired? --> 400   5 wrong tries? --> 429
                              hash(typed) == stored hash?
                                no:  tries + 1 --> 400 with tries left
                                yes: delete the row, mark verified
```

The code comes from a cryptographically secure random generator (`crypto.randomInt` in Node), zero-padded to six digits, and is valid for ten minutes. There is one pending record per phone number. It holds the code's hash, the expiry, the wrong-try count, the send count and window start, and the account that asked. The record is written before the message goes out, so a failed send still counts against the hour.

Saving a different number in the profile clears the verified flag.

## The decisions that matter

**The code is stored only as a keyed hash.** A six-digit code has a million possible values, so a plain SHA-256 of it, even with the phone number mixed in, is undone by hashing every candidate. Hashing the number and the code together with a server-side secret (a pepper, or an HMAC key) means the hash cannot be rebuilt from the phone number alone. A leaked record is then not a working code, and someone holding the record but not the secret has nothing to test guesses against. The plaintext code is never written to the database, and hashes are compared with `crypto.timingSafeEqual` after a length check.

**A code works once.** On a match, the pending record is deleted before the account is marked verified, so submitting the code again finds nothing. Because the record is keyed by number, a new request overwrites the old one, and only the latest code for a number is ever valid.

**Five wrong tries burn the code.** The count lives on the code's record, so a new browser or session doesn't reset it. It is checked before the comparison: after five misses, even the right code gets 429, and the only way on is a new code, which costs one of the number's sends. A new code starts with fresh tries, so this limit only works together with the send limit below.

**Sends are limited per number, not per account.** The limit protects the phone. If it were per account, anyone could message a stranger's WhatsApp as often as they cared to make accounts, and each fresh code would bring five fresh guesses. The counter sits on the number's record, so the fourth request in the window is refused whichever account asks. The window is fixed: it starts at the first send, and the first send an hour or more later opens a new one. The cost is that anyone signed in can request codes for someone else's number, replacing that person's pending code and using up the allowance, so the real owner may have to wait out the hour. One owner waiting is a smaller harm than a phone that buzzes on demand.

**A pending code belongs to the account that asked.** The check step compares the record's owner with the signed-in account. Any other account gets the same "ask for a new code" whether or not a code exists, and the owner's tries are untouched. So a stranger cannot burn your code by guessing from their own account.

**A verified number is not handed over.** If another account already has the number verified, the send step answers 409 before a code is generated, so the owner's phone gets no message either. The number becomes claimable again when its owner saves a different phone, which clears their tick. Keeping the tick after an edit would vouch for a number nobody had proved.

## The demo

```
node demos/06-phone-verification/demo.mjs
```

`verifier.mjs` is a simplified, original in-memory reimplementation of both endpoints, with a fake key, a movable clock and an outbox standing in for WhatsApp. `demo.mjs` walks through nine steps and checks each with `node:assert/strict`:

1. A code is sent; the stored record holds a keyed hash, not the code.
2. The leaked record is attacked by hashing every code from 000000 to 999999. An unkeyed hash gives the code up; the keyed one matches nothing.
3. A wrong code is refused, the right code typed from another account is refused without spending the owner's tries, and the owner's right code is accepted.
4. Reusing that code is refused.
5. After five wrong guesses, the right code gets 429.
6. A replaced code is refused, a code typed eleven minutes late is refused, and a fresh code used at once succeeds.
7. A fourth send to one number within the hour is refused, from the same account and from a new one; exactly three messages arrive. An hour later, sends work again.
8. A send to a number verified on another account gets 409, and nothing is delivered.
9. Editing the phone clears the verified flag.

It needs Node 20 or later, has no dependencies, and exits 0 when every check passes.

## Limits of the demo

- It is simplified and in memory, with no database, HTTP, sessions or WhatsApp API.
- It uses HMAC-SHA-256 as its keyed hash. Any construction that mixes in a server-side secret works for this purpose; what matters is that checking guesses against a leaked record requires the secret.
- The key is a hard-coded fake string.
- It does not simulate a failed WhatsApp delivery.
- It treats a number as a ten-digit Indian mobile number. The demo's numbers are fictional.
