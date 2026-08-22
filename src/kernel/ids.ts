import { webcrypto } from 'node:crypto';
import { type Clock, systemClock } from './clock.ts';

// The seam modules receive; business logic never calls newId() statically.
export type NewId = () => string;

export function newId(clock: Clock = systemClock): string {
  const random = new Uint8Array(10);
  webcrypto.getRandomValues(random);
  return idFromParts(clock.now().getTime(), random);
}

// UUIDv7 (RFC 9562): 48-bit unix-ms timestamp, then random bits — ids sort by
// creation time, keeping Postgres primary-key inserts index-friendly.
export function idFromParts(timeMs: number, random: Uint8Array): string {
  const bytes = new Uint8Array(16);
  let t = BigInt(timeMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
