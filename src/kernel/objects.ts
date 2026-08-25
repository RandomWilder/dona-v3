import { GoogleAuth } from 'google-auth-library';
import { KernelError } from './errors.ts';

// Object storage, on the same footing as db.ts: the shape of a transfer and no
// business logic. It does not know what a lease is. The paths it is handed are
// built by the module that owns them (SPEC-occupancy.md), and it never invents
// one.

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export interface ObjectStore {
  // The name is `put` rather than `upload`: writing the same path twice
  // replaces, and the bucket's versioning is what keeps the previous bytes.
  put(path: string, bytes: Buffer, contentType: string): Promise<void>;
  read(path: string): Promise<StoredObject>;
  // For the boot line. A deployed revision running on memory is wrong in the
  // same visible way a `-dev` version string is, so it has to be sayable.
  describe(): string;
}

// What the tests use, and what `npm run dev` falls back to. No bucket, no
// network, no credentials -- a clean clone still runs.
export function createMemoryStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  return {
    async put(path, bytes, contentType) {
      objects.set(path, { bytes: Buffer.from(bytes), contentType });
    },
    async read(path) {
      const found = objects.get(path);
      if (!found) {
        throw new KernelError('not_found', 'object not found');
      }
      return {
        bytes: Buffer.from(found.bytes),
        contentType: found.contentType,
      };
    },
    describe: () => 'memory',
  };
}

const scope = 'https://www.googleapis.com/auth/devstorage.read_write';

export interface GcsOptions {
  bucket: string;
  // Injected in tests so the fetch and the token are both fakeable; production
  // passes neither.
  fetchImpl?: typeof fetch;
  token?: () => Promise<string>;
}

export function createGcsStore(options: GcsOptions): ObjectStore {
  const { bucket } = options;
  const call = options.fetchImpl ?? fetch;
  // Lazily, and once: constructing this reads ADC from disk on a laptop, and
  // boot must not depend on that when the store is never used.
  let auth: GoogleAuth | null = null;
  const token =
    options.token ??
    (async () => {
      auth ??= new GoogleAuth({ scopes: [scope] });
      const value = await auth.getAccessToken();
      if (!value) {
        throw new KernelError('unavailable', 'no access token for storage');
      }
      return value;
    });

  // Percent-encoded whole, slashes included: the object name is one opaque
  // string to the API, and a path segment that looked like a URL path would
  // address a different object.
  const objectUrl = (path: string, kind: 'upload' | 'read'): string =>
    kind === 'upload'
      ? `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`
      : `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media`;

  return {
    async put(path, bytes, contentType) {
      const response = await call(objectUrl(path, 'upload'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          'content-type': contentType,
        },
        body: new Uint8Array(bytes),
      });
      if (!response.ok) {
        // The status and nothing from the body: an error body from a storage
        // API can echo the object name, and the name is on its way into a log.
        throw new KernelError('unavailable', 'object could not be stored', {
          status: response.status,
        });
      }
    },

    async read(path) {
      const response = await call(objectUrl(path, 'read'), {
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (response.status === 404) {
        throw new KernelError('not_found', 'object not found');
      }
      if (!response.ok) {
        throw new KernelError('unavailable', 'object could not be read', {
          status: response.status,
        });
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType:
          response.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    describe: () => `gs://${bucket}`,
  };
}
