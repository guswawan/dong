# dǒng

**dǒng** dibuat untuk yang males nonton, jadi kesimpulannya apa. Membantu memahami materi workshop, webinar, TED Talks, atau video conference berdurasi panjang dalam hitungan menit. 

Mengubah video menjadi ringkasan eksekutif, timeline pembahasan yang interaktif, dan glosarium istilah teknis yang mudah dipahami.

---

## 🚀 Fitur Utama

- **Analisis AI Mendalam:** Menggunakan Google Gemini AI untuk mengekstrak inti sari video.
- **Optimasi Video Panjang:** Menggunakan teknik **frame-rate compression** yang memungkinkan analisis video tanpa kehilangan konteks visual.
- **Dukungan Multi-Sumber:** Upload file video atau gunakan link universal dari YouTube, X (Twitter), dan platform lainnya.
- **Failover Robustness:** Sistem pool model yang otomatis tanpa membatalkan proses analisis.
<!-- - **Limitasi & Validasi Video:** Proteksi durasi video (maksimal 20 menit) untuk pengunggahan via URL guna memastikan proses pengunduhan & kompresi berjalan optimal. -->
- **Progressive UI:** Update status real-time dengan progress bar sehingga Anda tahu persis apa yang sedang dilakukan sistem.
- **Timeline Interaktif:** Klik pada timestamp untuk melompat ke bagian spesifik.
- **Glosarium Otomatis:** Menjelaskan istilah teknis/slogan/bahasa sulit dengan analogi sederhana yang ramah untuk orang awam.

---

## 🛠️ Tech Stack

- **Frontend & Backend:** [Next.js 15+](https://nextjs.org/) (App Router)
- **AI Engine:** [Google Gemini API](https://ai.google.dev/)
- **Video Processing:** [FFmpeg](https://ffmpeg.org/)
- **Downloader:** [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Linting & Formatting:** [Biome](https://biomejs.dev/)
- **Runtime:** [Bun](https://bun.sh/)

---

## 📦 Prasyarat

Sebelum menjalankan proyek ini, pastikan sudah menginstal:

1.  **Bun** atau **Node.js**
2.  **FFmpeg** (Pastikan tersedia di PATH sistem)
3.  **yt-dlp** (Untuk fitur analisis lewat URL)
4.  **Google Gemini API Key** (Dapatkan di [Google AI Studio](https://aistudio.google.com/))

---

## ⚙️ Instalasi & Persiapan

1.  **Clone repositori:**
    ```bash
    git clone https://github.com/username/dong.git
    cd dong
    ```

2.  **Instal dependensi:**
    ```bash
    bun install
    ```

3.  **Konfigurasi Environment:**
    Buat file `.env.local` di akar proyek dan tambahkan variabel berikut:
    ```env
    GEMINI_API_KEY=your_api_key_here
    GEMINI_MODEL=your_model_here
    GEMINI_FALLBACK_MODELS=your_llm_model
    ```

---

## 🖥️ Menjalankan Proyek

1.  **Mode Pengembangan:**
    ```bash
    bun dev
    ```
    Buka [http://localhost:3000](http://localhost:3000) di browser.

2.  **Pengecekan Kode (Linter):**
    ```bash
    bun run check
    ```

<!-- --- -->

<!-- ## 💡 Bagaimana Cara Kerjanya?

Untuk menangani video durasi panjang, dǒng menggunakan strategi optimasi khusus:

1.  **Downsampling:** Jika menggunakan URL, video diunduh pada resolusi maksimal 360p.
2.  **1 FPS Encoding:** Video dikompresi menjadi hanya 1 frame per detik. Ini mengurangi ukuran file hingga >90% namun tetap mempertahankan teks pada slide materi agar dapat dibaca oleh Gemini.
3.  **Audio Downsampling:** Audio dikompresi ke bitrate rendah yang efisien untuk diproses oleh AI.
4.  **NDJSON Streaming:** Backend mengirimkan progres langkah-demi-langkah ke Frontend agar pengguna mendapatkan umpan balik instan. -->
