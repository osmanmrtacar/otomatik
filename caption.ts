import OpenAI from "openai";
import type { MovieRecord } from "./media.ts";

const openai = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_CHAT_TOKEN") || "",
});

function movieListText(movies: MovieRecord[]): string {
  return movies
    .map(
      (m, i) =>
        `${i + 1}. ${m.title} (${m.releaseYear ?? "?"}) – ${
          m.rating?.toFixed(1) ?? "N/A"
        }/10`,
    )
    .join("\n");
}

function fallbackCaption(
  movies: MovieRecord[],
  hashtags: string[],
  intro: string,
): string {
  const titles = movies
    .slice(0, 2)
    .map((m) => m.title)
    .join(" & ");
  return `${intro} – featuring ${titles}! Save for later. ${
    hashtags.map((h) => `#${h}`).join(" ")
  }`;
}

export async function generateCaption(
  movies: MovieRecord[],
  topic: string,
  hashtags: string[],
  maxChars = 200,
): Promise<string> {
  const hashtagLine = hashtags.map((h) => `#${h}`).join(" ");

  const prompt = `Write a short, engaging social media caption about "${topic}".

Featured movies/shows:
${movieListText(movies)}

Rules:
- Under ${maxChars} characters (excluding hashtags)
- Include a call to action (save, follow, share)
- Mention 1-2 specific titles
- NO emojis
- End with: ${hashtagLine}

Reply with ONLY the caption, nothing else.`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    return (
      res.choices[0]?.message?.content?.trim() ||
      fallbackCaption(movies, hashtags, topic)
    );
  } catch {
    return fallbackCaption(movies, hashtags, topic);
  }
}
