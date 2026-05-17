/**
 * Prompt untuk instruksi sistem (System Instruction)
 * Mendefinisikan kepribadian dan batasan AI.
 */
export const SYSTEM_INSTRUCTION =
  process.env.GEMINI_SYSTEM_INSTRUCTION ||
  "Anda adalah seorang pendidik yang ahli menyederhanakan materi teknologi yang rumit menjadi bahasa yang ramah awam. Berikan output HANYA dalam format JSON yang valid.";

/**
 * Prompt untuk analisis video (User Prompt)
 * Mendefinisikan struktur output dan kualitas konten yang diharapkan.
 */
export const ANALYSIS_PROMPT = `
Tolong analisis video materi workshop ini secara mendalam. Ekstrak informasinya dalam format JSON dengan struktur: 

{
  "judul_materi": "string",
  "ringkasan_eksekutif": ["string"],
  "timeline_pembahasan": [
    {
      "timestamp": "MM:SS", 
      "topik": "Judul Sub-topik spesifik", 
      "penjelasan": "Penjelasan komprehensif (minimal 3-5 kalimat) bergaya bahasa santai dan sangat mudah dipahami awam. Jika ada konsep teknis rumit, wajib sertakan analogi dari kehidupan sehari-hari."
    }
  ],
  "glosarium": [
    {
      "istilah": "string", 
      "arti": "Penjelasan sangat sederhana untuk pemula."
    }
  ]
}

Pastikan:
1. Timestamp sangat akurat mengikuti alur video.
2. Rangkuman utuh dari awal hingga akhir video.
3. Bahasa yang digunakan santai, mengalir, dan tidak kaku (human-like).
`;
