// Not a general XML parser: no DTDs, CDATA or comments. Just enough to read
// the feed back the way a strict consumer would, and to catch the ways a
// hand-built feed breaks: an element closed out of order, a raw "&" or "<"
// sitting in text, or a character XML 1.0 does not allow anywhere.

const ENTITY = /^&(?:lt|gt|amp|apos|quot|#[0-9]+|#x[0-9a-fA-F]+);/;
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const DECODE = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** First code point XML 1.0 does not allow anywhere in a document, or -1. */
function firstForbidden(s) {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0xfffe || cp === 0xffff) return cp;
  }
  return -1;
}

const decode = (s) =>
  s.replace(/&(lt|gt|amp|apos|quot|#[0-9]+|#x[0-9a-fA-F]+);/g, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : DECODE[e]);

/**
 * Returns { ok, problems, items } where items is one object per <item>,
 * mapping each child element name to the list of its decoded text values.
 * A list, not a single value, because a field that appears twice is itself
 * the bug we want to see.
 */
export function readFeed(xml) {
  const problems = [];
  const stack = [];
  const items = [];
  let item = null;
  let text = "";
  let i = 0;

  const bad = firstForbidden(xml);
  if (bad >= 0) problems.push(`character U+${bad.toString(16).toUpperCase().padStart(4, "0")} is not allowed in XML 1.0`);

  while (i < xml.length) {
    if (xml[i] === "<") {
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i);
        if (end < 0) { problems.push("unterminated <?"); break; }
        i = end + 2;
        continue;
      }
      TAG.lastIndex = i;
      const m = TAG.exec(xml);
      if (!m) { problems.push(`stray "<" at ${i}`); i += 1; continue; }
      const [whole, closing, name, , selfClosing] = m;
      i += whole.length;
      if (closing) {
        const open = stack.pop();
        if (open !== name) { problems.push(`</${name}> closes <${open ?? "nothing"}>`); continue; }
        if (name === "item") { items.push(item); item = null; }
        else if (item) (item[name] ??= []).push(decode(text));
      } else if (!selfClosing) {
        stack.push(name);
        if (name === "item") item = {};
      }
      text = "";
    } else {
      const next = xml.indexOf("<", i);
      const chunk = xml.slice(i, next < 0 ? xml.length : next);
      for (let j = chunk.indexOf("&"); j >= 0; j = chunk.indexOf("&", j + 1)) {
        if (!ENTITY.test(chunk.slice(j))) problems.push(`bare "&" near ${JSON.stringify(chunk.slice(Math.max(0, j - 8), j + 8))}`);
      }
      text += chunk;
      i += chunk.length;
    }
  }
  if (stack.length) problems.push(`unclosed <${stack.join("> <")}>`);
  return { ok: problems.length === 0, problems, items };
}
