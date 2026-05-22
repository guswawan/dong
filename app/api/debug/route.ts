import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function GET() {
  const results: any = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    geminiConfig: {
      hasApiKey: !!process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
      fallbackModels: process.env.GEMINI_FALLBACK_MODELS,
    },
    youtubeConfig: {
      hasCookies: !!process.env.YOUTUBE_COOKIES,
      hasProxy: !!process.env.YOUTUBE_PROXY || !!process.env.PROXY_URL,
      proxyUrl: process.env.YOUTUBE_PROXY || process.env.PROXY_URL,
    },
  };

  try {
    // Test yt-dlp
    results.ytDlp = {
      version: await execAsync("yt-dlp --version").then(r => r.stdout.trim()),
      testDownload: await execAsync("yt-dlp --simulate --playlist-items 1 https://www.youtube.com/watch?v=CeOXx-XTYek").then(r => ({
        success: true,
        output: r.stdout.substring(0, 200)
      })).catch(e => ({
        success: false,
        error: e.message.substring(0, 200)
      })),
    };
  } catch (error: any) {
    results.ytDlp = { error: error.message };
  }

  try {
    // Test ffmpeg
    results.ffmpeg = {
      version: await execAsync("ffmpeg -version").then(r => r.stdout.split('\n')[0]),
    };
  } catch (error: any) {
    results.ffmpeg = { error: error.message };
  }

  try {
    // Test YouTube access
    results.youtubeAccess = await execAsync("curl -I --connect-timeout 10 https://www.youtube.com/watch?v=CeOXx-XTYek")
      .then(r => ({
        success: true,
        status: r.stdout.split('\n')[0]
      }))
      .catch(e => ({
        success: false,
        error: e.message.substring(0, 200)
      }));
  } catch (error: any) {
    results.youtubeAccess = { error: error.message };
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}