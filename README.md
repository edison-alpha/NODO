# NODO- Download Engine


<img width="1917" height="1143" alt="image" src="https://github.com/user-attachments/assets/ccc870e1-af75-4124-8ce0-6821fe2882a8" />

<img width="1917" height="1145" alt="image" src="https://github.com/user-attachments/assets/4ee7e03d-1fb4-4870-b1ad-6775ef6c9fb8" />



<img width="1917" height="1051" alt="image" src="https://github.com/user-attachments/assets/ce41427d-2fe5-42f2-a80c-d3a7b3c1bfff" />



<img width="1908" height="1042" alt="image" src="https://github.com/user-attachments/assets/a85356ca-3ef1-4aca-9531-edc8ab07dd1e" />


Download manager bergaya IDM: engine download tersegmentasi di Rust, plus aplikasi desktop Tauri + React di atasnya.

Satu repo, dua crate yang digabung lewat Cargo workspace:

| Crate | Isi | Dokumentasi |
| --- | --- | --- |
| `download_engine` | Core engine + CLI. Segmented download, pause/resume/cancel, resume lintas sesi, bandwidth limiter, queue | [download_engine/README.md](download_engine/README.md) |
| `download_engine_gui` | Aplikasi desktop (Tauri 2 + React 19). Memakai `download_engine` sebagai library, bukan memanggil CLI-nya | [download_engine_gui/README.md](download_engine_gui/README.md) |
| `bridge_guard` | Cek otorisasi bridge browser (`Origin`, token, pembuatan token). Dipisah supaya bisa di-unit-test — lihat [Menjalankan tes](#menjalankan-tes) | — |

Engine sengaja berupa library, jadi GUI dan CLI berbagi logic download yang sama tanpa duplikasi.

Di luar workspace Cargo ada satu komponen lagi:

| Folder | Isi | Dokumentasi |
| --- | --- | --- |
| `browser-extension` | Extension Chrome/Edge (MV3). Menu klik-kanan yang mengirim link ke aplikasi lewat bridge loopback-nya | [browser-extension/README.md](browser-extension/README.md) |

## Untuk Pengguna

Belum ada rilis siap-pakai, jadi installer-nya dibangun sendiri sekali. Setelah itu aplikasinya terpasang seperti aplikasi Windows biasa dan tidak butuh toolchain lagi untuk dijalankan.

Siapkan dulu [Setup Environment](#setup-environment) di bawah, lalu:

```powershell
cd download_engine_gui
pnpm install
pnpm tauri build
```

Hasilnya ada di `target/release/bundle/` — installer NSIS (`.exe`) dan MSI, karena `tauri.conf.json` memakai `"targets": "all"`. Jalankan salah satunya; keduanya memasang aplikasi yang sama.

> Build release memakai `lto = true` dan `codegen-units = 1`, jadi ini jauh lebih lama daripada `pnpm tauri dev` — hitungan belasan menit, bukan detik. Untuk sekadar mencoba, `pnpm tauri dev` lebih cepat.

Setelah terpasang, yang perlu dibaca cuma satu dokumen: **[PENGGUNAAN.md](PENGGUNAAN.md)** — menambah download, nama file dari server, status job, aksi borongan, Settings, tray, clipboard monitor, dan bridge browser semuanya di situ, berikut daftar gejala kalau ada yang berperilaku aneh.

Mau kirim link langsung dari browser? Pasang extension-nya: [browser-extension/README.md](browser-extension/README.md) — ada langkah pairing token di situ, dan itu wajib sekali di awal karena bridge menolak permintaan tanpa token.

## Setup Environment

Butuh **Rust**, **Node.js 20+**, dan **pnpm**.

Vite 8 memakai Rolldown, yang butuh API `node:util` yang baru ada di Node 20. Di Node 18 build-nya berhenti dengan `does not provide an export named 'styleText'` — pesannya tidak menyinggung versi Node sama sekali. Kalau pakai nvm, pastikan versinya dulu:

```powershell
nvm use 22
node -v
```

Build Rust di Windows butuh linker C/C++. Kalau Visual Studio Build Tools (MSVC) belum ada, pakai toolchain **GNU**:

```powershell
winget install BrechtSanders.WinLibs.POSIX.UCRT
rustup default stable-x86_64-pc-windows-gnu
```

MinGW harus ada di PATH, bukan cuma terinstall: build script `tauri-winres` memanggil `windres` saat meng-compile crate GUI. Kalau PATH-nya belum permanen, set per sesi:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
```

## Menjalankan

### Aplikasi desktop

```powershell
cd download_engine_gui
pnpm install
pnpm tauri dev
```

Build installer:

```powershell
pnpm tauri build
```

### CLI

```powershell
cargo run -p download_engine -- "https://example.com/file.zip"
```

Flag `-p` wajib karena workspace ini punya lebih dari satu binary — tanpa itu cargo tidak tahu mana yang harus dijalankan.

## Cek sebelum commit

Rust dan frontend dicek terpisah; ketiganya perlu lewat:

```powershell
cargo check --workspace --all-targets
cargo test --workspace
cd download_engine_gui; pnpm exec tsc --noEmit
```

Kalau `cargo check` selesai tanpa satu pun baris `Checking`/`Compiling`, berarti tidak ada yang di-rebuild dan pengecekannya tidak membuktikan apa-apa — `Finished` saja bukan tanda lulus.

## Menjalankan tes

```powershell
cargo test --workspace
```

Saat ini ada 33 tes: 15 di `download_engine/src/filename.rs` (sanitasi nama file dari server), 12 di `download_engine/src/downloader.rs` (pembacaan hasil probe dan pembagian potongan range), dan 6 di `bridge_guard` (batas otorisasi bridge).

### Tes tidak boleh ditaruh di crate `download_engine_gui`

Crate itu disetel `test = false` di `Cargo.toml`-nya, dan itu bukan kelalaian. Menautkan Tauri memunculkan import statis `TaskDialogIndirect` — API milik Common Controls **v6**, sementara `comctl32.dll` di `System32` adalah v5.82. Symbol itu hanya bisa di-resolve lewat manifest aplikasi, dan manifest tersebut ditanam hanya ke target **binary** (`embed_resource::compile` memancarkan `cargo:rustc-link-arg-bins`). Harness `cargo test --lib` adalah exe tanpa manifest, jadi Windows mematikannya dengan `STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`) **sebelum** satu tes pun jalan — bahkan `--list` ikut gagal.

Gejalanya menyesatkan: terlihat seperti masalah DLL, padahal menyalin `WebView2Loader.dll` atau menambah `target/debug` ke PATH hanya menukar error antara `0xC0000135` dan `0xC0000139`. Ini juga **bukan** disebabkan `crate-type = ["staticlib", "cdylib", "rlib"]`, dan **MSVC akan gagal sama saja** karena `rustc-link-arg-bins` adalah direktif Cargo, bukan fitur linker.

Jadi logika yang perlu diuji ditaruh di crate yang tidak menautkan Tauri — itulah alasan `bridge_guard` ada. Taruh tes baru di situ.

## Struktur

```
download_engine/              # core engine + CLI
  src/lib.rs                  # permukaan publik library
  src/downloader.rs           # probe, split segmen, download paralel, retry, fallback
  src/control.rs              # DownloadHandle: pause/resume/cancel + progress per segmen
  src/resume.rs               # sidecar .dengine-part buat lanjut setelah app ditutup
  src/rate_limiter.rs         # token bucket buat throttle
  src/queue.rs                # jalankan banyak job dengan batas concurrency
  src/main.rs                 # CLI (clap + indicatif)

download_engine_gui/          # aplikasi desktop
  src/                        # frontend React
  bridge_guard/src/lib.rs     # cek Origin + token bridge (crate terpisah supaya bisa dites)
  src-tauri/src/lib.rs        # Tauri commands, tray, jembatan ke engine
  src-tauri/src/bridge.rs     # listener HTTP loopback untuk extension browser
  src-tauri/src/persistence.rs# baca/tulis app-state.json

browser-extension/            # extension Chrome/Edge (MV3)
  background.js               # menu klik-kanan, intersepsi download, kirim ke bridge
  options.html / options.js   # pairing token, izin opsional, log intersepsi
  popup.html / popup.js       # popup toolbar: status + kirim link manual
  ui.css                      # styling bersama (statis — MV3 melarang script CDN)
```

## Status Fitur

- [x] Segmented download (HTTP Range) + fallback single connection
- [x] Tiap segmen diminta dalam potongan 8 MiB, bukan satu range raksasa — server yang membatasi ukuran range (Google Drive menolak di atas ~32 MiB) tetap terlayani
- [x] Probe jatuh ke `GET Range: bytes=0-0` kalau HEAD tidak informatif atau gagal
- [x] Segmen menolak balasan selain 206, jadi halaman error tidak pernah ditulis sebagai isi file
- [x] Retry per segmen dengan backoff
- [x] Bandwidth limiter per file dan global
- [x] Queue multi-file + penjadwalan
- [x] Pause / resume / cancel
- [x] Resume lintas sesi (lanjut setelah app ditutup)
- [x] GUI desktop (Tauri)
- [x] Daftar job, setting, dan posisi window tersimpan antar sesi
- [x] Notifikasi sistem saat download selesai/gagal
- [x] System tray (close ke tray, download tetap jalan)
- [x] Aksi buka folder / copy link per job
- [x] Multi-select job (bulk pause/cancel/retry)
- [x] Drag-and-drop URL ke window
- [x] Deteksi URL duplikat + nama file anti-tabrakan
- [x] Nama file dari `Content-Disposition` server (termasuk RFC 5987), disanitasi di engine
- [x] Clipboard monitor (auto-detect link, opt-in)
- [x] Header per job (`Cookie`/`Referer`/`User-Agent`) — fondasi integrasi browser
- [x] HTTP listener localhost + pairing token (opt-in, `127.0.0.1:47283`)
- [x] Extension Chrome/Edge: menu klik-kanan "Download with Download Engine"
- [x] Extension mengambil alih download browser (opt-in, izin `downloads`) — menangkap URL final setelah redirect, yang tidak bisa didapat dari klik-kanan
