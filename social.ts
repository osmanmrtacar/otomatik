/**
 * Social media automation — generates and posts carousel images or short reels
 * on a weekly schedule. Config lives in Cloudflare R2; MongoDB provides movie data.
 *
 * Usage:
 *   deno run --allow-all social.ts --help
 */
import "@std/dotenv/load";
import { movieDetailCollection } from "./db.ts";
import { loadConfig, saveConfig } from "./storage.ts";
import {
  buildCarouselUrls,
  generateReelVideo,
  type MovieRecord,
} from "./media.ts";
import { generateCaption } from "./caption.ts";
import { publish } from "./zernio.ts";

// ─── Config types ─────────────────────────────────────────────────────────────

interface QueryConfig {
  filter: Record<string, unknown>;
  sort: Record<string, number>;
  limit: number;
}

interface PostConfig {
  id: string;
  keyword: string;
  mediaType: "carousel" | "reel";
  /** Carousel: slide header title. Reel: hook text shown at start of video. */
  theme: string;
  /** Reel only: call-to-action text shown at end of video */
  ctaText?: string;
  /** Reel only: streaming provider key (e.g. "netflix") for video style */
  provider?: string;
  platforms: string[];
  schedule: string; // "weekday HH:MM" e.g. "sunday 19:00"
  query: QueryConfig;
  hashtags: string[];
  lastPosted: string | null;
  lastMovieIds?: string[];
}

interface PostsConfig {
  version: string;
  lastUpdated: string;
  timezone: string;
  posts: PostConfig[];
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const DAY_LABELS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function parseSchedule(schedule: string): { day: number; hour: number } | null {
  const [dayStr, timeStr] = schedule.toLowerCase().trim().split(/\s+/);
  const day = DAY_NAMES[dayStr];
  if (day === undefined || !timeStr) return null;

  const [h] = timeStr.split(":").map(Number);
  if (isNaN(h) || h < 0 || h > 23) return null;

  return { day, hour: h };
}

function currentTime(
  timezone: string,
): { day: number; hour: number; minute: number } {
  const now = new Date();
  const dayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  })
    .format(now)
    .toLowerCase();
  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).format(now);

  const day = DAY_NAMES[dayStr] ?? now.getDay();
  const [hour, minute] = timeStr.split(":").map(Number);
  return { day, hour, minute };
}

function isScheduledNow(
  post: PostConfig,
  now: { day: number; hour: number },
): boolean {
  const s = parseSchedule(post.schedule);
  return s !== null && s.day === now.day && s.hour === now.hour;
}

function postedToday(lastPosted: string | null, timezone: string): boolean {
  if (!lastPosted) return false;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "short",
  });
  return fmt.format(new Date(lastPosted)) === fmt.format(new Date());
}

function contentChanged(post: PostConfig, newIds: string[]): boolean {
  if (!post.lastMovieIds?.length) return true;
  const prev = new Set(post.lastMovieIds);
  if (prev.size !== newIds.length) return true;
  return newIds.some((id) => !prev.has(id));
}

// ─── Movie querying ───────────────────────────────────────────────────────────

const BASE_FILTER = {
  enabled: true,
  "rankInfo.rank": { $gt: 0 },
};

async function queryMovies(q: QueryConfig): Promise<MovieRecord[]> {
  const filter = { ...q.filter, ...BASE_FILTER };
  return (await movieDetailCollection
    .find(JSON.parse(JSON.stringify(filter)))
    // deno-lint-ignore no-explicit-any
    .sort(q.sort as any)
    .limit(q.limit)
    .toArray()) as unknown as MovieRecord[];
}

// ─── Single post processor ────────────────────────────────────────────────────

interface ProcessResult {
  posted: boolean;
  updatedPost: PostConfig;
}

async function processPost(
  post: PostConfig,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<ProcessResult> {
  console.log(`\n── ${post.id} (${post.mediaType})`);
  console.log(`   Theme : ${post.theme}`);
  console.log(
    `   Sched : ${post.schedule} | Platforms: ${post.platforms.join(", ")}`,
  );

  const movies = await queryMovies(post.query);
  if (movies.length === 0) {
    console.log("   No movies found for query");
    return { posted: false, updatedPost: post };
  }
  console.log(`   Found : ${movies.length} movies`);

  const newIds = movies.map((m) => m.movieId);
  if (!opts.force && !contentChanged(post, newIds)) {
    console.log("   Skip  : content unchanged since last post");
    return { posted: false, updatedPost: post };
  }

  // Generate media
  let mediaUrls: string[];
  let mediaType: "image" | "video";

  if (post.mediaType === "carousel") {
    console.log("   Generating carousel images...");
    mediaUrls = await buildCarouselUrls(movies, post.theme);
    mediaType = "image";
  } else {
    console.log("   Generating reel video...");
    const provider = post.provider ||
      (post.query.filter["providers.refTag"] as string) ||
      post.id;
    const url = await generateReelVideo(movies, provider);
    mediaUrls = url ? [url] : [];
    mediaType = "video";
  }

  if (mediaUrls.length === 0) {
    console.log("   Skip  : media generation failed");
    return { posted: false, updatedPost: post };
  }

  // Generate caption
  const caption = await generateCaption(movies, post.keyword, post.hashtags);
  console.log(`   Caption: ${caption.slice(0, 120)}…`);

  if (opts.dryRun) {
    console.log("   Dry run – would post:");
    console.log(`     Media  : ${mediaUrls.join(", ")}`);
    console.log(`     Caption: ${caption}`);
    return { posted: false, updatedPost: post };
  }

  const ok = await publish({
    content: caption,
    platforms: post.platforms,
    mediaUrls,
    mediaType,
  });

  if (ok) {
    return {
      posted: true,
      updatedPost: {
        ...post,
        lastPosted: new Date().toISOString(),
        lastMovieIds: newIds,
      },
    };
  }

  return { posted: false, updatedPost: post };
}

// ─── Cron runner ──────────────────────────────────────────────────────────────

const CONFIG_R2_KEY = "posts-config.json";
const CONFIG_LOCAL = "./posts-config.json";

async function loadPostsConfig(): Promise<PostsConfig> {
  return loadConfig<PostsConfig>(CONFIG_R2_KEY, CONFIG_LOCAL);
}

async function savePostsConfig(config: PostsConfig): Promise<void> {
  config.lastUpdated = new Date().toISOString().split("T")[0];
  await saveConfig(CONFIG_R2_KEY, CONFIG_LOCAL, config);
}

export async function runCron(opts: {
  ids?: string[];
  force?: boolean;
  dryRun?: boolean;
  checkSchedule?: boolean;
  simulateDay?: string;
  simulateHour?: number;
} = {}): Promise<void> {
  console.log("\n📱 Social Cron");
  console.log("─".repeat(50));

  const config = await loadPostsConfig();
  const tz = config.timezone || "America/Los_Angeles";

  const now = opts.simulateDay !== undefined
    ? {
      day: DAY_NAMES[opts.simulateDay.toLowerCase()] ?? 0,
      hour: opts.simulateHour ?? 0,
      minute: 0,
    }
    : currentTime(tz);

  const dayLabel = DAY_LABELS[now.day];
  console.log(
    `Clock: ${dayLabel} ${String(now.hour).padStart(2, "0")}:${
      String(now.minute).padStart(2, "0")
    } (${tz})`,
  );

  let posts = config.posts;

  if (opts.ids?.length) {
    posts = posts.filter((p) => opts.ids!.includes(p.id));
    console.log(`Filtered to: ${opts.ids.join(", ")}`);
  } else if (opts.checkSchedule) {
    posts = posts.filter((p) => isScheduledNow(p, now));
    if (posts.length === 0) {
      console.log("Nothing scheduled for this hour.");
      return;
    }
    console.log(`Scheduled now: ${posts.map((p) => p.id).join(", ")}`);
  }

  const stats = { processed: 0, posted: 0, skipped: 0 };

  for (const post of posts) {
    if (!opts.force && opts.checkSchedule && postedToday(post.lastPosted, tz)) {
      console.log(`\n── ${post.id}: already posted today`);
      stats.skipped++;
      continue;
    }

    const { posted, updatedPost } = await processPost(post, opts);
    stats.processed++;

    if (posted) {
      stats.posted++;
      const idx = config.posts.findIndex((p) => p.id === post.id);
      if (idx !== -1) config.posts[idx] = updatedPost;
    } else {
      stats.skipped++;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  await savePostsConfig(config);

  console.log("\n─".repeat(25));
  console.log(
    `Processed: ${stats.processed}  Posted: ${stats.posted}  Skipped: ${stats.skipped}`,
  );
}

// ─── Info commands ────────────────────────────────────────────────────────────

export async function showSchedule(): Promise<void> {
  const config = await loadPostsConfig();
  const tz = config.timezone || "America/Los_Angeles";
  const now = currentTime(tz);

  console.log("\n📅 Weekly Schedule");
  console.log(`Timezone: ${tz}\n`);

  const byDay: Record<number, PostConfig[]> = {};
  for (const post of config.posts) {
    const s = parseSchedule(post.schedule);
    if (!s) continue;
    (byDay[s.day] ??= []).push(post);
  }

  for (let d = 0; d <= 6; d++) {
    const entries = byDay[d];
    if (!entries?.length) continue;
    const isToday = d === now.day;
    console.log(`${DAY_LABELS[d].toUpperCase()}${isToday ? "  ← today" : ""}`);
    for (
      const p of entries.sort((a, b) => a.schedule.localeCompare(b.schedule))
    ) {
      const s = parseSchedule(p.schedule)!;
      const isNow = isToday && s.hour === now.hour;
      const lastPosted = p.lastPosted ? p.lastPosted.split("T")[0] : "never";
      console.log(
        `  ${String(s.hour).padStart(2, "0")}:00  [${p.mediaType.padEnd(8)}]  ${
          p.id.padEnd(28)
        } last: ${lastPosted}${isNow ? "  ← NOW" : ""}`,
      );
    }
    console.log();
  }
}

export async function listPosts(): Promise<void> {
  const config = await loadPostsConfig();
  console.log(`\n📋 Posts (${config.posts.length} total)\n`);
  for (const p of config.posts) {
    const last = p.lastPosted ? p.lastPosted.split("T")[0] : "never posted";
    console.log(`${p.id}`);
    console.log(`  Type     : ${p.mediaType}`);
    console.log(`  Theme    : ${p.theme}`);
    console.log(`  Schedule : ${p.schedule}`);
    console.log(`  Platforms: ${p.platforms.join(", ")}`);
    console.log(`  Last post: ${last}\n`);
  }
}

export async function previewPost(id: string): Promise<void> {
  const config = await loadPostsConfig();
  const post = config.posts.find((p) => p.id === id);
  if (!post) {
    console.log(`Post not found: ${id}`);
    return;
  }
  await processPost(post, { force: true, dryRun: true });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
Social media automation — post carousels and reels on schedule.

USAGE
  deno run --allow-all social.ts [options]

INFO
  --schedule          Show weekly posting schedule
  --list              List all configured posts
  --preview <id>      Dry-run a specific post (no actual posting)

CRON (run hourly)
  --cron              Only process posts scheduled for the current hour
                      Safe to run multiple times per hour (idempotent)

MANUAL
  --ids <id,id,...>   Run specific post IDs regardless of schedule
  --force             Ignore "already posted today" and "content unchanged" checks
  --dry-run           Generate content but don't publish

SIMULATE
  --time <day> <HH>   Override current time, e.g. --time sunday 19

ENV VARS
  ZERNIO_API_KEY                    Required for publishing
  ZERNIO_ACCOUNT_INSTAGRAM          Zernio account ID for Instagram
  ZERNIO_ACCOUNT_TIKTOK             Zernio account ID for TikTok
  R2_PUBLIC_URL                     Public base URL for R2 bucket (images served from here)
  CARD_API_URL / COVER_API_URL      Local image generation service
  OPENAI_KEY                        For AI caption generation
  MONGO_URI / MONGO_DB              MongoDB connection
  R2_ACCOUNT_ID / R2_ACCESS_KEY_ID  Cloudflare R2 credentials
  R2_SECRET_ACCESS_KEY / R2_BUCKET  Cloudflare R2 credentials

CONFIG FILE  posts-config.json (loaded from R2, falls back to local)
`;

if (import.meta.main) {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    Deno.exit(0);
  }

  if (args.includes("--schedule")) {
    await showSchedule();
    Deno.exit(0);
  }
  if (args.includes("--list")) {
    await listPosts();
    Deno.exit(0);
  }

  if (args.includes("--preview")) {
    const id = args[args.indexOf("--preview") + 1];
    if (!id) {
      console.error("--preview requires an ID");
      Deno.exit(1);
    }
    await previewPost(id);
    Deno.exit(0);
  }

  const idsArg = args.indexOf("--ids");
  const ids = idsArg !== -1 ? args[idsArg + 1].split(",") : undefined;

  let simulateDay: string | undefined;
  let simulateHour: number | undefined;
  const timeArg = args.indexOf("--time");
  if (timeArg !== -1) {
    simulateDay = args[timeArg + 1];
    simulateHour = parseInt(args[timeArg + 2], 10);
    if (!simulateDay || isNaN(simulateHour)) {
      console.error("--time requires <day> <hour>, e.g. --time sunday 19");
      Deno.exit(1);
    }
  }

  await runCron({
    ids,
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    checkSchedule: args.includes("--cron"),
    simulateDay,
    simulateHour,
  });

  Deno.exit(0);
}
