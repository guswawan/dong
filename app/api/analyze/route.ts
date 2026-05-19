import { GoogleGenAI } from "@google/genai";
import { exec } from "child_process";
import { readdir, stat, unlink, writeFile } from "fs/promises";
import os from "os";
import { basename, join } from "path";
import { promisify } from "util";

import { ANALYSIS_PROMPT, SYSTEM_INSTRUCTION } from "./prompts";
import { getYouTubeTranscript } from "./youtube-transcript";

const execAsync = promisify(exec);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function cleanOldTempFiles() {
  try {
    const tmpDir = os.tmpdir();
    const files = await readdir(tmpDir);
    const now = Date.now();
    for (const file of files) {
      if (file.startsWith("vid_") && file.endsWith(".mp4")) {
        const filePath = join(tmpDir, file);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > 3600 * 1000) {
          // > 1 hour
          await unlink(filePath);
        }
      }
    }
  } catch (e) {
    console.error("Gagal membersihkan file temp lama:", e);
  }
}

async function compressVideo(inputPath: string): Promise<string> {
  const outputPath = `${inputPath.replace(/\.[^/.]+$/, "")}_compressed.mp4`;
  try {
    const command = `ffmpeg -i "${inputPath}" -vf "fps=1,scale='min(640,iw)':-2" -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 48k -y "${outputPath}"`;
    await execAsync(command);
    return outputPath;
  } catch (_error) {
    return inputPath;
  }
}

function extractYouTubeId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

async function getPublicInvidiousInstances(): Promise<string[]> {
  try {
    console.log("[INVIDIOUS] Mengambil daftar instance publik yang aktif dari tracker...");
    const response = await fetch("https://api.invidious.io/instances.json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      throw new Error(`Gagal mengambil list instansi: ${response.statusText}`);
    }
    const data: any = await response.json();
    if (!Array.isArray(data)) {
      return [];
    }

    // Filter instansi yang online (down === false) dan memiliki properti URI
    const activeInstances = data
      .map(([domain, details]: [string, any]) => ({
        uri: details?.uri,
        down: details?.monitor?.down || false,
      }))
      .filter((inst: any) => inst.uri && !inst.down)
      .map((inst: any) => inst.uri);

    return activeInstances;
  } catch (error) {
    console.error("[INVIDIOUS] Gagal mengambil daftar instance dari tracker:", error);
    return [];
  }
}

async function tryInvidiousRequest(
  baseUri: string,
  videoId: string,
  outputPath: string,
): Promise<string> {
  const cleanBaseUri = baseUri.endsWith("/") ? baseUri.slice(0, -1) : baseUri;
  console.log(`[INVIDIOUS] Mencoba mengambil stream dari: ${cleanBaseUri}`);

  // Query metadata dengan local=true agar stream link di-proxy langsung lewat server instansi tersebut
  const res = await fetch(`${cleanBaseUri}/api/v1/videos/${videoId}?local=true`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`HTTP Error ${res.status}`);
  }

  const videoData: any = await res.json();
  const formatStreams = videoData.formatStreams || [];

  if (formatStreams.length === 0) {
    throw new Error("Tidak ada format stream video yang didukung");
  }

  // Ambil stream pertama yang biasanya berisi audio+video terintegrasi (sering kali 360p atau 720p)
  const targetFormat = formatStreams[0];
  let downloadUrl = targetFormat.url;
  if (!downloadUrl) {
    throw new Error("Tautan stream video kosong");
  }

  if (downloadUrl.startsWith("/")) {
    downloadUrl = `${cleanBaseUri}${downloadUrl}`;
  }

  console.log(`[INVIDIOUS] Menemukan stream video, mulai mengunduh dari: ${downloadUrl}`);
  const fileResponse = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(20000), // Berikan waktu 20 detik untuk proses download stream video
  });

  if (!fileResponse.ok) {
    throw new Error(`Gagal mengunduh stream file: ${fileResponse.statusText}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const finalPath = `${outputPath}.mp4`;
  await writeFile(finalPath, buffer);

  const fileStat = await stat(finalPath);
  if (fileStat.size === 0) {
    throw new Error("File stream hasil unduhan berukuran 0 byte");
  }

  console.log(`[INVIDIOUS] Selesai mengunduh video via Invidious ke: ${finalPath}`);
  return finalPath;
}

async function downloadViaInvidious(
  url: string,
  outputPath: string,
): Promise<string> {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    throw new Error("ID video YouTube tidak dapat ditemukan dari tautan tersebut");
  }

  console.log(`[INVIDIOUS] Memulai pengunduhan video ID: ${videoId}`);

  // Tarik instansi dinamis
  const dynamicInstances = await getPublicInvidiousInstances();

  // Tambahkan daftar fallback instansi global yang paling stabil jika tracker mati/down
  const staticInstances = [
    "https://invidious.f5.si",
    "https://yewtu.be",
    "https://invidious.projectsegfaut.im",
    "https://invidious.privacydev.net",
    "https://inv.tux.im",
  ];

  // Gabungkan dan hilangkan duplikasi
  const allInstances = Array.from(
    new Set([...dynamicInstances, ...staticInstances]),
  ).filter((uri) => uri && uri.startsWith("http"));

  console.log(`[INVIDIOUS] Mulai memproses failover pada ${allInstances.length} instansi Invidious...`);

  let lastError: any = null;
  for (const uri of allInstances) {
    try {
      return await tryInvidiousRequest(uri, videoId, outputPath);
    } catch (e: any) {
      console.warn(`[INVIDIOUS] Instansi ${uri} gagal:`, e.message || e);
      lastError = e;
    }
  }

  throw new Error(
    `Semua instansi Invidious (${allInstances.length} server) gagal memproses stream. Error terakhir: ${
      lastError?.message || lastError || "Unknown"
    }`,
  );
}

async function downloadUniversalVideo(
  url: string,
): Promise<{ tempPath: string; mimeType: string }> {
  const fileBase = `vid_${Date.now()}`;
  const outputPath = join(os.tmpdir(), fileBase);
  const cookiePath = join(os.tmpdir(), `cookies_${Date.now()}.txt`);
  let hasCookies = false;

  try {
    // Cek apakah ada cookies di environment variable untuk bypass bot detection YouTube
    const youtubeCookies = process.env.YOUTUBE_COOKIES;
    if (youtubeCookies) {
      await writeFile(cookiePath, youtubeCookies);
      hasCookies = true;
    }

    const cookieFlag = hasCookies ? `--cookies "${cookiePath}"` : "";

    // Tambahkan opsi Proxy jika didefinisikan untuk menembus IP blocking Cloud Run
    const youtubeProxy =
      process.env.YOUTUBE_PROXY ||
      process.env.PROXY_URL ||
      process.env.HTTP_PROXY;
    const proxyFlag = youtubeProxy ? `--proxy "${youtubeProxy}"` : "";

    // Gunakan extractor-args untuk mencoba bypass bot detection dan force IPv4
    // player_client=android,web seringkali lebih ampuh di cloud environment
    // Tambahkan --js-runtime node karena di Docker image runner sudah ada Node.js
    const bypassArgs = `--extractor-args "youtube:player_client=android,web" --force-ipv4 --js-runtime node`;

    const command = `yt-dlp ${cookieFlag} ${proxyFlag} ${bypassArgs} --print "after_move:filepath" --no-quiet --no-progress --no-simulate -f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best" --max-filesize 500M --match-filter "duration <= 1200" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    const { stdout, stderr } = await execAsync(command);

    if (
      stdout.includes("does not pass filter") ||
      stderr?.includes("does not pass filter")
    ) {
      throw new Error(
        "Video terlalu panjang. Maksimal durasi adalah 20 menit.",
      );
    }

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const finalPath = lines.length > 0 ? lines[lines.length - 1] : "";

    if (
      !finalPath ||
      finalPath.includes("[download]") ||
      finalPath.includes("ERROR:")
    ) {
      throw new Error("Gagal mengunduh video dari sumber tersebut.");
    }

    await stat(finalPath);
    return { tempPath: finalPath, mimeType: "video/mp4" };
  } catch (error: any) {
    console.error("yt-dlp error:", error);

    // Jika error dilempar secara manual dari try block
    if (
      error.message ===
        "Video terlalu panjang. Maksimal durasi adalah 20 menit." ||
      error.message === "Gagal mengunduh video dari sumber tersebut."
    ) {
      throw error;
    }

    const stderrStr = error.stderr || "";
    const stdoutStr = error.stdout || "";
    const allOutput = stderrStr + stdoutStr;

    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    // Jika terjadi bot detection / pemblokiran akses otomatis untuk YouTube di production,
    // kita akan mencoba fallback menggunakan Invidious API secara otomatis agar user tidak perlu
    // mendownload secara manual!
    if (
      isYouTube &&
      (allOutput.includes("confirm you") ||
        allOutput.includes("Sign in") ||
        allOutput.includes("403: Forbidden") ||
        allOutput.includes("No video formats") ||
        allOutput.includes("Unsupported URL") ||
        allOutput.includes("not a valid URL"))
    ) {
      try {
        console.log(
          "[FALLBACK] yt-dlp diblokir atau gagal. Mencoba mengunduh menggunakan Invidious API...",
        );
        const finalPath = await downloadViaInvidious(url, outputPath);
        return { tempPath: finalPath, mimeType: "video/mp4" };
      } catch (fallbackError: any) {
        console.error("Invidious Fallback Error:", fallbackError);
      }
    }

    // Periksa apakah error karena durasi
    if (
      allOutput.includes("duration") ||
      allOutput.includes("does not pass filter")
    ) {
      throw new Error(
        "Video terlalu panjang. Maksimal durasi adalah 20 menit.",
      );
    }

    // Tangani URL tidak valid
    if (
      allOutput.includes("not a valid URL") ||
      allOutput.includes("Unsupported URL") ||
      allOutput.includes("No video formats")
    ) {
      throw new Error(
        "Link URL video tidak valid atau tidak didukung. Pastikan Anda memasukkan link yang benar (contoh: https://x.com/...).",
      );
    }

    if (isYouTube) {
      // Upaya terakhir jika ada error lain untuk YouTube
      try {
        console.log("[LAST RESORT FALLBACK] Mencoba Invidious API...");
        const finalPath = await downloadViaInvidious(url, outputPath);
        return { tempPath: finalPath, mimeType: "video/mp4" };
      } catch (fallbackError: any) {
        console.error("Last resort Invidious fallback failed:", fallbackError);
        throw new Error(
          "YouTube memblokir akses otomatis (Bot Detection) di server Cloud Run/Production dan upaya unduhan alternatif (Invidious API) juga gagal. Silakan hubungi admin untuk mengonfigurasi proxy/cookies, atau gunakan tab 'Upload File'.",
        );
      }
    }

    throw new Error(
      "Gagal mengunduh video. Pastikan URL valid, publik, dan dapat diakses.",
    );
  } finally {
    // Hapus file cookies jika ada
    if (hasCookies) {
      try {
        await unlink(cookiePath);
      } catch (_e) {}
    }
  }
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    async start(controller) {
      const sendStatus = (status: string, progress: number) => {
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ status, progress })}\n`),
        );
      };

      let tempFilePath = "";
      let compressedPath = "";
      let shouldKeepOriginal = false;
      let transcriptText = "";
      let hasTranscript = false;
      let uploadResult: any = null;

      // Bersihkan file lama secara background
      cleanOldTempFiles().catch(console.error);

      try {
        const formData = await req.formData();
        const file = formData.get("video") as File | null;
        const urlInput = formData.get("url") as string | null;

        if (!file && !urlInput) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                error: "Video file atau URL wajib disertakan",
              })}\n`,
            ),
          );
          controller.close();
          return;
        }

        // Coba ambil transkrip terlebih dahulu jika berupa link YouTube
        const videoId = urlInput ? extractYouTubeId(urlInput) : null;
        if (urlInput && videoId) {
          sendStatus("Mengekstrak transkrip dari YouTube...", 15);
          try {
            const activeInvidious = await getPublicInvidiousInstances();
            transcriptText = await getYouTubeTranscript(videoId, activeInvidious);
            if (transcriptText && transcriptText.length > 0) {
              hasTranscript = true;
            }
          } catch (err: any) {
            console.warn(`[TRANSCRIPT] Gagal mengambil transkrip YouTube: ${err.message || err}. Mencoba mengunduh video...`);
          }
        }

        let mimeType = "video/mp4";

        if (!hasTranscript) {
          if (file) {
            sendStatus("Menyiapkan file video...", 10);
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            tempFilePath = join(os.tmpdir(), file.name);
            await writeFile(tempFilePath, buffer);
            mimeType = file.type;

            sendStatus("Mengompresi video...", 25);
            compressedPath = await compressVideo(tempFilePath);
          } else if (urlInput) {
            sendStatus("Mengunduh video dari sumber...", 15);
            const downloaded = await downloadUniversalVideo(urlInput);
            tempFilePath = downloaded.tempPath;
            mimeType = downloaded.mimeType;

            sendStatus("Mengompresi video hasil unduhan...", 30);
            compressedPath = await compressVideo(tempFilePath);
            shouldKeepOriginal = true;
          }

          sendStatus("Mengunggah video terkompresi...", 45);
          uploadResult = await ai.files.upload({
            file: compressedPath,
            config: {
              mimeType: mimeType,
            },
          });

          if (!uploadResult.name) {
            throw new Error("Gagal mengunggah file video");
          }

          let fileState = await ai.files.get({ name: uploadResult.name });
          let retryCount = 0;
          while (fileState.state === "PROCESSING") {
            retryCount++;
            sendStatus(
              `Sedang memproses video (tahap ${retryCount})...`,
              50 + Math.min(retryCount * 2, 20),
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
            fileState = await ai.files.get({ name: uploadResult.name });
          }

          if (fileState.state === "FAILED") {
            throw new Error("Gagal memproses file video ini.");
          }
        }

        const mainModel = process.env.GEMINI_MODEL || "";
        const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || "")
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m !== "");
        const modelPool = [mainModel, ...fallbackModels];

        let response: any;
        let lastError: any;

        for (let i = 0; i < modelPool.length; i++) {
          const currentModel = modelPool[i];
          try {
            if (i > 0) {
              sendStatus(
                `Sedang ada lonjakan pengguna, mencoba model cadangan...`,
                80 + i * 2,
              );
              await new Promise((resolve) => setTimeout(resolve, 1500));
            } else {
              if (hasTranscript) {
                sendStatus("Sedang menganalisis materi dari transkrip...", 80);
              } else {
                sendStatus("Sedang menganalisis video & menyusun materi...", 80);
              }
            }

            const parts: any[] = [];
            if (hasTranscript) {
              parts.push({
                text: `${ANALYSIS_PROMPT}\n\nBerikut adalah transkrip teks dari video YouTube tersebut (lengkap dengan timestamp):\n\n${transcriptText}`,
              });
            } else {
              parts.push({
                fileData: {
                  fileUri: uploadResult.uri,
                  mimeType: uploadResult.mimeType,
                },
              });
              parts.push({
                text: ANALYSIS_PROMPT,
              });
            }

            response = await ai.models.generateContent({
              model: currentModel,
              contents: [
                {
                  role: "user",
                  parts: parts,
                },
              ],
              config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.4,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
              },
            });

            console.log(
              `[ANALYSIS] Berhasil menggunakan model: ${currentModel}`,
            );
            break;
          } catch (error: any) {
            lastError = error;
            // Perbolehkan failover untuk error transien/server (500, 503, 429)
            const status = error.status || error.code;
            const isTransientError =
              status === 500 || status === 503 || status === 429;
            if (isTransientError && i < modelPool.length - 1) {
              console.warn(
                `Model ${currentModel} gagal (${status || error.message || error}), mencoba model berikutnya...`,
              );
              continue;
            }
            throw error;
          }
        }

        if (!response) {
          throw lastError || new Error("Gagal mendapatkan respon dari AI.");
        }

        if (uploadResult && uploadResult.name) {
          await ai.files.delete({ name: uploadResult.name });
        }

        let responseText = response.text || "{}";
        responseText = responseText
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        const resultJson = JSON.parse(responseText);

        const videoFileName =
          shouldKeepOriginal && tempFilePath ? basename(tempFilePath) : null;

        sendStatus("Selesai! Menyusun hasil untuk Anda...", 100);
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              success: true,
              data: resultJson,
              videoFile: videoFileName,
            })}\n`,
          ),
        );
      } catch (error: any) {
        console.error("API Error:", error);
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              error: error.message || "Gagal memproses video",
            })}\n`,
          ),
        );
      } finally {
        if (tempFilePath && !shouldKeepOriginal) {
          try {
            await unlink(tempFilePath);
          } catch (_e) {}
        }
        if (compressedPath) {
          try {
            await unlink(compressedPath);
          } catch (_e) {}
        }
        controller.close();
      }
    },
  });

  return new Response(customReadable, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
