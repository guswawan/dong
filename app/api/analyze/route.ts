import { GoogleGenAI } from "@google/genai";
import { exec } from "child_process";
import { readdir, stat, unlink, writeFile } from "fs/promises";
import os from "os";
import { basename, join } from "path";
import { promisify } from "util";

import { ANALYSIS_PROMPT, SYSTEM_INSTRUCTION } from "./prompts";

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

async function downloadViaCobalt(
  url: string,
  outputPath: string,
): Promise<string> {
  const cobaltUrl = process.env.COBALT_API_URL || "https://api.cobalt.tools/api/json";

  console.log(`[COBALT] Mencoba mengunduh video menggunakan Cobalt API (${cobaltUrl}) untuk: ${url}`);

  const response = await fetch(cobaltUrl, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: url,
      vQuality: "360", // Resolusi rendah agar proses cepat dan hemat bandwidth
      isAudioOnly: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cobalt API gagal dengan status ${response.status}: ${errorText}`);
  }

  const data: any = await response.json();
  if (data.status === "error") {
    throw new Error(`Cobalt API error: ${data.text || "Unknown error"}`);
  }

  const downloadUrl = data.url;
  if (!downloadUrl) {
    throw new Error("Tidak ada download URL yang dikembalikan dari Cobalt API");
  }

  console.log(`[COBALT] Berhasil mendapatkan URL stream, mulai mengunduh file...`);
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    throw new Error(`Gagal mengunduh file dari URL Cobalt: ${fileResponse.statusText}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const finalPath = `${outputPath}.mp4`;
  await writeFile(finalPath, buffer);

  const fileStat = await stat(finalPath);
  if (fileStat.size === 0) {
    throw new Error("File hasil download Cobalt berukuran 0 byte");
  }

  console.log(`[COBALT] Selesai mengunduh video via Cobalt ke: ${finalPath}`);
  return finalPath;
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
    const youtubeProxy = process.env.YOUTUBE_PROXY || process.env.PROXY_URL || process.env.HTTP_PROXY;
    const proxyFlag = youtubeProxy ? `--proxy "${youtubeProxy}"` : "";

    // Gunakan extractor-args untuk mencoba bypass bot detection dan force IPv4
    // player_client=android,web seringkali lebih ampuh di cloud environment
    // Tambahkan --js-runtime node karena di Docker image runner sudah ada Node.js
    const bypassArgs = `--extractor-args "youtube:player_client=android,web" --force-ipv4 --js-runtime node`;

    const command = `yt-dlp ${cookieFlag} ${proxyFlag} ${bypassArgs} --print "after_move:filepath" --no-quiet --no-progress --no-simulate -f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best" --max-filesize 500M --match-filter "duration <= 900" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    const { stdout, stderr } = await execAsync(command);

    if (
      stdout.includes("does not pass filter") ||
      stderr?.includes("does not pass filter")
    ) {
      throw new Error(
        "Video terlalu panjang. Maksimal durasi adalah 15 menit.",
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
        "Video terlalu panjang. Maksimal durasi adalah 15 menit." ||
      error.message === "Gagal mengunduh video dari sumber tersebut."
    ) {
      throw error;
    }

    const stderrStr = error.stderr || "";
    const stdoutStr = error.stdout || "";
    const allOutput = stderrStr + stdoutStr;

    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    // Jika terjadi bot detection / pemblokiran akses otomatis untuk YouTube di production,
    // kita akan mencoba fallback menggunakan Cobalt API secara otomatis agar user tidak perlu
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
        console.log("[FALLBACK] yt-dlp diblokir atau gagal. Mencoba mengunduh menggunakan Cobalt API...");
        const finalPath = await downloadViaCobalt(url, outputPath);
        return { tempPath: finalPath, mimeType: "video/mp4" };
      } catch (fallbackError: any) {
        console.error("Cobalt Fallback Error:", fallbackError);
      }
    }

    // Periksa apakah error karena durasi
    if (
      allOutput.includes("duration") ||
      allOutput.includes("does not pass filter")
    ) {
      throw new Error(
        "Video terlalu panjang. Maksimal durasi adalah 15 menit.",
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
        console.log("[LAST RESORT FALLBACK] Mencoba Cobalt API...");
        const finalPath = await downloadViaCobalt(url, outputPath);
        return { tempPath: finalPath, mimeType: "video/mp4" };
      } catch (fallbackError: any) {
        console.error("Last resort Cobalt fallback failed:", fallbackError);
        throw new Error(
          "YouTube memblokir akses otomatis (Bot Detection) di server Cloud Run/Production dan upaya unduhan alternatif (Cobalt API) juga gagal. Silakan hubungi admin untuk mengonfigurasi proxy/cookies, atau gunakan tab 'Upload File'.",
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

        let mimeType = "video/mp4";

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
        const uploadResult = await ai.files.upload({
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
              sendStatus("Sedang menganalisis video & menyusun materi...", 80);
            }

            response = await ai.models.generateContent({
              model: currentModel,
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      fileData: {
                        fileUri: uploadResult.uri,
                        mimeType: uploadResult.mimeType,
                      },
                    },
                    {
                      text: ANALYSIS_PROMPT,
                    },
                  ],
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
            const status = error.status || error.code;
            if (
              (status === 503 || status === 429) &&
              i < modelPool.length - 1
            ) {
              console.warn(
                `Model ${currentModel} gagal (${status}), mencoba model berikutnya...`,
              );
              continue;
            }
            throw error;
          }
        }

        if (!response) {
          throw lastError || new Error("Gagal mendapatkan respon dari AI.");
        }

        await ai.files.delete({ name: uploadResult.name });

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
