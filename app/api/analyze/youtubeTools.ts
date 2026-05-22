import { exec } from "child_process";
import { readdir, readFile, unlink, writeFile } from "fs/promises";
import os from "os";
import { join } from "path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { promisify } from "util";

const execAsync = promisify(exec);

export const YT_DLP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Player clients to try when YouTube returns bot challenges (common on Cloud Run IPs). */
export const YT_DLP_PLAYER_CLIENTS = [
  "android,web",
  "ios",
  "mweb",
  "tv_embedded",
  "web",
] as const;

export function getYoutubeProxy(): string | undefined {
  const proxy =
    process.env.YOUTUBE_PROXY ||
    process.env.PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY;
  return proxy?.trim() || undefined;
}

export function isYoutubeBotError(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("sign in to confirm you're not a bot") ||
    lower.includes("confirm you're not a bot") ||
    lower.includes("cookies-from-browser") ||
    lower.includes("http error 403") ||
    lower.includes("unable to extract") ||
    lower.includes("this content isn't available")
  );
}

export function parseNetscapeCookiesToHeader(
  cookieFileContent: string | undefined,
): string | undefined {
  if (!cookieFileContent?.trim()) return undefined;

  const pairs: string[] = [];
  for (const line of cookieFileContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6];
    if (name && value) pairs.push(`${name}=${value}`);
  }

  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

export async function writeYoutubeCookiesFile(): Promise<{
  path: string;
  hasCookies: boolean;
}> {
  const cookiePath = join(os.tmpdir(), `cookies_${Date.now()}.txt`);
  const youtubeCookies = process.env.YOUTUBE_COOKIES;
  if (youtubeCookies?.trim()) {
    await writeFile(cookiePath, youtubeCookies);
    return { path: cookiePath, hasCookies: true };
  }
  return { path: cookiePath, hasCookies: false };
}

export async function cleanupCookiesFile(
  cookiePath: string,
  hasCookies: boolean,
): Promise<void> {
  if (!hasCookies) return;
  try {
    await unlink(cookiePath);
  } catch {
    // ignore
  }
}

export function buildYtDlpBaseFlags(opts: {
  cookiePath: string;
  hasCookies: boolean;
  proxy?: string;
  playerClient?: string;
}): string {
  const parts: string[] = [];
  if (opts.hasCookies) {
    parts.push(`--cookies "${opts.cookiePath}"`);
  }
  if (opts.proxy) {
    parts.push(`--proxy "${opts.proxy}"`);
  }
  const client = opts.playerClient ?? YT_DLP_PLAYER_CLIENTS[0];
  parts.push(`--extractor-args "youtube:player_client=${client}"`);
  parts.push("--force-ipv4");
  parts.push("--js-runtime node");
  parts.push(`--user-agent "${YT_DLP_USER_AGENT}"`);
  parts.push("--playlist-items 1");
  return parts.join(" ");
}

export async function runYtDlpWithRetry(
  buildCommand: (baseFlags: string) => string,
): Promise<{ stdout: string; stderr: string }> {
  const proxy = getYoutubeProxy();
  const { path: cookiePath, hasCookies } = await writeYoutubeCookiesFile();

  try {
    let lastError: unknown;
    for (const playerClient of YT_DLP_PLAYER_CLIENTS) {
      const baseFlags = buildYtDlpBaseFlags({
        cookiePath,
        hasCookies,
        proxy,
        playerClient,
      });
      const command = buildCommand(baseFlags);
      try {
        return await execAsync(command);
      } catch (error: unknown) {
        lastError = error;
        const err = error as { stderr?: string; stdout?: string };
        const output = `${err.stderr || ""}${err.stdout || ""}`;
        if (!isYoutubeBotError(output)) {
          throw error;
        }
        console.warn(
          `[YT-DLP] Bot/403 dengan player_client=${playerClient}, mencoba client berikutnya...`,
        );
      }
    }
    throw lastError;
  } finally {
    await cleanupCookiesFile(cookiePath, hasCookies);
  }
}

export async function getYoutubeUrlDuration(url: string): Promise<number> {
  try {
    const { stdout } = await runYtDlpWithRetry(
      (baseFlags) =>
        `yt-dlp ${baseFlags} --print "duration" --no-warnings "${url}"`,
    );
    const duration = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(duration) ? 0 : duration;
  } catch (error) {
    console.warn("Gagal mengambil durasi via yt-dlp:", error);
    return 0;
  }
}

function parseVttToText(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === "WEBVTT") return false;
      if (t.startsWith("NOTE")) return false;
      if (/^\d+$/.test(t)) return false;
      if (/^\d{2}:\d{2}:\d{2}/.test(t)) return false;
      if (t.includes("-->")) return false;
      return true;
    })
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** Fallback transcript extraction via yt-dlp (uses same cookies/proxy as downloads). */
export async function fetchYoutubeTranscriptViaYtDlp(
  videoId: string,
): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tmpDir = os.tmpdir();
  const outPrefix = `subs_${videoId}_${Date.now()}`;
  const outBase = join(tmpDir, outPrefix);

  await runYtDlpWithRetry(
    (baseFlags) =>
      `yt-dlp ${baseFlags} --skip-download --write-auto-subs --write-subs --sub-langs "id,en" --convert-subs vtt --no-warnings -o "${outBase}" "${url}"`,
  );

  const files = await readdir(tmpDir);
  const candidates = files.filter(
    (f) =>
      f.startsWith(outPrefix) &&
      (f.endsWith(".vtt") || f.endsWith(".srt")) &&
      !f.includes(".part"),
  );
  const subFile =
    candidates.find((f) => f.includes(".id.")) ??
    candidates.find((f) => f.includes(".en.")) ??
    candidates[0];

  if (!subFile) {
    throw new Error("No subtitle files produced by yt-dlp");
  }

  const subPath = join(tmpDir, subFile);
  const content = await readFile(subPath, "utf-8");
  try {
    await unlink(subPath);
  } catch {
    // ignore
  }

  const text = parseVttToText(content);
  if (!text.trim()) throw new Error("Subtitle file is empty");
  return text;
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  DNT: "1",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0",
};

/** Fetch with browser headers, optional proxy, and optional YouTube cookies. */
export function createYoutubeFetch(): typeof fetch {
  const proxy = getYoutubeProxy();
  const cookieHeader = parseNetscapeCookiesToHeader(
    process.env.YOUTUBE_COOKIES,
  );
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers || {});
    for (const [key, value] of Object.entries(BROWSER_HEADERS)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    if (cookieHeader && !headers.has("Cookie")) {
      headers.set("Cookie", cookieHeader);
    }
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", YT_DLP_USER_AGENT);
    }

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return undiciFetch(url, {
      method: init?.method,
      headers,
      body: init?.body as import("undici").RequestInit["body"],
      dispatcher,
    }) as unknown as Response;
  };
}

export const YOUTUBE_CLOUD_RUN_HINT =
  "YouTube memblokir IP server Cloud Run. Set YOUTUBE_COOKIES (Netscape format, diekspor dari browser yang sudah login) dan/atau YOUTUBE_PROXY (residential/rotating proxy) di environment Cloud Run.";
