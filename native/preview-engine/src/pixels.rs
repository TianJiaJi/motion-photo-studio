//! Bounded preview-only NV12 to RGBA conversion, independent of driver RGB defaults.
use crate::AppResult;
#[derive(Clone, Copy)]
pub struct Aperture {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}
#[derive(Clone, Copy)]
pub struct Layout {
    pub coded_width: usize,
    pub coded_height: usize,
    pub stride: usize,
    pub aperture: Aperture,
    pub matrix709: bool,
    pub full_range: bool,
}
pub fn nv12_rgba(input: &[u8], layout: Layout, width: usize, height: usize) -> AppResult<Vec<u8>> {
    let Layout {
        coded_width: cw,
        coded_height: ch,
        stride,
        aperture: a,
        matrix709,
        full_range,
    } = layout;
    if cw == 0
        || ch == 0
        || cw > 8192
        || ch > 8192
        || !cw.is_multiple_of(2)
        || !ch.is_multiple_of(2)
        || stride < cw
        || stride > 65536
        || a.width == 0
        || a.height == 0
        || a.x.checked_add(a.width).is_none_or(|x| x > cw)
        || a.y.checked_add(a.height).is_none_or(|y| y > ch)
        || width == 0
        || height == 0
        || width > 1280
        || height > 1280
    {
        return Err("invalid NV12 geometry".into());
    }
    let uv_offset = stride.checked_mul(ch).ok_or("NV12 size overflow")?;
    let total = uv_offset
        .checked_add(stride * (ch / 2))
        .ok_or("NV12 size overflow")?;
    if input.len() < total {
        return Err("truncated NV12 planes".into());
    }
    let mut output = vec![0u8; width * height * 4];
    // Point sampling is intentionally preview-only. Final photos/video use the export pipeline.
    let (ym, y0, rv, gu, gv, bu) = match (matrix709, full_range) {
        (false, false) => (298, 16, 409, 100, 208, 516),
        (true, false) => (298, 16, 459, 55, 136, 541),
        (false, true) => (256, 0, 359, 88, 183, 454),
        (true, true) => (256, 0, 403, 48, 120, 475),
    };
    for y in 0..height {
        let sy = a.y + y * a.height / height;
        for x in 0..width {
            let sx = a.x + x * a.width / width;
            let luma = i32::from(input[sy * stride + sx]) - y0;
            let chroma = uv_offset + (sy / 2) * stride + (sx / 2) * 2;
            let u = i32::from(input[chroma]) - 128;
            let v = i32::from(input[chroma + 1]) - 128;
            let at = (y * width + x) * 4;
            output[at] = ((ym * luma + rv * v + 128) >> 8).clamp(0, 255) as u8;
            output[at + 1] = ((ym * luma - gu * u - gv * v + 128) >> 8).clamp(0, 255) as u8;
            output[at + 2] = ((ym * luma + bu * u + 128) >> 8).clamp(0, 255) as u8;
            output[at + 3] = 255;
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn layout() -> Layout {
        Layout {
            coded_width: 2,
            coded_height: 2,
            stride: 2,
            aperture: Aperture {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            },
            matrix709: false,
            full_range: false,
        }
    }
    #[test]
    fn limited_601_red_is_not_full_709_orange() {
        let Ok(rgba) = nv12_rgba(&[81, 81, 81, 81, 90, 240], layout(), 2, 2) else {
            panic!("conversion failed")
        };
        assert!(rgba[0] >= 253 && rgba[1] <= 1 && rgba[2] <= 1);
        assert_eq!(rgba[3], 255);
    }
    #[test]
    fn rejects_truncated_planes_and_invalid_aperture() {
        assert!(nv12_rgba(&[0; 5], layout(), 2, 2).is_err());
        let mut l = layout();
        l.aperture.width = 3;
        assert!(nv12_rgba(&[0; 6], l, 2, 2).is_err());
    }
}
