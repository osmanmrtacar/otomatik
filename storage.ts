import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") || "",
    secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") || "",
  },
});

const BUCKET = Deno.env.get("R2_BUCKET") || "social-configs";

// Public base URL for the bucket — set via R2 dashboard (custom domain or r2.dev URL)
// e.g. https://pub-abc123.r2.dev  or  https://media.yourdomain.com
const R2_PUBLIC_URL = (Deno.env.get("R2_PUBLIC_URL") || "").replace(/\/$/, "");

/**
 * Upload a binary (image/video) to R2 and return its public URL.
 * The file is stored under the "media/" prefix with a timestamp-based name.
 */
export async function uploadImage(
  data: Uint8Array,
  ext = "jpg",
): Promise<string | null> {
  if (!R2_PUBLIC_URL) {
    console.error("  R2_PUBLIC_URL not set — cannot build public image URL");
    return null;
  }

  const key = `media/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: data,
        ContentType: ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      }),
    );
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error(`  R2 image upload error: ${err}`);
    return null;
  }
}

export async function loadFromR2<T>(key: string): Promise<T> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await res.Body?.transformToString();
  if (!body) throw new Error(`Empty or missing R2 object: ${key}`);
  return JSON.parse(body) as T;
}

export async function saveToR2<T>(key: string, data: T): Promise<void> {
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    }),
  );
}

/**
 * Load config from R2, falling back to a local file path.
 * Saves to R2 automatically when local fallback is used so future runs hit R2.
 */
export async function loadConfig<T>(
  r2Key: string,
  localFallback: string,
): Promise<T> {
  try {
    return await loadFromR2<T>(r2Key);
  } catch {
    console.warn(`  R2 load failed for "${r2Key}", falling back to local file`);
    const content = await Deno.readTextFile(localFallback);
    return JSON.parse(content) as T;
  }
}

export async function saveConfig<T>(
  r2Key: string,
  localPath: string,
  data: T,
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  // Always persist locally as backup
  await Deno.writeTextFile(localPath, json);
  try {
    await saveToR2(r2Key, data);
  } catch (err) {
    console.warn(`  R2 save failed for "${r2Key}": ${err}`);
  }
}
