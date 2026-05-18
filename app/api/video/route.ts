import { createReadStream } from "fs";
import { stat } from "fs/promises";
import os from "os";
import { join } from "path";
import { type NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");

  // Validasi nama file untuk mencegah path traversal (keamanan)
  if (!name || !/^[a-zA-Z0-9_-]+\.mp4$/.test(name)) {
    return new Response("Nama file tidak valid", { status: 400 });
  }

  const filePath = join(os.tmpdir(), name);

  try {
    const fileStat = await stat(filePath);
    
    // Gunakan ReadableStream untuk melakukan streaming video secara efisien (mendukung seeking)
    const stream = createReadStream(filePath);
    
    // Tipe data stream untuk Web Response Next.js
    const webStream = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => {
          controller.enqueue(chunk);
        });
        stream.on("end", () => {
          controller.close();
        });
        stream.on("error", (err) => {
          controller.error(err);
        });
      },
      cancel() {
        stream.destroy();
      }
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileStat.size.toString(),
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("Gagal me-stream video:", error);
    return new Response("Video tidak ditemukan", { status: 404 });
  }
}
