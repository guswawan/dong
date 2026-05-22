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
  const [_videoFileServer, setVideoFileServer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inputMethod, setInputMethod] = useState<"file" | "url">("url");
  const [xUrlInput, setXUrlInput] = useState<string>("");

  const [showCoinModal, setShowCoinModal] = useState(false);
  const [coinLimitMsg, setCoinLimitMsg] = useState("");

  const [hasMounted, setHasMounted] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isServerOffline, setIsServerOffline] = useState<boolean>(false);
  const [showOfflineToast, setShowOfflineToast] = useState<boolean>(false);
  const [toastType, setToastType] = useState<"offline" | "online" | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playerInstance, setPlayerInstance] = useState<any>(null);

  useEffect(() => {
    setHasMounted(true);
    if (typeof window !== "undefined") {
      setIsOnline(navigator.onLine);

      const handleOnline = () => {
        setIsOnline(true);
        setToastType("online");
        setShowOfflineToast(true);
        setIsServerOffline(false);
        setError(null);
      };

      const handleOffline = () => {
        setIsOnline(false);
        setToastType("offline");
        setShowOfflineToast(true);
      };

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);

      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }
  }, []);

  useEffect(() => {
    if (showOfflineToast && toastType === "online") {
      const timer = setTimeout(() => {
        setShowOfflineToast(false);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [showOfflineToast, toastType]);

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
    setInputMethod("url");
    setError(null);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const selectedFile = e.target.files[0];
      const tempVideoUrl = URL.createObjectURL(selectedFile);

      // Pengecekan durasi client-side
      const videoElement = document.createElement("video");
      videoElement.preload = "metadata";
      videoElement.onloadedmetadata = async () => {
        if (videoElement.duration > 4200) {
          setError("Durasi video melebihi batas maksimal 70 menit.");
          e.target.value = "";
          return;
        }

        if (videoElement.duration > 2700) {
          setShowCoinModal(true);
          setCoinLimitMsg(
            "Durasi video melebihi batas gratis 45 menit. Silakan gunakan Koin Premium untuk memproses video hingga 70 menit.",
          );
          // Clear input file
          e.target.value = "";
          return;
        }

        setFile(selectedFile);
        setVideoUrl(tempVideoUrl);
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
      };
      videoElement.src = tempVideoUrl;
    }
  };

  const handleAnalyze = async () => {
    if (!file && !xUrlInput) return;

    if (typeof window !== "undefined" && !navigator.onLine) {
      setIsOnline(false);
      setToastType("offline");
      setShowOfflineToast(true);
      setError(
        "Koneksi internet terputus. Silakan periksa koneksi Anda dan coba lagi.",
      );
      return;
    }

    setIsServerOffline(false);
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
        let errorMsg = "Gagal memproses video";
        try {
          const data = await response.json();
          errorMsg = data.error || errorMsg;
        } catch (_) {
          if (
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504
          ) {
            throw new Error(`SERVER_ERR_${response.status}`);
          }
        }
        throw new Error(errorMsg);
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
          if (!line.startsWith("data: ")) continue;

          let streamError: Error | null = null;
          let isLimitExceeded = false;

          try {
            const jsonStr = line.replace(/^data:\s*/, "");
            const update = JSON.parse(jsonStr);

            if (update.error) {
              if (update.error === "LIMIT_EXCEEDED") {
                setCoinLimitMsg(
                  update.message || "Durasi video melebihi batas gratis.",
                );
                isLimitExceeded = true;
                streamError = new Error("LIMIT_EXCEEDED");
              } else {
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
              }
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
            if (isLimitExceeded) {
              setShowCoinModal(true);
              setLoading(false);
              return; // Stop processing further for limit errors
            }
            throw streamError;
          }
        }
      }
    } catch (err: any) {
      const isNetworkError =
        err instanceof TypeError && err.message.toLowerCase().includes("fetch");
      const isServerDown =
        err.message.startsWith("SERVER_ERR_") ||
        err.message.includes("503") ||
        err.message.includes("502") ||
        err.message.includes("504");

      if (isNetworkError || isServerDown) {
        setIsServerOffline(true);
        setError(
          "Koneksi ke server gagal. Server dǒng mungkin sedang offline atau mengalami gangguan.",
        );
      } else {
        setError(err.message);
      }
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
    <>
      <div className="min-h-screen bg-gray-50 text-gray-800 p-8 font-sans">
        <div className="max-w-6xl mx-auto space-y-8">
          {/* Header Section */}
          <header className="text-center space-y-2 relative flex flex-col items-center">
            <div className="inline-flex items-center gap-2.5 relative">
              <h1 className="text-4xl font-extrabold tracking-tight text-gray-900">
                d<span className="text-pink-600">ǒ</span>ng
              </h1>
              <div className="flex items-center">
                {isOnline ? (
                  <span
                    title="Koneksi Internet Aktif"
                    className="w-2.5 h-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20 shadow-sm transition-all duration-300"
                  />
                ) : (
                  <span
                    title="Koneksi Internet Terputus"
                    className="w-2.5 h-2.5 rounded-full bg-rose-500 ring-4 ring-rose-500/20 shadow-sm animate-pulse transition-all duration-300"
                  />
                )}
              </div>
            </div>
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
                  setInputMethod("url");
                  setFile(null);
                  setVideoUrl(null);
                }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMethod === "url" ? "bg-white shadow-sm text-blue-600" : "text-gray-500 hover:text-gray-700"}`}
              >
                URL Video
              </button>
              <button
                onClick={() => {
                  setInputMethod("file");
                  setXUrlInput("");
                }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMethod === "file" ? "bg-white shadow-sm text-blue-600" : "text-gray-500 hover:text-gray-700"}`}
              >
                Upload Video
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

            {error && !isServerOffline && (
              <div className="w-full max-w-md p-3 bg-red-50 text-red-700 text-sm rounded-md border border-red-100 text-center">
                {error}
              </div>
            )}
          </div>

          {/* Content Section (Split Layout) */}
          {(videoUrl ||
            result ||
            isServerOffline ||
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
                              diproses. Pratinjau video akan aktif secara
                              otomatis di sini setelah analisis selesai.
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
                          Video sedang dioptimasi agar Gemini bisa membaca
                          materi lebih cepat.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {isServerOffline && !loading && (
                  <div className="h-full flex flex-col items-center justify-center p-4 text-center space-y-6 animate-fade-in">
                    {/* Visual SVG Server Offline */}
                    <div className="relative">
                      {/* Radar pulses */}
                      <div className="absolute inset-0 bg-rose-100 rounded-full scale-150 opacity-15 animate-ping duration-1000"></div>
                      <div className="w-20 h-20 bg-gradient-to-br from-rose-50 to-rose-100 text-rose-500 rounded-full flex items-center justify-center mx-auto shadow-inner border border-rose-200/40 relative">
                        <svg
                          className="w-10 h-10"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <title>Server Offline Icon</title>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.75"
                            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10M9 21v-1a2 2 0 012-2h2a2 2 0 012 2v1"
                          />
                        </svg>
                        {/* Red warning glowing light */}
                        <span className="absolute top-1 right-1 flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500 shadow-sm shadow-rose-500/50"></span>
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-xl font-bold text-gray-900">
                        Koneksi Server Gagal
                      </h3>
                      <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">
                        Aplikasi tidak dapat menghubungi server dǒng. Hal ini
                        biasanya terjadi karena jaringan terputus atau server
                        sedang dalam pemeliharaan berkala.
                      </p>
                    </div>

                    {/* Diagnostics Panel */}
                    <div className="w-full max-w-md bg-gray-50/50 border border-gray-100 rounded-2xl p-5 text-left space-y-3.5 shadow-sm">
                      <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                        Hasil Diagnosis
                      </h4>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-base">📶</span>
                            <span className="font-medium text-gray-700">
                              Koneksi Internet Anda
                            </span>
                          </div>
                          {isOnline ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                              Terhubung
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100 animate-pulse">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                              Terputus
                            </span>
                          )}
                        </div>

                        <div className="flex items-center justify-between text-sm border-t border-gray-100/60 pt-3">
                          <div className="flex items-center gap-2">
                            <span className="text-base">🖥️</span>
                            <span className="font-medium text-gray-700">
                              Status Server dǒng
                            </span>
                          </div>
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100 animate-pulse">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                            Offline / Sibuk
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-sm border-t border-gray-100/60 pt-3">
                          <div className="flex items-center gap-2">
                            <span className="text-base">🤖</span>
                            <span className="font-medium text-gray-700">
                              Layanan Gemini AI
                            </span>
                          </div>
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-100">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                            Tertunda (Menunggu Server)
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Retry Button */}
                    <div className="w-full max-w-sm pt-2 flex flex-col gap-3">
                      <button
                        onClick={handleAnalyze}
                        className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold rounded-xl shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <svg
                          className="w-4 h-4 shrink-0"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <title>Retry Icon</title>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2.2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18"
                          />
                        </svg>
                        Hubungkan Kembali & Analisis Ulang
                      </button>
                      <p className="text-[11px] text-gray-400">
                        *Seluruh data input Anda telah tersimpan dengan aman di
                        browser.
                      </p>
                    </div>
                  </div>
                )}

                {result && !loading && !isServerOffline && (
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

      {/* Modal Dummy Koin - Diposisikan di luar layout grid/flex untuk mencegah malformasi CSS */}
      {showCoinModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/20 backdrop-blur-lg backdrop-saturate-150">
          <div className="bg-white/90 backdrop-blur-xl border border-white/40 rounded-3xl shadow-2xl max-w-md w-full p-8 text-center space-y-6 transform transition-all">
            <div className="w-16 h-16 bg-gradient-to-br from-yellow-100 to-yellow-200 text-yellow-600 rounded-full flex items-center justify-center mx-auto shadow-inner border border-yellow-200/50">
              <svg
                className="w-8 h-8 drop-shadow-sm"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <title>Coin Icon</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                ></path>
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">
                Limit Durasi Tercapai
              </h3>
              <p className="text-sm text-gray-500 mb-4">{coinLimitMsg}</p>
              {/* <p className="text-xs text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-200 text-left leading-relaxed">
                Video berdurasi panjang memakan sumber daya AI yang lebih besar.
                Gunakan <strong className="text-gray-900">Koin Premium</strong>{" "}
                untuk memproses video sampai to the moon.
                :<br />
              <span className="block mt-2 font-medium">• <strong>YouTube:</strong> hingga 240 menit</span>
              <span className="block mt-1 font-medium">• <strong>Upload Video:</strong> hingga 60 menit</span>
              </p> */}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowCoinModal(false)}
                className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors"
              >
                Batal
              </button>
              <a
                href="/pricing"
                className="flex-1 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors inline-flex items-center justify-center"
              >
                Beli Koin
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast Status Koneksi */}
      {showOfflineToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[150] w-full max-w-sm px-4 pointer-events-none transition-all duration-500 ease-out animate-bounce-in">
          <div
            className={`pointer-events-auto flex items-center gap-3.5 px-4.5 py-3.5 rounded-2xl border shadow-2xl backdrop-blur-xl transition-all duration-300 ${
              toastType === "offline"
                ? "bg-rose-50/90 border-rose-200/50 text-rose-800 dark:bg-rose-950/90 dark:border-rose-900/50 dark:text-rose-200"
                : "bg-emerald-50/90 border-emerald-200/50 text-emerald-800 dark:bg-emerald-950/90 dark:border-emerald-900/50 dark:text-emerald-200"
            }`}
          >
            <div
              className={`w-8.5 h-8.5 rounded-xl flex items-center justify-center shadow-inner shrink-0 ${
                toastType === "offline"
                  ? "bg-rose-100 dark:bg-rose-900 text-rose-600 dark:text-rose-300"
                  : "bg-emerald-100 dark:bg-emerald-900 text-emerald-600 dark:text-emerald-300"
              }`}
            >
              {toastType === "offline" ? (
                <svg
                  className="w-5 h-5 animate-pulse"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <title>Warning Offline Icon</title>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-3.536 5 5 0 011.414-3.536m0 0L11.314 11.3m-4.243 4.243L5 18.364M3 3l18 18"
                  />
                </svg>
              ) : (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <title>Success Online Icon</title>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-[14px]">
                {toastType === "offline"
                  ? "Koneksi Terputus"
                  : "Kembali Online"}
              </p>
              <p className="text-[11px] opacity-80 mt-0.5">
                {toastType === "offline"
                  ? "Anda sedang menggunakan mode offline."
                  : "Koneksi internet Anda telah dipulihkan."}
              </p>
            </div>
            <button
              onClick={() => setShowOfflineToast(false)}
              className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-colors pointer-events-auto cursor-pointer"
            >
              <svg
                className="w-4 h-4 opacity-65 hover:opacity-100"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <title>Close Icon</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
