export default function PricingPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-8 font-sans">
      <div className="max-w-md w-full bg-white p-10 rounded-3xl shadow-sm border border-gray-100 text-center space-y-6">
        <div className="w-20 h-20 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-10 h-10"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Koin Icon</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
        </div>
        <h1 className="text-3xl font-extrabold text-gray-900">Koin Premium</h1>
        <p className="text-gray-500">
          Halaman pembelian Koin Premium sedang dalam tahap pengembangan. Segera
          hadir untuk membantu Anda menganalisis video berdurasi panjang tanpa
          batas!
        </p>

        <div className="pt-6">
          <a
            href="/"
            className="inline-flex px-6 py-3 bg-gray-900 text-white font-medium rounded-xl hover:bg-gray-800 transition-colors w-full justify-center"
          >
            Kembali ke Beranda
          </a>
        </div>
      </div>
    </div>
  );
}
