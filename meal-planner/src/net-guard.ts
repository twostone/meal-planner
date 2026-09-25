import { BlockList, isIP } from "node:net";

export type FetchFailure = "blocked" | "timeout" | "too_large" | "status" | "network" | "redirects" | "type";

export class FetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

// Everything that is not a normal public unicast address. The add-on sits inside the home network next to
// Home Assistant, the router and other add-ons, so a user-supplied link must never reach any of them.
const blocked = new BlockList();
const v4 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, "ipv4");
const v6 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, "ipv6");
v4("0.0.0.0", 8); // "this" network
v4("10.0.0.0", 8);
v4("100.64.0.0", 10); // carrier-grade NAT
v4("127.0.0.0", 8); // loopback
v4("169.254.0.0", 16); // link-local, cloud metadata
v4("172.16.0.0", 12); // incl. the hassio network 172.30.32.0/23
v4("192.0.0.0", 24);
v4("192.0.2.0", 24);
v4("192.168.0.0", 16);
v4("198.18.0.0", 15);
v4("198.51.100.0", 24);
v4("203.0.113.0", 24);
v4("224.0.0.0", 4); // multicast
v4("240.0.0.0", 4); // reserved + broadcast
v6("::", 128);
v6("::1", 128);
// No rule for ::ffff:0:0/96 (IPv4-mapped): Node checks IPv4 addresses as mapped IPv6, so such a rule would
// match every IPv4 address. Mapped addresses are covered by the IPv4 rules above.
v6("64:ff9b::", 96); // NAT64
v6("100::", 64);
v6("2001::", 32); // Teredo
v6("2001:db8::", 32);
v6("2002::", 16); // 6to4 (embeds arbitrary IPv4)
v6("fc00::", 7); // unique local
v6("fe80::", 10); // link-local
v6("ff00::", 8); // multicast

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Static checks on a URL. Hostnames are checked again after DNS resolution (see safe-fetch.ts);
// IP literals never go through DNS, so they have to be rejected here.
export function assertAllowedUrl(url: URL, allowPrivate = false): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("blocked", "scheme");
  if (url.username || url.password) throw new FetchError("blocked", "credentials");
  if (allowPrivate) return; // tests only
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new FetchError("blocked", "port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new FetchError("blocked", "host");
  if (isIP(host) !== 0 && !isPublicIp(host)) throw new FetchError("blocked", "address");
}
