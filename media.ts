import { uploadImage } from "./storage.ts";

const CARD_API_URL =
  Deno.env.get("CARD_API_URL") || "http://localhost:45444/api/generate-card";
const COVER_API_URL =
  Deno.env.get("COVER_API_URL") || "http://localhost:45444/api/generate-cover";
const REMOTION_API_URL = "https://remotion.deplo.xyz/render";

export interface MovieRecord {
  movieId: string;
  primaryImage?: string;
  backdropImage?: string;
  title?: string;
  synopsis?: string;
  releaseYear?: number;
  rating?: number;
  genres?: string[];
  rankInfo?: { rank?: number; daysInTop10?: number };
  providers?: { name: string; refTag: string }[];
  type?: string;
}

// ─── Image generation ────────────────────────────────────────────────────────

async function callLocalApi(
  url: string,
  body: Record<string, unknown>,
): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(`  API error (${url}): ${err}`);
    return null;
  }
}

export function generateCoverImage(title: string): Promise<Uint8Array | null> {
  return callLocalApi(COVER_API_URL, { title });
}

export function generateCardImage(
  movie: MovieRecord,
  theme: string,
): Promise<Uint8Array | null> {
  return callLocalApi(CARD_API_URL, {
    mainTitle: theme,
    title: movie.title || "Unknown Title",
    image: movie.backdropImage || movie.primaryImage || "",
    rating: movie.rating || 0,
    year: movie.releaseYear,
    genre: movie.genres?.slice(0, 2).join(", ") || "Entertainment",
    description: movie.synopsis || "",
  });
}

// ─── Reel generation ─────────────────────────────────────────────────────────

export async function generateReelVideo(
  movies: MovieRecord[],
  provider: string,
): Promise<string | null> {
  const payload = {
    provider,
    movies: movies.map((m) => ({
      title: m.title || "Unknown",
      poster: m.primaryImage || "",
      rating: m.rating || 0,
      year: m.releaseYear,
    })),
  };

  try {
    const res = await fetch(REMOTION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} – ${await res.text()}`);

    const data = await res.json();
    if (!data.success) throw new Error("Remotion render reported failure");

    // Ensure public URL
    const videoUrl = (data.videoUrl as string).replace(
      "http://0.0.0.0:3000",
      "https://remotion.deplo.xyz",
    );
    console.log(
      `  Reel ready: ${data.metadata?.durationSeconds}s, ${data.metadata?.movieCount} movies`,
    );
    return videoUrl;
  } catch (err) {
    console.error(`  Remotion error: ${err}`);
    return null;
  }
}

// ─── Carousel builder ────────────────────────────────────────────────────────

/**
 * Generates cover + per-movie card images, uploads all to Cloudflare R2.
 * Returns public URLs ready for posting.
 */
export async function buildCarouselUrls(
  movies: MovieRecord[],
  theme: string,
): Promise<string[]> {
  const urls: string[] = [];

  const cover = await generateCoverImage(theme);
  if (cover) {
    const url = await uploadImage(cover);
    if (url) urls.push(url);
  }

  for (const movie of movies) {
    const card = await generateCardImage(movie, theme);
    if (card) {
      const url = await uploadImage(card);
      if (url) {
        urls.push(url);
        console.log(`    Uploaded card: ${movie.title}`);
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return urls;
}
