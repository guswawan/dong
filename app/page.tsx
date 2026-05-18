"use client";

import { del, get, set } from "idb-keyval";
import { useEffect, useRef, useState } from "react";
import ReactPlayer from "react-player";

type AnalysisResult = {
  judul_materi: string;
  ringkasan_eksekutif: string[];
  timeline_pembahasan: {
    timestamp: string;
    topik: string;
    penjelasan: string;
  }[];
  glosarium: { istilah: string; arti: string }[];
};

export default function DashboardPage() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFileServer, setVideoFileServer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inputMethod, setInputMethod] = useState<"file" | "url">("file");
  const [xUrlInput, setXUrlInput] = useState<string>("");

  const [hasMounted, setHasMounted] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playerInstance, setPlayerInstance] = useState<any>(null);
  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    const loadPersistedData = async () => {
      try {
        const savedMethod = localStorage.getItem("inputMethod") as
          | "file"
          | "url";
        if (savedMethod) setInputMethod(savedMethod);

        const savedUrlInput = localStorage.getItem("xUrlInput");
        if (savedUrlInput) setXUrlInput(savedUrlInput);

        const savedResult = localStorage.getItem("analysisResult");
        if (savedResult) setResult(JSON.parse(savedResult));

        const savedFile = await get<File>("videoFile");
        if (savedFile) {
          setFile(savedFile);
          setVideoUrl(URL.createObjectURL(savedFile));
        } else {
          const savedVideoServer = localStorage.getItem("videoFileServer");
          if (savedVideoServer) {
            setVideoFileServer(savedVideoServer);
            setVideoUrl(`/api/video?name=${savedVideoServer}`);
          }
        }
      } catch (err) {
        console.error("Gagal memuat data yang tersimpan:", err);
      }
    };
    loadPersistedData();
  }, []);

  const handleClearData = async () => {
    localStorage.removeItem("analysisResult");
    localStorage.removeItem("inputMethod");
    localStorage.removeItem("xUrlInput");
    localStorage.removeItem("videoFileServer");
    await del("videoFile");

    setResult(null);
    setFile(null);
    setVideoUrl(null);
    setVideoFileServer(null);
    setXUrlInput("");
    setInputMethod("file");
    setError(null);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setVideoUrl(URL.createObjectURL(selectedFile));
      setResult(null);
      setError(null);
      setProgress(0);
      setStatus("");

      try {
        await set("videoFile", selectedFile);
        localStorage.removeItem("analysisResult");
      } catch (err) {
        console.error("Gagal menyimpan video ke storage lokal", err);
      }
    }
  };

  const handleAnalyze = async () => {
    if (!file && !xUrlInput) return;

    setLoading(true);
    setError(null);
    setProgress(0);
    setStatus("Memulai proses...");

    const formData = new FormData();
    if (inputMethod === "file" && file) {
      formData.append("video", file);
    } else if (inputMethod === "url" && xUrlInput) {
      formData.append("url", xUrlInput);
    }

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Gagal memproses video");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Gagal membaca stream respons");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let streamError: Error | null = null;

          try {
            const update = JSON.parse(line);
            if (update.error) {
              //Error JSON string (429 or 503), get only message
              let errorMsg = update.error;
              try {
                //error comes in the form of a double JSON string
                const cleanError = update.error.replace(/^Error: /, "");
                const parsedError = JSON.parse(cleanError);
                errorMsg =
                  parsedError.error?.message ||
                  parsedError.message ||
                  update.error;
              } catch (_e) {
                // error is not JSON, let the original string
              }

              if (
                errorMsg.toLowerCase().includes("quota") ||
                errorMsg.includes("429")
              ) {
                errorMsg =
                  "Batas penggunaan (Quota) API tercapai. Silakan tunggu sebentar lalu coba lagi.";
              } else if (
                errorMsg.toLowerCase().includes("overloaded") ||
                errorMsg.includes("503")
              ) {
                errorMsg =
                  "Server sedang sangat sibuk. Silakan coba lagi dalam beberapa saat.";
              }

              streamError = new Error(errorMsg);
            } else if (update.status) {
              setStatus(update.status);
              setProgress(update.progress || 0);
            } else if (update.success && update.data) {
              setResult(update.data);

              localStorage.setItem(
                "analysisResult",
                JSON.stringify(update.data),
              );
              localStorage.setItem("inputMethod", inputMethod);
              if (inputMethod === "url") {
                localStorage.setItem("xUrlInput", xUrlInput);
                if (update.videoFile) {
                  setVideoFileServer(update.videoFile);
                  localStorage.setItem("videoFileServer", update.videoFile);
                  setVideoUrl(`/api/video?name=${update.videoFile}`);
                }
              }
            }
          } catch (e: any) {
            console.error("Gagal parse line:", line, e);
          }

          if (streamError) {
            throw streamError;
          }
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const parseTimestampToSeconds = (timestamp: string) => {
    const parts = timestamp.split(":").map(Number);
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1]; // Minutes : Seconds
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2]; // Hours : Minutes : Seconds
    }
    return 0;
  };

  const handleJumpToTime = (timestamp: string) => {
    const seconds = parseTimestampToSeconds(timestamp);

    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play?.(); // Autoplay after jump
    } else if (playerInstance) {
      playerInstance.currentTime = seconds;
      playerInstance.play?.(); // Try to play if method is available
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header Section */}
        <header className="text-center space-y-2 relative">
          <h1 className="text-4xl font-extrabold tracking-tight text-gray-900">
            d<span className="text-pink-600">ǒ</span>ng
          </h1>
          <p className="text-gray-500">
            Pahami materi workshop berjam-jam dalam hitungan menit.
          </p>
          {result && (
            <button
              onClick={handleClearData}
              className="absolute top-0 right-0 mt-2 mr-4 text-xs px-3 py-1 bg-red-50 text-red-600 hover:bg-red-100 rounded-full transition-colors"
            >
              Hapus Data (Reset)
            </button>
          )}
        </header>

        {/* Upload Section */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center gap-6">
          {/* Tab Navigation */}
          <div className="flex bg-gray-100 p-1 rounded-lg w-full max-w-md">
            <button
              onClick={() => {
                setInputMethod("file");
                setXUrlInput("");
              }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMethod === "file" ? "bg-white shadow-sm text-blue-600" : "text-gray-500 hover:text-gray-700"}`}
            >
              Upload File
            </button>
            <button
              onClick={() => {
                setInputMethod("url");
                setFile(null);
                setVideoUrl(null);
              }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMethod === "url" ? "bg-white shadow-sm text-blue-600" : "text-gray-500 hover:text-gray-700"}`}
            >
              Link (X, YouTube, dll)
            </button>
          </div>
          {/* Input Area */}
          <div className="w-full max-w-md">
            {inputMethod === "file" ? (
              <input
                key="input-file"
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 transition-all cursor-pointer"
              />
            ) : (
              <input
                key="input-url"
                type="url"
                placeholder="https://x.com/... atau https://youtube.com/..."
                value={xUrlInput}
                onChange={(e) => {
                  setXUrlInput(e.target.value);
                  setResult(null);
                }}
                className="w-full px-4 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            )}
          </div>

          <button
            onClick={handleAnalyze}
            disabled={(!file && !xUrlInput) || loading}
            className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all w-full max-w-md flex justify-center items-center"
          >
            {loading ? (
              <span className="animate-pulse flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                {inputMethod === "url"
                  ? "Mengunduh & Mengompresi..."
                  : "Mengompresi & Memproses AI..."}
              </span>
            ) : (
              "Analisis Video Sekarang"
            )}
          </button>

          {error && (
            <div className="w-full max-w-md p-3 bg-red-50 text-red-700 text-sm rounded-md border border-red-100 text-center">
              {error}
            </div>
          )}
        </div>

        {/* Content Section (Split Layout) */}
        {(videoUrl ||
          result ||
          (inputMethod === "url" && xUrlInput && loading)) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column: Video Player */}
            <div className="space-y-4 sticky top-8 h-fit">
              <div className="bg-black rounded-2xl overflow-hidden shadow-lg aspect-video relative">
                {inputMethod === "file" && videoUrl && (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    className="w-full h-full object-contain"
                  />
                )}
                {inputMethod === "url" &&
                  xUrlInput &&
                  hasMounted &&
                  (() => {
                    const isPlayableLocally =
                      xUrlInput.includes("youtube.com") ||
                      xUrlInput.includes("youtu.be") ||
                      xUrlInput.includes("vimeo.com");
                    if (isPlayableLocally) {
                      return (
                        <ReactPlayer
                          ref={setPlayerInstance}
                          src={xUrlInput}
                          controls
                          width="100%"
                          height="100%"
                          style={{ position: "absolute", top: 0, left: 0 }}
                        />
                      );
                    } else if (videoUrl) {
                      return (
                        <video
                          ref={videoRef}
                          src={videoUrl}
                          controls
                          className="w-full h-full object-contain"
                        />
                      );
                    } else {
                      return (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-900 text-gray-400 p-6 text-center text-sm absolute inset-0">
                          <p className="font-semibold text-white mb-1">
                            Pratinjau Video Twitter/X
                          </p>
                          <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
                            Video dari X tidak bisa diputar langsung sebelum
                            diproses. Pratinjau video akan aktif secara otomatis
                            di sini setelah analisis selesai.
                          </p>
                        </div>
                      );
                    }
                  })()}
              </div>
            </div>

            {/* Right Column: AI Analysis Results */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-[600px] overflow-y-auto custom-scrollbar space-y-8">
              {loading && (
                <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-6 text-center">
                  <div className="relative flex items-center justify-center">
                    <div className="w-20 h-20 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
                    <span className="absolute text-blue-600 font-bold text-xs">
                      {progress}%
                    </span>
                  </div>

                  <div className="space-y-3 w-full max-w-xs">
                    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-600 h-full transition-all duration-500 ease-out"
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                    <div className="space-y-1">
                      <p className="font-bold text-gray-700 text-sm">
                        {status}
                      </p>
                      <p className="text-[10px] text-gray-400 px-4">
                        Video sedang dioptimasi agar Gemini bisa membaca materi
                        lebih cepat.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {result && !loading && (
                <>
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900 leading-tight">
                      {result.judul_materi}
                    </h2>
                  </div>

                  {/* Digest */}
                  <div className="space-y-3">
                    <h3 className="text-lg font-semibold text-blue-600 flex items-center gap-2">
                      💡 Ringkasan Utama
                    </h3>
                    <ul className="space-y-2">
                      {result.ringkasan_eksekutif?.map((poin, idx) => (
                        <li
                          key={idx}
                          className="flex gap-3 text-gray-600 bg-gray-50 p-3 rounded-lg"
                        >
                          <span className="text-blue-500 font-bold">•</span>
                          {poin}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Timeline */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold text-blue-600 flex items-center gap-2">
                      ⏱️ Timeline Pembahasan
                    </h3>
                    <div className="relative border-l-2 border-gray-200 ml-3 space-y-6">
                      {result.timeline_pembahasan?.map((item, idx) => (
                        <div key={idx} className="pl-6 relative group">
                          <div className="absolute w-3 h-3 bg-blue-500 rounded-full -left-[7px] top-1.5 ring-4 ring-white group-hover:scale-125 transition-transform"></div>

                          <button
                            onClick={() => handleJumpToTime(item.timestamp)}
                            title="Lompat ke waktu ini"
                            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded mb-1 hover:bg-blue-600 hover:text-white transition-colors cursor-pointer"
                          >
                            ▶ {item.timestamp}
                          </button>

                          <h4 className="font-semibold text-gray-900">
                            {item.topik}
                          </h4>
                          <p className="text-sm text-gray-600 mt-1">
                            {item.penjelasan}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Glosarium */}
                  <div className="space-y-3">
                    <h3 className="text-lg font-semibold text-blue-600 flex items-center gap-2">
                      📚 Glosarium
                    </h3>
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                      {result.glosarium?.map((item, idx) => (
                        <div
                          key={idx}
                          className="bg-gray-50 p-3 rounded-lg border border-gray-100"
                        >
                          <dt className="font-semibold text-gray-900 text-sm">
                            {item.istilah}
                          </dt>
                          <dd className="text-sm text-gray-600 mt-1">
                            {item.arti}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
