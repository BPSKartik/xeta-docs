// A stand-in for PayU's hosted page, just enough to exercise both hashes.
//
// It knows the merchant's key and salt (the real PayU does too), refuses a
// form whose forward hash doesn't match what it received, and signs the
// result it posts back with the reverse hash.
import { requestHash, responseHash } from "./payu.mjs";

export function createFakePayU(creds) {
  let seq = 0;

  // `form` is exactly what the browser submitted, every value a string.
  // `outcome` stands in for what the buyer does on the hosted page.
  function submit(form, { outcome = "success", additionalCharges } = {}) {
    if (form.key !== creds.key) return { accepted: false, error: "unknown merchant key" };

    // Recompute from the fields as received. If anything signed was changed
    // in the browser (amount, txnid, udf5...), this is where it stops,
    // before any money moves.
    if (requestHash(creds, form) !== form.hash) {
      return { accepted: false, error: "checksum failed" };
    }

    seq += 1;
    const result = {
      mihpayid: `demo-pay-${String(seq).padStart(4, "0")}`,
      status: outcome === "success" ? "success" : "failure",
      key: form.key, txnid: form.txnid, amount: form.amount,
      productinfo: form.productinfo, firstname: form.firstname, email: form.email,
      udf1: form.udf1 || "", udf5: form.udf5 || "",
    };
    if (additionalCharges) result.additionalCharges = additionalCharges;
    if (result.status !== "success") result.error_Message = "Card declined (demo)";
    result.hash = responseHash(creds, result);

    // PayU sends the result back through the buyer's browser as a form POST,
    // to surl on success and furl otherwise. Both point at the same route.
    const url = result.status === "success" ? form.surl : form.furl;
    return { accepted: true, callback: { url, body: new URLSearchParams(result).toString() } };
  }

  return { submit };
}
