import { randomUUID } from "crypto";
import { PassThrough, Readable } from "stream";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// TTL for the presigned direct-to-storage upload URL. Kept in lockstep with
// the artifact upload-intent TTL in routes/artifacts.ts so a client can never
// register an objectKey whose PUT has already expired.
const UPLOAD_URL_TTL_SEC = 900;

// External object paths are always `/objects/<key>`; the S3 object key is the
// remainder after the prefix. This scheme is unchanged from the previous
// GCS-backed implementation so existing `artifact_docs.object_key` rows and
// the `/objects/` checks in routes/artifacts.ts stay valid.
const OBJECT_PREFIX = "/objects/";

const REGION = process.env.S3_REGION || "us-east-1";
const ENDPOINT = process.env.S3_ENDPOINT || undefined;
// MinIO and most S3-compatible stores need path-style addressing. Default to
// path-style whenever a custom endpoint is configured; allow explicit override.
const FORCE_PATH_STYLE =
  process.env.S3_FORCE_PATH_STYLE != null
    ? process.env.S3_FORCE_PATH_STYLE === "true"
    : Boolean(ENDPOINT);

// Credentials: explicit keys (dev / MinIO) or fall back to the default AWS
// provider chain (prod IAM role / env / shared profile) when they're unset.
const explicitCreds =
  process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      }
    : undefined;

export const s3Client = new S3Client({
  region: REGION,
  ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
  forcePathStyle: FORCE_PATH_STYLE,
  ...(explicitCreds ? { credentials: explicitCreds } : {}),
});

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) {
    throw new Error(
      "S3_BUCKET must be set. Configure S3/MinIO object storage (see .env.example).",
    );
  }
  return b;
}

function keyFromObjectPath(objectPath: string): string {
  if (!objectPath.startsWith(OBJECT_PREFIX)) throw new ObjectNotFoundError();
  const key = objectPath.slice(OBJECT_PREFIX.length);
  if (!key) throw new ObjectNotFoundError();
  return key;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/**
 * File-like handle over a single S3 object, exposing the small slice of the
 * old GCS `File` API the app relied on (download / getMetadata /
 * createReadStream / delete) so callers didn't have to change.
 */
export class StoredObject {
  constructor(private readonly key: string) {}

  async download(): Promise<[Buffer]> {
    const out = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket(), Key: this.key }),
    );
    return [await streamToBuffer(out.Body as Readable)];
  }

  async getMetadata(): Promise<[{ size?: number }]> {
    const out = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket(), Key: this.key }),
    );
    return [{ size: out.ContentLength }];
  }

  // Returns synchronously (callers do `.createReadStream().on('error').pipe`).
  // The GetObject is fired asynchronously and its body piped into a passthrough.
  createReadStream(): Readable {
    const pass = new PassThrough();
    s3Client
      .send(new GetObjectCommand({ Bucket: bucket(), Key: this.key }))
      .then((out: GetObjectCommandOutput) => {
        const body = out.Body as Readable | undefined;
        if (!body) {
          pass.destroy(new ObjectNotFoundError());
          return;
        }
        body.on("error", (err) => pass.destroy(err)).pipe(pass);
      })
      .catch((err) => {
        pass.destroy(isNotFound(err) ? new ObjectNotFoundError() : err);
      });
    return pass;
  }

  async delete(opts: { ignoreNotFound?: boolean } = {}): Promise<void> {
    try {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: this.key }),
      );
    } catch (err) {
      if (opts.ignoreNotFound && isNotFound(err)) return;
      throw err;
    }
  }
}

export class ObjectStorageService {
  // Issue a presigned PUT the browser uploads directly to. Bucket CORS must
  // allow PUT from the app origin (see infra notes).
  async getObjectEntityUploadURL(): Promise<string> {
    const key = `uploads/${randomUUID()}`;
    return getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: bucket(), Key: key }),
      { expiresIn: UPLOAD_URL_TTL_SEC },
    );
  }

  // Recover the canonical `/objects/<key>` path from either a presigned URL
  // (path-style: `/<bucket>/<key>`) or an already-normalized path.
  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith(OBJECT_PREFIX)) return rawPath;
    let pathname: string;
    try {
      pathname = new URL(rawPath).pathname;
    } catch {
      return rawPath;
    }
    let key = pathname.replace(/^\//, "");
    const b = process.env.S3_BUCKET;
    if (b && key.startsWith(`${b}/`)) key = key.slice(b.length + 1);
    return `${OBJECT_PREFIX}${key}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObject> {
    const key = keyFromObjectPath(objectPath);
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError();
      throw err;
    }
    return new StoredObject(key);
  }

  // Direct server-side upload, used by the one-shot legacy-blob migration.
  async uploadObject(
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const key = keyFromObjectPath(objectPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
