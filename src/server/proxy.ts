import type { IncomingMessage } from "node:http";

/**
 * NPM is a bridged container reaching a host-published port, so its source
 * address is on the Docker bridge, not the host's LAN or Tailscale address.
 */
export const TRUSTED_PROXY_CIDRS: readonly string[] = ["172.16.0.0/12", "127.0.0.0/8", "::1/128"];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = n * 256 + part;
  }
  return n >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = toInt(ip);
  const b = toInt(base ?? "");
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function normalise(raw: string): string | null {
  const ip = raw.trim().replace(/^::ffff:/i, "");
  return toInt(ip) === null ? null : ip;
}

/**
 * The address to key rate limiting on.
 *
 * Only consult X-Forwarded-For when the immediate peer is a trusted proxy --
 * otherwise any client could choose its own bucket. And take the RIGHTMOST
 * entry: nginx's $proxy_add_x_forwarded_for appends to whatever the client
 * sent, so the leftmost value is attacker-controlled.
 */
export function clientAddress(
  req: IncomingMessage,
  trusted: readonly string[] = TRUSTED_PROXY_CIDRS,
): string {
  const peer = req.socket?.remoteAddress ?? "unknown";
  const peerIp = normalise(peer) ?? peer;
  if (!trusted.some((c) => inCidr(peerIp, c))) return peerIp;

  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (!header) return peerIp;

  const parts = header.split(",").map((p) => normalise(p)).filter((p): p is string => p !== null);
  return parts.length > 0 ? parts[parts.length - 1]! : peerIp;
}
