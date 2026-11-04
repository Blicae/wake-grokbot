/** Secret handling: keys come from env or stdin (never argv), are normalised, and never appear in output. */

const registered = new Set<string>();

/** Remember a secret so mask() can scrub it from any message. */
export function registerSecret(s: string | undefined | null): void {
  if (s && s.length >= 4) registered.add(s);
}

/** Strip whitespace and pasted `Authorization:` / `Bearer ` prefixes, plus surrounding quotes. */
export function normalizeKey(raw: string): string {
  let k = raw.trim().replace(/^["']|["']$/g, "").trim();
  k = k.replace(/^authorization\s*:\s*/i, "").trim();
  k = k.replace(/^bearer\s+/i, "").trim();
  return k.replace(/^["']|["']$/g, "").trim();
}

const PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',;]+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(sk-|ghp_|gho_|xox[abprs]-|glpat-)[A-Za-z0-9_-]{8,}/g,
  /(https?:\/\/)[^\s"'<>]+/gi,
  /([?&](?:token|key|sig|signature|secret|access_token)=)[^&\s"']+/gi,
];

/** Replace registered secrets, bearer tokens, token-looking strings and any URL with placeholders. */
export function mask(text: string): string {
  let out = String(text);
  for (const s of registered) out = out.split(s).join("***");
  for (const re of PATTERNS) {
    out = out.replace(re, (m, p1: string | undefined) => {
      if (/^https?:\/\//i.test(m)) return `${p1 ?? ""}<url hidden>`;
      return `${typeof p1 === "string" && !/^(sk-|ghp_|gho_|xox|glpat-)/.test(p1) ? p1 : ""}***`;
    });
  }
  return out;
}

/** Read a whole stream (stdin) as UTF-8. */
export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}
