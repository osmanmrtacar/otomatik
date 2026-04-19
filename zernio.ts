const ZERNIO_API_KEY = Deno.env.get("ZERNIO_API_KEY") || "";
const BASE_URL = "https://zernio.com/api/v1";

// Map platform name → Zernio account ID via env vars
// e.g. ZERNIO_ACCOUNT_INSTAGRAM=abc123, ZERNIO_ACCOUNT_TIKTOK=def456
function accountId(platform: string): string {
  return Deno.env.get(`ZERNIO_ACCOUNT_${platform.toUpperCase()}`) || "";
}

interface ZernioPost {
  content: string;
  platforms: string[]; // e.g. ["instagram", "tiktok"]
  mediaUrls: string[]; // publicly accessible URLs
  mediaType: "image" | "video";
}

/**
 * Publish content to one or more platforms via the Zernio API.
 * Returns true on success.
 */
export async function publish(post: ZernioPost): Promise<boolean> {
  if (!ZERNIO_API_KEY) {
    console.error("  ZERNIO_API_KEY not set");
    return false;
  }

  const platforms = post.platforms.flatMap((p) => {
    const id = accountId(p);
    if (!id) {
      console.warn(`  No account ID configured for platform: ${p}`);
      return [];
    }
    return [{ platform: p, accountId: id }];
  });

  if (platforms.length === 0) {
    console.error("  No valid platform accounts configured");
    return false;
  }

  const mediaItems = post.mediaUrls.map((url) => ({
    type: post.mediaType,
    url,
  }));

  const body = {
    content: post.content,
    platforms,
    mediaItems,
    publishNow: true,
  };

  try {
    const res = await fetch(`${BASE_URL}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Zernio HTTP ${res.status}: ${err}`);
    }

    const data = await res.json();
    console.log(`  Published → ${platforms.map((p) => p.platform).join(", ")} (id: ${data._id ?? "?"})`);
    return true;
  } catch (err) {
    console.error(`  Zernio publish error: ${err}`);
    return false;
  }
}
