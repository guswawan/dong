import { exec } from "child_process";
import { readdir, stat, unlink, writeFile } from "fs/promises";
import os from "os";
import { basename, isAbsolute, join } from "path";
import { promisify } from "util";

import { getGeminiClient } from "./geminiClient";
import { ANALYSIS_PROMPT, SYSTEM_INSTRUCTION } from "./prompts";
import {
  getYoutubeUrlDuration,
  isYoutubeBotError,
  runYtDlpWithRetry,
  YOUTUBE_CLOUD_RUN_HINT,
} from "./youtubeTools";
import { getYouTubeTranscript } from "./youtubeTranscript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

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
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

async function downloadUniversalVideo(
  url: string,
): Promise<{ tempPath: string; mimeType: string }> {
  // Pemblokiran unduhan YouTube dihapus agar sistem bisa melakukan fallback pengunduhan audio
  // jika transkrip tidak tersedia. Filter durasi (--match-filter "duration <= 1800")
  // akan secara otomatis mencegah unduhan video panjang.

  const fileBase = `vid_${Date.now()}`;
  const outputPath = join(os.tmpdir(), fileBase);

  try {
    const { stdout, stderr } = await runYtDlpWithRetry(
      (baseFlags) =>
        `yt-dlp ${baseFlags} --print "after_move:filepath" --no-quiet --no-progress --no-simulate -f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best" --max-filesize 500M --match-filter "duration <= 4200" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`,
    );

    if (
      stdout.includes("does not pass filter") ||
      stderr?.includes("does not pass filter")
    ) {
      const err: any = new Error("LIMIT_EXCEEDED");
      err.type = "LIMIT_EXCEEDED";
      err.limit = 70;
      throw err;
    }

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const finalPath = lines.find((line) => isAbsolute(line)) || "";

    if (!finalPath || finalPath.includes("ERROR:")) {
      throw new Error("Gagal mengunduh video dari sumber tersebut.");
    }

    await stat(finalPath);
    return { tempPath: finalPath, mimeType: "video/mp4" };
  } catch (error: any) {
    console.error("yt-dlp error:", error);

    // Jika error dilempar secara manual dari try block
    if (
      error.type === "LIMIT_EXCEEDED" ||
      error.message === "Gagal mengunduh video dari sumber tersebut."
    ) {
      throw error;
    }

    const stderrStr = error.stderr || "";
    const stdoutStr = error.stdout || "";
    const allOutput = stderrStr + stdoutStr;

    // Periksa apakah error karena durasi
    if (
      allOutput.includes("duration") ||
      allOutput.includes("does not pass filter")
    ) {
      const err: any = new Error("LIMIT_EXCEEDED");
      err.type = "LIMIT_EXCEEDED";
      err.limit = 70;
      throw err;
    }

    // Tangani URL tidak valid
    if (
      allOutput.includes("not a valid URL") ||
      allOutput.includes("Unsupported URL") ||
      allOutput.includes("No video formats")
    ) {
      throw new Error(
        "URL video tidak valid atau tidak didukung. Pastikan memasukkan URL yang benar (contoh: https://x.com/...).",
      );
    }

    if (isYoutubeBotError(allOutput)) {
      throw new Error(`YOUTUBE_BLOCKED: ${YOUTUBE_CLOUD_RUN_HINT}`);
    }

    throw new Error(
      "Gagal mengunduh video. Pastikan URL valid, publik, dan dapat diakses.",
    );
  }
}

async function getUrlDuration(url: string): Promise<number> {
  return getYoutubeUrlDuration(url);
}

async function getVideoDuration(filePath: string): Promise<number> {
  try {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const { stdout } = await execAsync(command);
    const duration = parseFloat(stdout.trim());
    if (!Number.isNaN(duration)) {
      return duration;
    }
    return 0;
  } catch (error) {
    console.warn("Gagal mengambil durasi video via ffprobe:", error);
    return 0;
  }
}

function normalizeAnalysisResult(rawJson: any): any {
  const normalized: any = {
    judul_materi:
      rawJson.judul_materi ||
      rawJson.judul ||
      rawJson.title ||
      "Materi Tanpa Judul",
    ringkasan_eksekutif: Array.isArray(rawJson.ringkasan_eksekutif)
      ? rawJson.ringkasan_eksekutif
      : Array.isArray(rawJson.ringkasan)
        ? rawJson.ringkasan
        : Array.isArray(rawJson.executive_summary)
          ? rawJson.executive_summary
          : Array.isArray(rawJson.summary)
            ? rawJson.summary
            : [],
    timeline_pembahasan: Array.isArray(rawJson.timeline_pembahasan)
      ? rawJson.timeline_pembahasan
      : Array.isArray(rawJson.timeline)
        ? rawJson.timeline
        : Array.isArray(rawJson.schedule)
          ? rawJson.schedule
          : [],
    glosarium: Array.isArray(rawJson.glosarium)
      ? rawJson.glosarium
      : Array.isArray(rawJson.glosary)
        ? rawJson.glosary
        : Array.isArray(rawJson.glossary)
          ? rawJson.glossary
          : Array.isArray(rawJson.terms)
            ? rawJson.terms
            : [],
  };

  // Normalize timeline items
  normalized.timeline_pembahasan = normalized.timeline_pembahasan.map(
    (item: any) => {
      return {
        timestamp: item.timestamp || item.time || "00:00",
        topik: item.topik || item.topic || item.title || "Pembahasan",
        penjelasan:
          item.penjelasan ||
          item.explanation ||
          item.description ||
          item.content ||
          "",
      };
    },
  );

  // Normalize glossary items
  normalized.glosarium = normalized.glosarium.map((item: any) => {
    return {
      istilah: item.istilah || item.term || item.word || "Istilah",
      arti:
        item.arti || item.definition || item.meaning || item.description || "",
    };
  });

  return normalized;
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    async start(controller) {
      const sendStatus = (status: string, progress: number) => {
        const data = JSON.stringify({ status, progress });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      const sendError = (errorMsg: string, isLimit = false, limitValue = 0) => {
        const data = JSON.stringify(
          isLimit
            ? { error: "LIMIT_EXCEEDED", message: errorMsg, limit: limitValue }
            : { error: errorMsg },
        );
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        controller.close();
      };

      const sendSuccess = (resultJson: any, videoFileName: string | null) => {
        const data = JSON.stringify({
          success: true,
          data: resultJson,
          videoFile: videoFileName,
        });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      let tempFilePath = "";
      let compressedPath = "";
      let shouldKeepOriginal = false;
      let transcriptText = "";
      let hasTranscript = false;
      let uploadResult: any = null;

      console.log("\n[POST] ===============================================");
      console.log("[POST] Permintaan analisis video masuk.");

      // Bersihkan file lama secara background
      cleanOldTempFiles().catch(console.error);

      try {
        const formData = await req.formData();
        const file = formData.get("video") as File | null;
        const urlInput = formData.get("url") as string | null;

        console.log(
          `[POST] Input terdeteksi - File: ${file ? `${file.name} (${file.size} bytes)` : "Tidak ada"}, URL: ${urlInput || "Tidak ada"}`,
        );

        if (!file && !urlInput) {
          console.error(
            "[POST] Error: Input kosong, file maupun URL tidak disertakan.",
          );
          sendError("Video file atau URL wajib disertakan");
          return;
        }

        // Coba ambil transkrip terlebih dahulu jika berupa link YouTube
        const videoId = urlInput ? extractYouTubeId(urlInput) : null;
        const isYouTube = urlInput && videoId;
        console.log(
          `[POST] Identifikasi sumber: Apakah YouTube: ${!!isYouTube} (Video ID: ${videoId || "N/A"})`,
        );

        if (isYouTube) {
          sendStatus("Mengecek durasi video YouTube...", 5);
          console.log(
            `[POST] Mengambil durasi video YouTube dari URL: ${urlInput}`,
          );
          const durationSec = await getUrlDuration(urlInput);
          console.log(
            `[POST] Durasi video YouTube terdeteksi: ${durationSec} detik (${(durationSec / 60).toFixed(2)} menit)`,
          );

          if (durationSec === 0) {
            console.error(
              "[POST] Gagal mengambil metadata YouTube (durasi 0) — kemungkinan IP Cloud Run diblokir.",
            );
            sendError(
              `Tidak dapat mengakses video YouTube dari server. ${YOUTUBE_CLOUD_RUN_HINT}`,
              false,
            );
            return;
          }

          // Hard limit for YouTube is 240 minutes (14400 seconds)
          if (durationSec > 14400) {
            console.warn(
              `[POST] Menolak YouTube video karena melebihi batas keras 240 menit: ${durationSec} detik`,
            );
            sendError("Durasi video melebihi batas maksimal 240 menit.", false);
            return;
          }

          sendStatus("Mengekstrak transkrip dari YouTube...", 15);
          console.log(
            `[POST] Mencoba mengekstrak transkrip YouTube untuk Video ID: ${videoId}`,
          );
          try {
            transcriptText = await getYouTubeTranscript(videoId);
            if (transcriptText && transcriptText.length > 0) {
              hasTranscript = true;
              console.log(
                `[POST] Sukses mengambil transkrip YouTube. Panjang transkrip: ${transcriptText.length} karakter.`,
              );
            }
          } catch (err: any) {
            console.error(
              `[POST] [TRANSCRIPT] Gagal mengambil transkrip YouTube: ${err.message || err}`,
            );

            // YouTube without Transcript limits:
            // Gratis: max 45 mins (2700s), Coin: up to 70 mins (4200s)
            if (durationSec > 4200) {
              console.warn(
                `[POST] Menolak YouTube tanpa transkrip karena > 70 menit: ${durationSec} detik`,
              );
              sendError(
                "Video ini tidak memiliki transkrip. Karena durasinya di atas 70 menit, server kami tidak dapat memproses audionya secara langsung untuk menghindari server down. Harap gunakan video lain.",
                false,
              );
              return;
            }

            if (durationSec > 2700) {
              console.warn(
                `[POST] YouTube tanpa transkrip > 45 menit membutuhkan Koin: ${durationSec} detik`,
              );
              sendError(
                "Durasi video melebihi batas gratis 45 menit untuk YouTube tanpa transkrip. Silakan gunakan Koin Premium untuk memproses video hingga 70 menit.",
                true,
                70,
              );
              return;
            }

            // Jika <= 45 menit, biarkan fallback bekerja
            console.log(
              "[POST] Durasi video YouTube tanpa transkrip memenuhi batas gratis (<= 45 menit). Beralih ke fallback unduh audio.",
            );
            sendStatus(
              "Transkrip tidak ditemukan. Beralih ke pengunduhan audio...",
              18,
            );
          }

          // YouTube with Transcript limits:
          // Gratis: max 90 mins (5400s), Coin: up to 240 mins (14400s)
          if (hasTranscript) {
            if (durationSec > 5400) {
              console.warn(
                `[POST] YouTube dengan transkrip > 90 menit membutuhkan Koin: ${durationSec} detik`,
              );
              sendError(
                "Durasi video melebihi batas gratis 90 menit. Silakan gunakan Koin Premium untuk memproses video.",
                true,
                240,
              );
              return;
            }
            console.log(
              "[POST] Durasi video YouTube dengan transkrip memenuhi batas gratis (<= 90 menit).",
            );
          }
        }

        let mimeType = "video/mp4";

        if (!hasTranscript) {
          if (file) {
            console.log(
              `[POST] Memproses file video lokal yang diunggah: ${file.name}`,
            );
            sendStatus("Menyiapkan file video...", 10);
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            tempFilePath = join(os.tmpdir(), file.name);
            await writeFile(tempFilePath, buffer);
            mimeType = file.type;

            // Upload File Video limits:
            // Gratis: max 45 mins (2700s), Coin: up to 70 mins (4200s)
            console.log(
              `[POST] Mengukur durasi file video yang diunggah via ffprobe...`,
            );
            const durationSec = await getVideoDuration(tempFilePath);
            console.log(
              `[POST] Durasi file video: ${durationSec} detik (${(durationSec / 60).toFixed(2)} menit)`,
            );

            if (durationSec > 4200) {
              console.warn(
                `[POST] Menolak file video karena > 70 menit: ${durationSec} detik`,
              );
              sendError(
                "Durasi video melebihi batas maksimal 70 menit.",
                false,
              );
              return;
            }
            if (durationSec > 2700) {
              console.warn(
                `[POST] File video > 45 menit membutuhkan Koin: ${durationSec} detik`,
              );
              sendError(
                "Durasi video melebihi batas gratis 45 menit. Silakan gunakan Koin Premium untuk memproses video hingga 70 menit.",
                true,
                70,
              );
              return;
            }

            console.log(
              `[POST] Mengompresi file video terunggah: ${tempFilePath}`,
            );
            sendStatus("Mengompresi video...", 25);
            compressedPath = await compressVideo(tempFilePath);
            console.log(`[POST] Kompresi video sukses: ${compressedPath}`);
          } else if (urlInput) {
            console.log(
              `[POST] Memproses URL non-YouTube atau YouTube tanpa transkrip: ${urlInput}`,
            );
            sendStatus("Mengecek durasi video...", 10);
            let durationSec = await getUrlDuration(urlInput);
            console.log(
              `[POST] Durasi awal terdeteksi via yt-dlp: ${durationSec} detik`,
            );

            // URL Non-YouTube limits:
            // Gratis: max 45 mins (2700s), Coin: up to 70 mins (4200s)
            if (durationSec > 0) {
              if (durationSec > 4200) {
                console.warn(
                  `[POST] Menolak URL non-YouTube karena > 70 menit: ${durationSec} detik`,
                );
                sendError(
                  "Durasi video melebihi batas maksimal 70 menit.",
                  false,
                );
                return;
              }
              if (durationSec > 2700) {
                console.warn(
                  `[POST] URL non-YouTube > 45 menit membutuhkan Koin: ${durationSec} detik`,
                );
                sendError(
                  "Durasi video melebihi batas gratis 45 menit. Silakan gunakan Koin Premium untuk memproses video hingga 70 menit.",
                  true,
                  70,
                );
                return;
              }
            }

            console.log(
              `[POST] Mengunduh video/audio dari sumber ke server lokal via yt-dlp...`,
            );
            sendStatus("Mengunduh video dari sumber...", 15);
            try {
              const downloaded = await downloadUniversalVideo(urlInput);
              tempFilePath = downloaded.tempPath;
              mimeType = downloaded.mimeType;
              console.log(
                `[POST] Sukses mengunduh video ke: ${tempFilePath} (${mimeType})`,
              );
            } catch (dlError: any) {
              console.error("[POST] Gagal mengunduh video:", dlError);
              if (dlError.type === "LIMIT_EXCEEDED") {
                sendError(
                  "Durasi video melebihi batas maksimal 70 menit.",
                  false,
                );
                return;
              }
              throw dlError;
            }

            // If we couldn't get the duration before downloading, check it post-download
            if (durationSec === 0) {
              console.log(
                "[POST] Mengukur durasi video terunduh via ffprobe...",
              );
              durationSec = await getVideoDuration(tempFilePath);
              console.log(
                `[POST] Durasi video terunduh: ${durationSec} detik (${(durationSec / 60).toFixed(2)} menit)`,
              );
              if (durationSec > 4200) {
                console.warn(
                  `[POST] Menolak video terunduh karena > 70 menit: ${durationSec} detik`,
                );
                sendError(
                  "Durasi video melebihi batas maksimal 70 menit.",
                  false,
                );
                return;
              }
              if (durationSec > 2700) {
                console.warn(
                  `[POST] Video terunduh > 45 menit membutuhkan Koin: ${durationSec} detik`,
                );
                sendError(
                  "Durasi video melebihi batas gratis 45 menit. Silakan gunakan Koin Premium untuk memproses video hingga 70 menit.",
                  true,
                  70,
                );
                return;
              }
            }

            console.log(`[POST] Mengompresi video terunduh: ${tempFilePath}`);
            sendStatus("Mengompresi video hasil unduhan...", 30);
            compressedPath = await compressVideo(tempFilePath);
            console.log(
              `[POST] Kompresi video terunduh sukses: ${compressedPath}`,
            );
            shouldKeepOriginal = true;
          }

          console.log(
            `[POST] Mengunggah file terkompresi (${compressedPath}) ke Gemini API...`,
          );
          sendStatus("Mengunggah video terkompresi...", 45);
          const ai = getGeminiClient();
          uploadResult = await ai.files.upload({
            file: compressedPath,
            config: {
              mimeType: mimeType,
            },
          });

          if (!uploadResult.name) {
            console.error("[POST] Gagal mengunggah file ke Gemini API.");
            throw new Error("Gagal mengunggah file video");
          }

          console.log(
            `[POST] File terunggah ke Gemini. ID: ${uploadResult.name}, URI: ${uploadResult.uri}`,
          );

          let fileState = await ai.files.get({ name: uploadResult.name });
          let retryCount = 0;
          console.log(
            `[POST] Menunggu Gemini API selesai memproses file video. Status saat ini: ${fileState.state}`,
          );
          while (fileState.state === "PROCESSING") {
            retryCount++;
            sendStatus(
              `Sedang memproses video (tahap ${retryCount})...`,
              50 + Math.min(retryCount * 2, 20),
            );
            console.log(
              `[POST] Gemini memproses video... Percobaan ke-${retryCount}. Menunggu 5 detik.`,
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
            fileState = await ai.files.get({ name: uploadResult.name });
          }

          console.log(
            `[POST] Status akhir pemrosesan file Gemini: ${fileState.state}`,
          );
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

        console.log(
          `[POST] Model pool yang terdaftar: ${modelPool.join(", ")}`,
        );

        let response: any;
        let lastError: any;

        for (let i = 0; i < modelPool.length; i++) {
          const currentModel = modelPool[i];
          try {
            console.log(
              `[POST] Mencoba memanggil Gemini API dengan Model: ${currentModel}`,
            );
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
                sendStatus(
                  "Sedang menganalisis video & menyusun materi...",
                  80,
                );
              }
            }

            const parts: any[] = [];
            const antiLostInTheMiddlePrompt =
              "\n\nPERHATIAN PENTING: Materi video ini berdurasi panjang. Anda dilarang keras melewatkan poin penting di pertengahan materi (Lost-in-the-Middle). Pastikan Anda menganalisis secara utuh dan kronologis dari awal hingga detik terakhir. Bagilah timeline secara merata dan komprehensif.";

            if (hasTranscript) {
              parts.push({
                text: `${ANALYSIS_PROMPT}${antiLostInTheMiddlePrompt}\n\nBerikut adalah transkrip teks dari video YouTube tersebut (lengkap dengan timestamp):\n\n${transcriptText}`,
              });
            } else {
              parts.push({
                fileData: {
                  fileUri: uploadResult.uri,
                  mimeType: uploadResult.mimeType,
                },
              });
              parts.push({
                text: `${ANALYSIS_PROMPT}${antiLostInTheMiddlePrompt}`,
              });
            }

            response = await getGeminiClient().models.generateContent({
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
                responseSchema: {
                  type: "object",
                  properties: {
                    judul_materi: {
                      type: "string",
                    },
                    ringkasan_eksekutif: {
                      type: "array",
                      items: { type: "string" },
                    },
                    timeline_pembahasan: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          timestamp: {
                            type: "string",
                          },
                          topik: {
                            type: "string",
                          },
                          penjelasan: {
                            type: "string",
                          },
                        },
                        required: ["timestamp", "topik", "penjelasan"],
                      },
                    },
                    glosarium: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          istilah: {
                            type: "string",
                          },
                          arti: {
                            type: "string",
                          },
                        },
                        required: ["istilah", "arti"],
                      },
                    },
                  },
                  required: [
                    "judul_materi",
                    "ringkasan_eksekutif",
                    "timeline_pembahasan",
                    "glosarium",
                  ],
                },
              },
            });

            console.log(
              `[ANALYSIS] Berhasil menganalisis konten menggunakan model: ${currentModel}`,
            );
            break;
          } catch (error: any) {
            lastError = error;
            const status = error.status || error.code;
            console.error(
              `[POST] Gagal menggunakan model ${currentModel}. Error Code/Status: ${status}. Pesan: ${error.message || error}`,
            );
            // Perbolehkan failover untuk error transien/server (500, 503, 429)
            const isTransientError =
              status === 500 || status === 503 || status === 429;
            if (isTransientError && i < modelPool.length - 1) {
              console.warn(
                `Model ${currentModel} gagal (${status || error.message || error}), mencoba model cadangan berikutnya...`,
              );
              continue;
            }
            throw error;
          }
        }

        if (!response) {
          console.error(
            "[POST] Gagal mendapatkan respon dari seluruh model yang dicoba.",
          );
          throw lastError || new Error("Gagal mendapatkan respon dari AI.");
        }

        if (uploadResult?.name) {
          console.log(
            `[POST] Menghapus file video ${uploadResult.name} dari Gemini API storage...`,
          );
          await getGeminiClient().files.delete({ name: uploadResult.name });
          console.log(
            "[POST] Sukses menghapus file video dari Gemini API storage.",
          );
        }

        let responseText = response.text || "{}";
        // console.log("[POST] Raw response text dari Gemini:", responseText);
        responseText = responseText
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        let resultJson: any = {};
        try {
          resultJson = JSON.parse(responseText);
        } catch (jsonErr: any) {
          console.error(
            "[POST] JSON.parse gagal, mencoba mencari JSON block...",
            jsonErr,
          );
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              resultJson = JSON.parse(jsonMatch[0]);
              console.log(
                "[POST] Sukses mengekstrak & mem-parsing JSON block menggunakan regex.",
              );
            } catch (innerErr) {
              console.error(
                "[POST] Gagal mem-parsing JSON block hasil ekstraksi regex:",
                innerErr,
              );
              throw jsonErr;
            }
          } else {
            throw jsonErr;
          }
        }

        // Normalisasi hasil JSON agar selalu konsisten dengan skema target
        resultJson = normalizeAnalysisResult(resultJson);
        console.log(
          `[POST] Sukses mem-parsing & menormalisasi JSON. Judul Materi: "${resultJson.judul_materi}"`,
        );

        const videoFileName =
          shouldKeepOriginal && tempFilePath ? basename(tempFilePath) : null;

        sendStatus("Selesai! Menyusun hasil untuk Anda...", 100);
        console.log(
          "[POST] Mengirimkan hasil sukses dan metadata video ke client.",
        );
        sendSuccess(resultJson, videoFileName);
      } catch (error: any) {
        console.error("[POST] API Error:", error);
        sendError(error.message || "Gagal memproses video");
      } finally {
        if (tempFilePath && !shouldKeepOriginal) {
          try {
            console.log(
              `[POST] Clean up: Menghapus file temp mentah: ${tempFilePath}`,
            );
            await unlink(tempFilePath);
          } catch (_e) {}
        }
        if (compressedPath) {
          try {
            console.log(
              `[POST] Clean up: Menghapus file temp terkompresi: ${compressedPath}`,
            );
            await unlink(compressedPath);
          } catch (_e) {}
        }
        console.log("[POST] Koneksi stream ditutup.");
        console.log("[POST] ===============================================\n");
        controller.close();
      }
    },
  });

  return new Response(customReadable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
