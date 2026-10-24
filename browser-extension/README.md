# Download Engine — Extension Browser

Extension Chrome/Edge yang menambahkan menu klik-kanan **"Download with Download Engine"**. Link yang kamu pilih dikirim ke aplikasi desktop yang sedang jalan di komputer yang sama, lewat bridge HTTP loopback-nya.

Bukan sebuah downloader sendiri. Yang dikerjakannya hanya: ambil URL, kumpulkan konteks request yang mungkin diperlukan, kirim satu POST. Semua urusan segmen, resume, dan penulisan file tetap di engine Rust.

## Memasang

Belum di Web Store, jadi dipasang sebagai unpacked extension.

1. Buka `chrome://extensions` (atau `edge://extensions`).
2. Nyalakan **Developer mode**.
3. **Load unpacked** → pilih folder `browser-extension` ini.

> Setelah menarik perubahan yang menyentuh `manifest.json`, tekan **↻ Reload** di kartu extension. Chrome membaca `options.html` dan `background.js` dari disk setiap kali, tapi manifest hanya saat dimuat — jadi UI baru bisa muncul sementara izin barunya belum terdaftar, dan Chrome akan menolak memunculkan prompt izin yang menurut manifest lamanya tidak ada.

## Pairing

Bridge menolak permintaan tanpa token, jadi ini wajib sekali di awal:

1. Di aplikasi: **Settings → Integrations → Accept links from the extension** → nyalakan.
2. Copy **Token Pairing** yang muncul di bawahnya.
3. Klik ikon extension di toolbar. Selama belum di-pairing, popup langsung menampilkan kartu **Connect to nodo**.
4. Tempel token → **Connect**. (Bisa juga dari **All settings** → **Save & test**.)

Pengujian koneksi membedakan tiga kegagalan yang terasa sama tapi penyebabnya beda: aplikasi tidak jalan, aplikasi jalan tapi bridge-nya mati, dan aplikasi terhubung tapi token salah. Menyimpan token yang diam-diam tidak berfungsi jauh lebih membingungkan.

Token disimpan di `chrome.storage.local`, bukan `sync`. Token ini hanya berlaku untuk aplikasi di satu komputer, jadi menyebarkannya lewat akun Google ke profil lain yang tidak punya aplikasinya hanya memperluas tempat bocornya kredensial tanpa manfaat.

## Memakai

Klik kanan sebuah **link**, **video**, **audio**, atau **gambar** → **Download with Download Engine**.

Menu ini hanya muncul di atas link dan media, bukan di area kosong halaman — itu context yang didaftarkan extension, bukan kelalaian. Tombol "Download" di banyak situs bukan link (ia men-submit form), jadi tidak ada yang bisa diklik-kanan di sana. Untuk kasus itu, pakai **Ambil alih download browser** di bawah.

Hasilnya muncul sebagai badge kecil di ikon extension — ✓ hijau kalau diterima, ! merah kalau tidak, dengan alasannya di tooltip. Badge dipilih daripada notifikasi sistem karena notifikasi butuh izin tersendiri untuk sesuatu sekecil ini.

Klik ikon extension untuk **popup**-nya: status koneksi ke aplikasi, kolom tempel URL untuk mengirim link manual, switch tombol video dan dua izin opsional, dan jalan pintas **All settings**. Kolom manual itu berguna untuk URL yang kamu dapat dari tempat lain — misalnya hasil **Copy link address** di `chrome://downloads`.

Job langsung masuk daftar di aplikasi dan ikut antrian seperti download yang kamu tambahkan sendiri — scheduler aplikasi yang menentukan kapan mulai, menghormati batas Concurrency.

## Izin yang diminta

| Izin | Kenapa |
| --- | --- |
| `contextMenus` | menu klik-kanan itu sendiri |
| `storage` | menyimpan token pairing |
| `http://127.0.0.1:47283/*` | satu-satunya alamat yang dihubungi extension ini |
| `activeTab` | popup membaca alamat tab aktif, hanya untuk tombol "Show again" di situs yang tombol videonya disembunyikan |
| content script di `http(s)://*/*` | tombol download video melayang (lihat di bawah) |

### Tombol download video melayang

Seperti panel "Download this video" di IDM: tombol kaca bulat muncul di halaman YouTube (watch, Shorts, live) dan di halaman mana pun yang punya video cukup besar (≥ 200×112 px). Klik untuk memilih kualitas; geser untuk memindahkannya (posisinya diingat). × kecil saat hover menyembunyikannya di situs itu; popup extension bisa memunculkannya lagi, dan switch "Video download button" mematikannya di semua situs.

Daftar kualitas datang dari aplikasi, yang menjalankan **yt-dlp** pada URL halaman — jadi yang ditawarkan adalah format yang benar-benar ada, bukan tebakan. yt-dlp dan FFmpeg dipasang aplikasi sendiri saat pertama dipakai, dari rilis GitHub resmi, dicek SHA-256-nya. Kalau video di halaman berupa file langsung (`.mp4`, `.webm`, bukan blob/stream), menu juga menawarkan **Direct file** yang diunduh engine nodo biasa.

Yang perlu diketahui soal content script ini: ia berjalan di setiap halaman http(s), dan itulah yang membuat Chrome menampilkan peringatan "membaca dan mengubah data di semua situs" saat memasang. Yang dikerjakannya hanya mencari elemen `<video>` dan menggambar tombol di shadow root tertutup — tidak membaca isi halaman lain, tidak mengirim apa pun sampai kamu memilih kualitas, dan tidak pernah bicara langsung dengan aplikasi: semua request lewat service worker yang memegang token.

Unduh hanya video yang memang boleh kamu simpan.

### Ambil alih download browser — opsional

| Izin | Kenapa |
| --- | --- |
| `downloads` | **opsional.** Baru diminta kalau kamu mencentang "Ambil alih download browser" |

Menu klik-kanan hanya melihat `href` sebuah link, dan di banyak situs itu bukan yang benar-benar diunduh. Halaman perantara, form submit, dan rantai redirect menghasilkan URL lain — URL final baru diketahui setelah browser menelusurinya sendiri. Google Drive adalah contohnya: tombol "Download anyway" bukan link, dan link nama file di atasnya menunjuk ke halaman preview, bukan ke file-nya.

Dengan izin ini, extension mendengarkan `chrome.downloads.onCreated`, mengambil `finalUrl` milik download itu, mengirimkannya ke aplikasi, lalu membatalkan dan menghapus entri di browser.

**Urutannya disengaja: kirim dulu, batalkan belakangan.** Pembatalan hanya terjadi setelah aplikasi menjawab menerima job-nya. Kalau aplikasi sedang tutup, bridge-nya mati, atau token salah, download-mu tidak disentuh sama sekali dan browser menyelesaikannya seperti biasa. Urutan sebaliknya akan membuat setiap download yang dimulai saat aplikasi tutup lenyap tanpa pengganti.

Yang tidak diambil alih:

- URL non-`http(s)` — `blob:`, `data:`, `filesystem:`. URL itu hanya hidup di dalam memori browser, jadi mengirimkannya hanya akan membuat job yang tidak pernah bisa selesai setelah membatalkan download yang tadinya baik-baik saja.
- Apa pun, kalau token belum diisi.

Perlu diketahui: izin ini memperlihatkan **seluruh** aktivitas download-mu ke extension, dan "Save page as" pun ikut terambil alih. Kalau menu klik-kanan sudah cukup, biarkan mati. Izin bisa dicabut kapan saja, dan listener-nya ikut dilepas begitu itu terjadi.

### Cookie — opsional, dan sengaja begitu

| Izin | Kenapa |
| --- | --- |
| `cookies` + `<all_urls>` | **opsional.** Baru diminta kalau kamu mencentang "Sertakan cookie situs" |

Tanpa ini, link yang butuh login akan mengunduh halaman login atau gagal dengan 403, karena request dari engine tidak membawa sesi browser-mu.

Tapi mengaktifkannya memberi extension kemampuan membaca **semua** cookie-mu, termasuk yang `HttpOnly` — yang justru dirancang supaya tidak bisa dibaca JavaScript halaman mana pun. Itu kenaikan akses yang nyata, jadi tidak saya jadikan izin wajib: extension terpasang tanpa izin ini, dan kamu yang memutuskan.

Yang membatasi dampaknya:

- Cookie hanya dibaca **saat kamu menekan menu klik-kanan**, bukan terus-menerus.
- Hanya cookie untuk **situs link itu** (`chrome.cookies.getAll({ url })`), bukan seluruh jar.
- Hanya dikirim ke `127.0.0.1` — aplikasi di komputer ini.
- Di sisi aplikasi, cookie **tidak ditulis ke disk**. Hidup di memori selama aplikasi jalan, lalu hilang.

Izin bisa dicabut kapan saja dari halaman extension Chrome. Checkbox di halaman opsi membaca izin yang sebenarnya, bukan preferensi tersimpan, jadi kalau kamu cabut dari luar, centangnya ikut hilang.

Kalau izin belum ada, extension **tidak** diam-diam memintanya saat kamu klik menu — prompt izin butuh gesture pengguna dan tidak bisa dimunculkan dari handler menu. Jadi link bergerbang akan gagal secara terlihat sampai kamu menyalakannya sendiri.

## Log intersepsi

Bagian **Recent activity** di halaman pengaturan mencatat setiap URL yang diserahkan ke aplikasi: waktu, URL, asalnya (klik-kanan / intersepsi / popup), ada tidaknya cookie, dan apakah aplikasi menerimanya. Tanpa ini, satu-satunya cara tahu sebuah download sampai atau tidak adalah menebak.

Maksimal 50 entri terakhir, disimpan di `chrome.storage.local` — jadi ikut `local` dan bukan `sync`, karena ini daftar URL yang kamu kunjungi dan tidak ada alasan menyebarkannya ke profil lain lewat akun Google. Tombol **Clear** menghapus semuanya.

## Yang dikirim

```json
POST http://127.0.0.1:47283/download
x-download-engine-token: <token>

{
  "url": "https://example.com/file.zip",
  "headers": {
    "user-agent": "<User-Agent browser ini>",
    "referer": "<URL halaman tempat link berada>",
    "cookie": "<cookie situs itu, kalau izinnya ada>"
  }
}
```

Tidak ada yang dikarang: `referer` adalah halaman tempat link benar-benar berada, `user-agent` adalah milik browser ini sendiri. Mengirim nilai palsu hanya akan membuat server yang teliti berperilaku beda dari yang dialami browser.

`referer` dilewati kalau halamannya bukan `http(s)` — misalnya link di `chrome://` atau di halaman extension lain.

Di sisi aplikasi, header ini difilter terhadap allowlist sebelum dipakai (`cookie`, `referer`, `user-agent`, `authorization`, `accept`, `accept-language`, `origin`); sisanya dibuang. Jadi extension tidak bisa dipakai memalsukan request sembarangan, bahkan kalau extension-nya sendiri yang bermasalah.

## Nama file

Nama file **tidak** diambil dari permintaan extension. Menerima nama dari luar berarti nama itu digabungkan ke folder tujuan, dan `..\..\` di dalamnya akan menulis ke mana pun si pengirim mau.

Untuk URL seperti `/download?id=84213`, nama yang dipakai datang dari header `Content-Disposition` milik server — dibaca engine saat probe, lalu dibersihkan di sisi Rust sebelum sampai ke mana pun (lihat `download_engine/src/filename.rs`). Pembersihannya menyisakan satu komponen path saja: separator, `..`, titik/spasi di ujung, karakter kontrol, dan nama device Windows (`CON`, `NUL`, `COM1`, …) tidak akan lolos, dan nama yang habis dibersihkan jatuh kembali ke nama dari URL — bukan ke apa pun pilihan server.

Perbedaannya dengan menerima nama dari extension: server memang pihak yang sudah dipercaya mengirim isi file-nya, dan satu-satunya hal yang bisa ia pengaruhi di sini adalah nama di dalam folder tujuan yang user pilih sendiri.

## Browser lain

Dites untuk **Chrome** dan **Edge**. Manifest-nya MV3 standar dan `moz-extension://` juga sudah diterima bridge, jadi Firefox kemungkinan jalan — tapi belum dicoba, dan `chrome.permissions` di Firefox punya beberapa perbedaan perilaku.

## Keamanan bridge

Soal kenapa port loopback ini tidak bisa dipakai halaman web sembarangan, dan kenapa token tetap wajib padahal sudah ada cek `Origin`: lihat [README GUI](../download_engine_gui/README.md#bridge-extension-browser).
