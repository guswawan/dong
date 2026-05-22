import { fetchTranscript } from "youtube-transcript-plus";

import {
  createYoutubeFetch,
  fetchYoutubeTranscriptViaYtDlp,
  isYoutubeBotError,
} from "./youtubeTools";

// Type for transcript config (not exported from library)
type TranscriptConfig = Parameters<typeof fetchTranscript>[1];

/**
 * Decodes HTML entities in a string
 * Handles both named entities and numeric entities (decimal and hex)
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };

  // First pass: decode named entities
  let decoded = text.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,
    (match) => entities[match] || match,
  );

  // Second pass: decode numeric entities (decimal &#123; and hex &#x1A;)
  decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number.parseInt(code, 10)),
  );
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );

  // Handle double-encoded entities (e.g., &amp;gt; -> &gt; -> >)
  // Keep decoding until no more changes
  let prev = "";
  while (prev !== decoded) {
    prev = decoded;
    decoded = decoded.replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,
      (match) => entities[match] || match,
    );
    decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    );
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
  }

  return decoded;
}

/**
 * Extracts video ID from various YouTube URL formats
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  // If no pattern matches, assume the input is already a video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }

  return null;
}

/**
 * Fetches transcript from a YouTube video URL or video ID
 */
export async function fetchYoutubeTranscript(
  videoUrlOrId: string,
): Promise<string> {
  const videoId = extractVideoId(videoUrlOrId);

  if (!videoId) {
    throw new Error(`Invalid YouTube URL or video ID: ${videoUrlOrId}`);
  }

  const youtubeFetch = createYoutubeFetch();

  try {
    const config: TranscriptConfig = {
      videoFetch: async ({ url, lang, userAgent }) => {
        const headers: Record<string, string> = {};
        if (lang) headers["Accept-Language"] = lang;
        if (userAgent) headers["User-Agent"] = userAgent;
        return youtubeFetch(url, { headers });
      },
      playerFetch: async ({
        url,
        method,
        body,
        headers: baseHeaders,
        lang,
        userAgent,
      }) => {
        const headers: Record<string, string> = { ...baseHeaders };
        if (lang) headers["Accept-Language"] = lang;
        if (userAgent) headers["User-Agent"] = userAgent;
        return youtubeFetch(url, { method, headers, body });
      },
      transcriptFetch: async ({ url, lang, userAgent }) => {
        const headers: Record<string, string> = {};
        if (lang) headers["Accept-Language"] = lang;
        if (userAgent) headers["User-Agent"] = userAgent;
        return youtubeFetch(url, { headers });
      },
    };

    const transcriptResult = await fetchTranscript(videoId, config);

    if (!transcriptResult || transcriptResult.length === 0) {
      throw new Error(
        "No transcript available for this video. The video may not have captions enabled.",
      );
    }

    // Join all transcript segments into a single text, decoding HTML entities
    const transcriptText = transcriptResult
      .map((item) => decodeHtmlEntities(item.text))
      .filter((text) => text && text !== "N/A")
      .join(" ");

    if (!transcriptText.trim()) {
      throw new Error("Transcript is empty or contains no valid content.");
    }

    return transcriptText;
  } catch (primaryError) {
    const primaryMsg =
      primaryError instanceof Error
        ? primaryError.message
        : String(primaryError);
    console.warn(
      `[TRANSCRIPT] youtube-transcript-plus gagal untuk ${videoId}: ${primaryMsg}. Mencoba fallback yt-dlp...`,
    );

    try {
      const viaYtDlp = await fetchYoutubeTranscriptViaYtDlp(videoId);
      console.log(
        `[TRANSCRIPT] Fallback yt-dlp berhasil. Panjang: ${viaYtDlp.length} karakter.`,
      );
      return viaYtDlp;
    } catch (fallbackError) {
      const fallbackMsg =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      const combined = `${primaryMsg} | yt-dlp: ${fallbackMsg}`;
      if (isYoutubeBotError(combined)) {
        throw new Error(
          `Failed to fetch transcript (YouTube blocked server IP): ${combined}`,
        );
      }
      throw new Error(`Failed to fetch transcript: ${combined}`);
    }
  }
}

/**
 * Compatibility wrapper function used in app/api/analyze/route.ts
 */
export async function getYouTubeTranscript(
  videoId: string,
  _activeInvidiousInstances: string[] = [],
): Promise<string> {
  return fetchYoutubeTranscript(videoId);
}
