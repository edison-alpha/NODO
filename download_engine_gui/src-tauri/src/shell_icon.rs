//! The icon Windows itself shows for a file in Explorer, as RGBA pixels.
//!
//! An existing file is asked for its own icon, so an `.exe` comes back with the
//! app's real artwork. A path that does not exist yet (a download still in
//! flight) is looked up by extension alone, which gives the icon of whatever
//! app is registered for that type.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;

use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW, HBITMAP, ReleaseDC,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
use windows_sys::Win32::UI::Controls::{HIMAGELIST, ILD_TRANSPARENT, ImageList_GetIcon};
use windows_sys::Win32::UI::Shell::{SHFILEINFOW, SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES, SHGetFileInfoW, SHGetImageList, SHIL_EXTRALARGE, SHIL_JUMBO};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
use windows_sys::core::GUID;

const IID_IIMAGELIST: GUID = GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

/// Jumbo art smaller than this is padded into the top-left corner of a 256px
/// canvas; the 48px list is the better image for those types.
const SMALL_ART: u32 = 48;

#[repr(C)]
struct IUnknownVtbl {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

pub struct Pixels {
    pub width: u32,
    pub height: u32,
    /// Straight RGBA, top row first.
    pub rgba: Vec<u8>,
}

pub fn file_icon(path: &str) -> Option<Pixels> {
    let exists = std::path::Path::new(path).exists();
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

    // SAFETY: every handle obtained here is released before returning; the
    // image lists are system-owned singletons and only lose our reference.
    unsafe {
        // The shell needs COM on this thread. Already initialised is fine.
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _);

        let mut info: SHFILEINFOW = zeroed();
        let flags = SHGFI_SYSICONINDEX | if exists { 0 } else { SHGFI_USEFILEATTRIBUTES };
        if SHGetFileInfoW(wide.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut info, size_of::<SHFILEINFOW>() as u32, flags) == 0 {
            return None;
        }

        for list in [SHIL_JUMBO, SHIL_EXTRALARGE] {
            let mut ptr: *mut c_void = null_mut();
            if SHGetImageList(list as i32, &IID_IIMAGELIST, &mut ptr) != 0 || ptr.is_null() {
                continue;
            }
            // An IImageList pointer doubles as an HIMAGELIST.
            let icon = ImageList_GetIcon(ptr as HIMAGELIST, info.iIcon, ILD_TRANSPARENT);
            let vtbl = *(ptr as *const *const IUnknownVtbl);
            ((*vtbl).release)(ptr);
            if icon.is_null() {
                continue;
            }
            let pixels = icon_pixels(icon);
            DestroyIcon(icon);
            match pixels {
                Some(p) if list == SHIL_JUMBO && art_fits_in(&p, SMALL_ART) => continue,
                Some(p) => return Some(p),
                None => continue,
            }
        }
        None
    }
}

/// True when nothing is drawn outside the top-left `size`×`size` square.
fn art_fits_in(p: &Pixels, size: u32) -> bool {
    if p.width <= size && p.height <= size {
        return false;
    }
    (0..p.height).all(|y| (0..p.width).all(|x| (x < size && y < size) || p.rgba[((y * p.width + x) * 4 + 3) as usize] == 0))
}

unsafe fn icon_pixels(icon: HICON) -> Option<Pixels> {
    unsafe {
        let mut ii: ICONINFO = zeroed();
        if GetIconInfo(icon, &mut ii) == 0 {
            return None;
        }
        let result = bitmap_rgba(ii.hbmColor, ii.hbmMask);
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask);
        }
        result
    }
}

unsafe fn bitmap_rgba(color: HBITMAP, mask: HBITMAP) -> Option<Pixels> {
    unsafe {
        if color.is_null() {
            return None;
        }
        let mut bm: BITMAP = zeroed();
        if GetObjectW(color, size_of::<BITMAP>() as i32, &mut bm as *mut BITMAP as *mut c_void) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 {
            return None;
        }

        let mut bi: BITMAPINFO = zeroed();
        bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // negative: top-down rows
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB as _;

        let dc = GetDC(null_mut());
        let mut px = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(dc, color, 0, h as u32, px.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS);

        // Old-style icons carry no alpha; their transparency is in the mask.
        if lines != 0 && !mask.is_null() && px.chunks_exact(4).all(|p| p[3] == 0) {
            let mut m = vec![0u8; px.len()];
            if GetDIBits(dc, mask, 0, h as u32, m.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS) != 0 {
                for (p, mm) in px.chunks_exact_mut(4).zip(m.chunks_exact(4)) {
                    p[3] = if mm[0] == 0 { 255 } else { 0 };
                }
            }
        }
        ReleaseDC(null_mut(), dc);
        if lines == 0 {
            return None;
        }
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2); // BGRA -> RGBA
        }
        Some(Pixels { width: w as u32, height: h as u32, rgba: px })
    }
}
