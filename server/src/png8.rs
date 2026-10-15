//! Indexed ("palettized") PNG for watch images, as the Pebble docs recommend for
//! colour watches. A dithered render only uses Pebble's 64 colours, so an indexed
//! PNG holds it losslessly in about a third of the raw bytes, and doubles as the
//! preview for the settings page.
//!
//! The watch wants raw `GColor8` bytes (0b11RRGGBB per pixel); converting
//! between the two is a lookup per pixel.

use std::io::Cursor;

use anyhow::{bail, Context, Result};

fn rgb_of(gcolor: u8) -> [u8; 3] {
    [
        ((gcolor >> 4) & 3) * 85,
        ((gcolor >> 2) & 3) * 85,
        (gcolor & 3) * 85,
    ]
}

fn gcolor_of(rgb: &[u8]) -> u8 {
    0xC0 | ((rgb[0] / 85) << 4) | ((rgb[1] / 85) << 2) | (rgb[2] / 85)
}

/// Encode watch bytes (`w` pixels per row, rows `stride` bytes apart) as PNG.
pub fn encode(raw: &[u8], w: u32, h: u32, stride: u32) -> Result<Vec<u8>> {
    let (w_us, stride_us) = (w as usize, stride as usize);
    if raw.len() < stride_us * h as usize || stride_us < w_us {
        bail!("raw buffer too small for {w}x{h} with stride {stride}");
    }
    // Palette = the colours actually used, in byte order so output is stable.
    let mut used = [false; 256];
    for row in raw.chunks(stride_us).take(h as usize) {
        for &b in &row[..w_us] {
            used[(b | 0xC0) as usize] = true;
        }
    }
    let colours: Vec<u8> = (0..=255u8).filter(|&b| used[b as usize]).collect();
    let mut index = [0u8; 256];
    for (i, &c) in colours.iter().enumerate() {
        index[c as usize] = i as u8;
    }
    let pixels: Vec<u8> = raw
        .chunks(stride_us)
        .take(h as usize)
        .flat_map(|row| row[..w_us].iter().map(|&b| index[(b | 0xC0) as usize]))
        .collect();

    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Indexed);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_palette(colours.iter().flat_map(|&c| rgb_of(c)).collect::<Vec<u8>>());
    enc.set_compression(png::Compression::High);
    let mut writer = enc.write_header()?;
    writer.write_image_data(&pixels)?;
    writer.finish()?;
    Ok(out)
}

/// Decode an indexed PNG back to watch bytes (rows `stride` bytes apart).
pub fn decode_to_raw(png_bytes: &[u8], stride: u32) -> Result<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().context("not a PNG")?;
    let info = reader.info();
    if info.color_type != png::ColorType::Indexed || info.bit_depth != png::BitDepth::Eight {
        bail!("expected an 8-bit indexed PNG");
    }
    let palette = info
        .palette
        .as_ref()
        .context("PNG has no palette")?
        .to_vec();
    let (w, h) = (info.width, info.height);
    if stride < w {
        bail!("stride {stride} is smaller than width {w}");
    }
    let mut pixels = vec![0u8; reader.output_buffer_size().context("image too large")?];
    reader.next_frame(&mut pixels)?;

    let lut: Vec<u8> = palette.chunks(3).map(gcolor_of).collect();
    let mut raw = vec![0xC0u8; (stride * h) as usize];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = pixels[y * w as usize + x] as usize;
            raw[y * stride as usize + x] = *lut.get(i).unwrap_or(&0xC0);
        }
    }
    Ok((w, h, raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_watch_bytes() {
        let (w, h) = (13u32, 7u32);
        let raw: Vec<u8> = (0..w * h).map(|i| 0xC0 | ((i * 7) % 64) as u8).collect();
        let png = encode(&raw, w, h, w).unwrap();
        let (dw, dh, back) = decode_to_raw(&png, w).unwrap();
        assert_eq!((dw, dh), (w, h));
        assert_eq!(back, raw);
    }

    #[test]
    fn respects_stride_padding() {
        let raw = vec![0xC3, 0xFF, 0x00, 0x00, 0xF0, 0xCC, 0x00, 0x00];
        let png = encode(&raw, 2, 2, 4).unwrap();
        let (_, _, back) = decode_to_raw(&png, 4).unwrap();
        assert_eq!(back, vec![0xC3, 0xFF, 0xC0, 0xC0, 0xF0, 0xCC, 0xC0, 0xC0]);
    }
}
