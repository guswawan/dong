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
      if (file.startsWith("vid_") && file.endsWith("_compressed.mp4")) {
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

async function downloadUniversalVideo(
  url: string,
): Promise<{ tempPath: string; mimeType: string }> {
  const fileBase = `vid_${Date.now()}`;
  const outputPath = join(os.tmpdir(), fileBase);
  try {
    const command = `yt-dlp --print "after_move:filepath" --no-quiet --no-progress --no-simulate -f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best" --max-filesize 500M --match-filter "duration <= 900" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    const { stdout, stderr } = await execAsync(command);

    if (
      stdout.includes("does not pass filter") ||
      (stderr && stderr.includes("does not pass filter"))
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

    throw new Error(
      "Gagal mengunduh video. Pastikan URL valid, publik, dan dapat diakses.",
    );
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
      let shouldKeepCompressed = false;

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
          shouldKeepCompressed = true;
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

        let response;
        let lastError;

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
          shouldKeepCompressed && compressedPath
            ? basename(compressedPath)
            : null;

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
        if (tempFilePath) {
          try {
            await unlink(tempFilePath);
          } catch (_e) {}
        }
        if (compressedPath && !shouldKeepCompressed) {
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
