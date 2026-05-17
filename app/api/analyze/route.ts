import { GoogleGenAI } from "@google/genai";
import { exec } from "child_process";
import { stat, unlink, writeFile } from "fs/promises";
import os from "os";
import { join } from "path";
import { promisify } from "util";

import { ANALYSIS_PROMPT, SYSTEM_INSTRUCTION } from "./prompts";

const execAsync = promisify(exec);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
  const fileName = `vid_${Date.now()}.mp4`;
  const outputPath = join(os.tmpdir(), fileName);
  try {
    const command = `yt-dlp -f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/worst" --max-filesize 500M --merge-output-format mp4 -o "${outputPath}" "${url}"`;
    await execAsync(command);
    await stat(outputPath);
    return { tempPath: outputPath, mimeType: "video/mp4" };
  } catch (_error: any) {
    throw new Error("Gagal mengunduh video. Pastikan URL valid.");
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
        }

        sendStatus("Mengunggah video terkompresi...", 45);
        const uploadResult = await ai.files.upload({
          file: compressedPath,
          mimeType: mimeType,
        });

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

        sendStatus("Sedang menganalisis konten video & menyusun materi...", 80);
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || "",
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

        await ai.files.delete({ name: uploadResult.name });

        let responseText = response.text || "{}";
        responseText = responseText
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        const resultJson = JSON.parse(responseText);

        sendStatus("Selesai! Menyusun hasil untuk Anda...", 100);
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ success: true, data: resultJson })}\n`,
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
        const filesToCleanup = [tempFilePath, compressedPath];
        for (const path of filesToCleanup) {
          if (path) {
            try {
              await unlink(path);
            } catch (_e) {}
          }
        }
        controller.close();
      }
    },
  });

  return new Response(customReadable, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
