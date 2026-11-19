// Who may see and use stock-token (securities) currencies. One decision, read by
// every route that lists, deploys, mints or trades in a non-SOL currency, so a
// caller from a blocked country gets the SOL-only site and nothing else.
//
// The country is Cloudflare's CF-IPCountry header. It is only trustworthy when
// the origin accepts requests from Cloudflare alone (the reverse proxy must drop
// the header on any other peer); a direct hit could otherwise claim any country.

import type { Context } from "hono";
import { config } from "./config.ts";

// ISO 3166-1 alpha-2, or "" when the request did not come through Cloudflare.
export const countryOf = (c: Context): string => (c.req.header("cf-ipcountry") ?? "").toUpperCase();

export function stockAllowed(c: Context): boolean {
  if (!config.stockEnabled) return false;
  const country = countryOf(c);
  // No country, Cloudflare's "unknown" (XX) or Tor (T1): refuse on mainnet. Off
  // mainnet a local or scripted caller has no header and tests must still run.
  if (!country || country === "XX" || country === "T1") return config.cluster !== "mainnet";
  return !config.stockBlockedCountries.has(country);
}
