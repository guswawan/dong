// Helper untuk mengambil transkrip video YouTube langsung atau via Invidious

// Dekode entitas HTML umum yang sering muncul di transkrip YouTube
function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// Mengubah format WebVTT Invidious menjadi teks bersih ber-timestamp
function parseWebVTT(vttText: string): string {
  const lines = vttText.split(/\r?\n/);
  let transcript = "";
  let currentTimestamp = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const match = line.match(/^(\d{2}):(\d{2}):(\d{2})/);
      if (match) {
        const hours = match[1];
        const minutes = match[2];
        const seconds = match[3];
        if (hours === "00") {
          currentTimestamp = `[${minutes}:${seconds}]`;
        } else {
          currentTimestamp = `[${hours}:${minutes}:${seconds}]`;
        }
      }
    } else if (
      line &&
      !line.startsWith("WEBVTT") &&
      !line.startsWith("NOTE") &&
      !line.includes("-->") &&
      isNaN(Number(line))
    ) {
      transcript += `${currentTimestamp} ${decodeHTMLEntities(line)}\n`;
    }
  }
  return transcript.trim();
}

// Mengubah format XML YouTube timedtext menjadi teks bersih ber-timestamp
function parseXMLTranscript(xmlText: string): string {
  const regex = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  let match;
  let transcript = "";

  while ((match = regex.exec(xmlText)) !== null) {
    const startSec = parseFloat(match[1]);
    const text = decodeHTMLEntities(match[3]);

    const hours = Math.floor(startSec / 3600);
    const minutes = Math.floor((startSec % 3600) / 60);
    const seconds = Math.floor(startSec % 60);

    const hh = hours > 0 ? `${hours.toString().padStart(2, '0')}:` : '';
    const mm = minutes.toString().padStart(2, '0');
    const ss = seconds.toString().padStart(2, '0');
    const timestamp = `[${hh}${mm}:${ss}]`;

    transcript += `${timestamp} ${text}\n`;
  }

  return transcript.trim();
}

// Mendapatkan daftar track caption langsung dari halaman watch YouTube
async function getCaptionTracksFromHTML(videoId: string): Promise<any[]> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Gagal memuat halaman YouTube (HTTP ${response.status})`);
  }

  const html = await response.text();
  const regex = /ytInitialPlayerResponse\s*=\s*({.+?});/;
  const match = html.match(regex);
  if (!match) {
    throw new Error("Tidak dapat mengekstrak metadata video (ytInitialPlayerResponse tidak ditemukan)");
  }

  const playerResponse = JSON.parse(match[1]);
  const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error("Transkrip/Subtitle dinonaktifkan atau tidak tersedia untuk video ini.");
  }

  return captions;
}

// Mencoba mengambil transkrip langsung dari YouTube
async function fetchDirectYouTubeTranscript(videoId: string): Promise<string> {
  const captions = await getCaptionTracksFromHTML(videoId);

  // Cari bahasa Indonesia terlebih dahulu, lalu bahasa Inggris, baru lainnya
  let selectedTrack = captions.find((c: any) => c.languageCode === 'id' || c.languageCode?.startsWith('id-'));
  if (!selectedTrack) {
    selectedTrack = captions.find((c: any) => c.languageCode === 'en' || c.languageCode?.startsWith('en-'));
  }
  if (!selectedTrack) {
    selectedTrack = captions[0];
  }

  if (!selectedTrack || !selectedTrack.baseUrl) {
    throw new Error("Tidak menemukan tautan untuk caption track.");
  }

  const res = await fetch(selectedTrack.baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Gagal mengunduh file transkrip (HTTP ${res.status})`);
  }

  const xmlText = await res.text();
  if (!xmlText || xmlText.trim().length === 0) {
    throw new Error("Konten transkrip yang diterima kosong.");
  }

  return parseXMLTranscript(xmlText);
}

// Mencoba mengambil transkrip via instansi Invidious
async function fetchInvidiousTranscript(videoId: string, activeInstances: string[]): Promise<string> {
  const staticInstances = [
    "https://invidious.f5.si",
    "https://yewtu.be",
    "https://invidious.projectsegfaut.im",
    "https://invidious.privacydev.net",
    "https://inv.tux.im",
  ];

  const allInstances = Array.from(
    new Set([...activeInstances, ...staticInstances])
  ).filter((uri) => uri && uri.startsWith("http"));

  let lastError: any = null;

  for (const instance of allInstances) {
    const cleanInstance = instance.endsWith('/') ? instance.slice(0, -1) : instance;
    try {
      console.log(`[TRANSCRIPT] Mencoba mengambil daftar caption dari Invidious: ${cleanInstance}`);
      const res = await fetch(`${cleanInstance}/api/v1/captions/${videoId}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}`);
      }

      const data = await res.json();
      const captions = data.captions || [];
      if (captions.length === 0) {
        throw new Error("Tidak ada caption track yang tersedia di instansi ini.");
      }

      // Cari bahasa Indonesia lalu bahasa Inggris
      let track = captions.find((c: any) => c.languageCode === 'id' || c.languageCode?.startsWith('id-'));
      if (!track) {
        track = captions.find((c: any) => c.languageCode === 'en' || c.languageCode?.startsWith('en-'));
      }
      if (!track) {
        track = captions[0];
      }

      const trackUrl = track.url.startsWith('/') ? `${cleanInstance}${track.url}` : track.url;
      console.log(`[TRANSCRIPT] Mengunduh WebVTT dari: ${trackUrl}`);

      const trackRes = await fetch(trackUrl, {
        signal: AbortSignal.timeout(6000),
      });

      if (!trackRes.ok) {
        throw new Error(`Gagal mengunduh VTT: HTTP ${trackRes.status}`);
      }

      const vttText = await trackRes.text();
      if (!vttText || vttText.trim().length === 0) {
        throw new Error("File WebVTT kosong (0 byte).");
      }

      const parsed = parseWebVTT(vttText);
      if (parsed.length > 0) {
        console.log(`[TRANSCRIPT] Sukses mengambil transkrip via Invidious: ${cleanInstance}`);
        return parsed;
      }
      throw new Error("Parsing VTT menghasilkan teks kosong.");
    } catch (e: any) {
      console.warn(`[TRANSCRIPT] Instansi Invidious ${cleanInstance} gagal:`, e.message || e);
      lastError = e;
    }
  }

  throw new Error(`Semua instansi Invidious gagal. Error terakhir: ${lastError?.message || lastError}`);
}

// Fungsi utama untuk mengambil transkrip video YouTube
export async function getYouTubeTranscript(videoId: string, activeInvidiousInstances: string[] = []): Promise<string> {
  console.log(`[TRANSCRIPT] Memulai pengambilan transkrip untuk video ID: ${videoId}`);
  
  // 1. Coba langsung dari YouTube (Cepat jika tidak diblokir)
  try {
    const transcript = await fetchDirectYouTubeTranscript(videoId);
    if (transcript && transcript.length > 0) {
      return transcript;
    }
  } catch (err: any) {
    console.warn(`[TRANSCRIPT] Gagal mengambil langsung dari YouTube: ${err.message || err}. Mencoba metode alternatif...`);
  }

  // 2. Coba via Invidious API
  try {
    const transcript = await fetchInvidiousTranscript(videoId, activeInvidiousInstances);
    if (transcript && transcript.length > 0) {
      return transcript;
    }
  } catch (err: any) {
    console.error(`[TRANSCRIPT] Semua upaya pengambilan transkrip gagal:`, err.message || err);
  }

  throw new Error("Gagal mengambil transkrip video YouTube. Transkrip tidak tersedia atau pemblokiran YouTube sangat ketat.");
}
