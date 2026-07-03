//! Shared PDF page-merge helpers for the desktop PDF export. Pure `lopdf` (no
//! platform APIs), used by both the macOS (WKWebView) and Windows (WebView2)
//! capture paths so the per-sheet → multi-page assembly lives in one place.
//!
//! - [`merge_scaled`] (macOS): each input is a single-page PDF captured at
//!   1 CSS px → 1 pt; it scales each page's content + MediaBox by `scale`
//!   (72/96) down to its true physical size.
//! - [`merge_concat`] (Windows): each input is a single-page PDF that WebView2
//!   already printed at its correct physical page size, so the content is kept
//!   as-is and only the MediaBox is (re)asserted from the known page dimensions
//!   (guards against a MediaBox inherited from the source's page tree being lost
//!   when the page is reparented).

// Each platform uses only one of the two merge fns (macOS: merge_scaled,
// Windows: merge_concat), so the other is dead code on that target build.
#![allow(dead_code)]

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

// Page attributes a page may INHERIT from an ancestor `/Pages` node instead of
// carrying directly (PDF 1.7 §7.7.3.4). Both merge fns reparent each captured
// page onto a fresh, attribute-less `/Pages` tree, which severs any such
// inheritance — losing `/Resources` blanks fonts/images/XObjects. `/MediaBox`
// is already re-asserted explicitly by each fn from the known dimensions, so
// it's covered separately; these are the rest worth carrying over.
const INHERITABLE_ATTRS: [&[u8]; 3] = [b"Resources", b"CropBox", b"Rotate"];

/// Resolve inheritable page attributes that live on an ancestor `/Pages` node
/// (not on the page itself) by walking the page's `/Parent` chain in `src`.
/// Returns `(key, value)` for each attribute NOT already on the page dict, so
/// the caller can materialize them onto the page before reparenting. Must run
/// while `src` is still intact — i.e. before its objects are moved into the
/// output. A cloned `/Resources` reference stays valid because the object it
/// points to is copied into the output alongside the page.
fn inherited_page_attrs(src: &Document, page_id: ObjectId) -> Vec<(&'static [u8], Object)> {
    let page = match src.get_object(page_id).and_then(Object::as_dict) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut resolved = Vec::new();
    for key in INHERITABLE_ATTRS {
        if page.get(key).is_ok() {
            continue; // already on the page — survives reparenting untouched
        }
        let mut next = page.get(b"Parent").and_then(Object::as_reference).ok();
        let mut hops = 0;
        while let Some(pid) = next {
            hops += 1;
            if hops > 32 {
                break; // malformed / cyclic page tree — stop rather than spin
            }
            let dict = match src.get_object(pid).and_then(Object::as_dict) {
                Ok(d) => d,
                Err(_) => break,
            };
            if let Ok(value) = dict.get(key) {
                resolved.push((key, value.clone()));
                break;
            }
            next = dict.get(b"Parent").and_then(Object::as_reference).ok();
        }
    }
    resolved
}

/// Scale a numeric PDF object (Integer/Real) by `scale`; pass anything else
/// through untouched.
fn scale_number(o: &Object, scale: f64) -> Object {
    match o {
        Object::Integer(n) => Object::Real((*n as f64 * scale) as f32),
        Object::Real(r) => Object::Real((*r as f64 * scale) as f32),
        other => other.clone(),
    }
}

/// Scale an annotation dict's page-space geometry (`/Rect`, `/QuadPoints`) by
/// `scale`. No-op for annotations without those keys.
fn scale_annotation_coords(dict: &mut Dictionary, scale: f64) {
    for key in [b"Rect".as_slice(), b"QuadPoints".as_slice()] {
        let scaled = match dict.get(key) {
            Ok(Object::Array(arr)) => Some(arr.iter().map(|o| scale_number(o, scale)).collect::<Vec<_>>()),
            _ => None,
        };
        if let Some(scaled) = scaled {
            dict.set(key.to_vec(), scaled);
        }
    }
}

// Optional page-space boxes that, like `/MediaBox`, are in default user space
// and must shrink with the content in the scaled (macOS) path. `/MediaBox` is
// excluded — each fn re-asserts it explicitly from the known dimensions.
const SCALABLE_PAGE_BOXES: [&[u8]; 4] = [b"CropBox", b"BleedBox", b"TrimBox", b"ArtBox"];

/// Scale a page's optional geometry boxes (`/CropBox` etc.) by `scale`, in place
/// on the page dict. Covers both a box carried directly on the page and one
/// materialized from an inherited attribute — either way it must track the
/// scaled `/MediaBox`, or the exported page shows the wrong visible region.
/// No-op for the boxes a page doesn't define. Only the scaled (macOS) path calls
/// this; `merge_concat` keeps physical size, so its boxes stay as captured.
fn scale_page_boxes(page: &mut Dictionary, scale: f64) {
    for key in SCALABLE_PAGE_BOXES {
        let scaled = match page.get(key) {
            Ok(Object::Array(arr)) => Some(arr.iter().map(|o| scale_number(o, scale)).collect::<Vec<_>>()),
            _ => None,
        };
        if let Some(scaled) = scaled {
            page.set(key.to_vec(), scaled);
        }
    }
}

/// Scale a page's annotations to match content scaled by `scale`. `merge_scaled`
/// shrinks the content stream + `/MediaBox` from the origin, but `/Annots` live
/// on the page dict in default user space — untouched, a link captured at CSS-px
/// coordinates would sit in the wrong place (or off-page) on the shrunk page.
/// Scaling their `/Rect`/`/QuadPoints` by the same factor keeps clickable areas
/// aligned. No-op when the page has no annotations.
fn scale_page_annotations(output: &mut Document, page_id: ObjectId, scale: f64) {
    let annots = match output.objects.get(&page_id).and_then(|o| o.as_dict().ok()) {
        Some(d) => match d.get(b"Annots") {
            Ok(Object::Array(a)) => a.clone(),
            _ => return,
        },
        None => return,
    };
    // Indirect annotations: scale them in the object store.
    for id in annots.iter().filter_map(|o| o.as_reference().ok()) {
        if let Some(dict) = output.objects.get_mut(&id).and_then(|o| o.as_dict_mut().ok()) {
            scale_annotation_coords(dict, scale);
        }
    }
    // Inline-dict annotations: scale copies and rewrite the page's /Annots.
    if annots.iter().any(|o| matches!(o, Object::Dictionary(_))) {
        let rebuilt: Vec<Object> = annots
            .into_iter()
            .map(|o| match o {
                Object::Dictionary(mut d) => {
                    scale_annotation_coords(&mut d, scale);
                    Object::Dictionary(d)
                }
                other => other,
            })
            .collect();
        if let Some(dict) = output.objects.get_mut(&page_id).and_then(|o| o.as_dict_mut().ok()) {
            dict.set("Annots", rebuilt);
        }
    }
}

/// Merge single-page PDFs into one document, scaling each page's content and
/// MediaBox by `scale`. `pages` is `(pdf_bytes, width_px, height_px)`; the
/// width/height are the captured CSS-px dimensions (== createPDF's point size,
/// since the map is 1:1), so the output page is `dim * scale` points.
pub fn merge_scaled(pages: Vec<(Vec<u8>, f64, f64)>, scale: f64) -> Result<Vec<u8>, String> {
    let mut output = Document::with_version("1.5");
    let pages_id = output.new_object_id();
    let mut kid_ids: Vec<ObjectId> = Vec::with_capacity(pages.len());

    for (bytes, w_px, h_px) in pages {
        let mut src = Document::load_mem(&bytes).map_err(|e| format!("load capture: {}", e))?;

        // Renumber the source's objects starting above everything already in
        // `output` so the two object-id spaces can't collide when merged.
        src.renumber_objects_with(output.max_id + 1);

        let page_id = src
            .get_pages()
            .into_values()
            .next()
            .ok_or_else(|| "captured PDF has no page".to_string())?;

        // The content stream object(s) this page references (a single Reference
        // or an Array of References — Quartz emits indirect streams either way).
        let content_ids: Vec<ObjectId> = {
            let dict = src
                .get_object(page_id)
                .and_then(Object::as_dict)
                .map_err(|e| format!("read page: {}", e))?;
            match dict.get(b"Contents") {
                Ok(Object::Reference(id)) => vec![*id],
                Ok(Object::Array(items)) => {
                    items.iter().filter_map(|o| o.as_reference().ok()).collect()
                }
                _ => Vec::new(),
            }
        };

        // Resolve inherited page attributes BEFORE the objects move (needs the
        // intact source page tree) so `/Resources` etc. can be pinned onto the
        // page once it's reparented below.
        let inherited = inherited_page_attrs(&src, page_id);

        // Move every source object into the output document (keeps the page's
        // own Resources/fonts intact; the orphaned source catalog is harmless).
        let src_max = src.max_id;
        for (id, obj) in std::mem::take(&mut src.objects) {
            output.objects.insert(id, obj);
        }
        if src_max > output.max_id {
            output.max_id = src_max;
        }

        // Scale-wrap: `q s 0 0 s 0 0 cm ... Q`. PDF user space is bottom-left
        // origin, and createPDF anchors content at the origin, so scaling from
        // the origin shrinks the page content to exactly fill the new MediaBox.
        // Trailing/leading newlines delimit these wrapper streams from the page's
        // own Contents when concatenated in the array below: PDF readers join
        // content-array streams at the token level, so without a delimiter the `cm`
        // and `Q` operators can merge with adjacent tokens (e.g. `cmq`), rendering a
        // malformed/blank page in stricter readers.
        let pre = output.add_object(Stream::new(
            Dictionary::new(),
            format!("q {} 0 0 {} 0 0 cm\n", scale, scale).into_bytes(),
        ));
        let post = output.add_object(Stream::new(Dictionary::new(), b"\nQ".to_vec()));

        let new_w = (w_px * scale) as f32;
        let new_h = (h_px * scale) as f32;

        let page = output
            .objects
            .get_mut(&page_id)
            .ok_or_else(|| "page missing after merge".to_string())?
            .as_dict_mut()
            .map_err(|e| format!("page dict: {}", e))?;
        // Pin inherited attributes onto the page before it loses its old parent.
        for (key, value) in inherited {
            page.set(key, value);
        }
        // Scale the page's geometry boxes (direct or just-materialized) into the
        // shrunk coordinate space, matching the /MediaBox re-asserted below.
        scale_page_boxes(page, scale);
        page.set("Parent", pages_id);
        page.set(
            "MediaBox",
            vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(new_w),
                Object::Real(new_h),
            ],
        );
        let mut contents: Vec<Object> = Vec::with_capacity(content_ids.len() + 2);
        contents.push(Object::Reference(pre));
        contents.extend(content_ids.into_iter().map(Object::Reference));
        contents.push(Object::Reference(post));
        page.set("Contents", contents);

        // Content + MediaBox were scaled from the origin; bring the page's
        // annotations (link rects etc.) along so they don't drift off-target.
        scale_page_annotations(&mut output, page_id, scale);

        kid_ids.push(page_id);
    }

    finish(output, pages_id, kid_ids)
}

/// Concatenate single-page PDFs into one document WITHOUT scaling the content —
/// each input page is already at its correct physical size (WebView2 prints to
/// the page size we pass it). `pages` is `(pdf_bytes, width_pt, height_pt)`; the
/// MediaBox is re-asserted from those points so a page that inherited its
/// MediaBox from the source page tree doesn't lose it on reparenting.
pub fn merge_concat(pages: Vec<(Vec<u8>, f64, f64)>) -> Result<Vec<u8>, String> {
    let mut output = Document::with_version("1.5");
    let pages_id = output.new_object_id();
    let mut kid_ids: Vec<ObjectId> = Vec::with_capacity(pages.len());

    for (bytes, w_pt, h_pt) in pages {
        let mut src = Document::load_mem(&bytes).map_err(|e| format!("load capture: {}", e))?;
        src.renumber_objects_with(output.max_id + 1);

        let page_id = src
            .get_pages()
            .into_values()
            .next()
            .ok_or_else(|| "captured PDF has no page".to_string())?;

        // Resolve inherited page attributes BEFORE moving the objects (needs the
        // intact source page tree). WebView2 can leave `/Resources` on the page
        // tree rather than the page; without this, reparenting below would drop
        // it and the merged page would render blank.
        let inherited = inherited_page_attrs(&src, page_id);

        let src_max = src.max_id;
        for (id, obj) in std::mem::take(&mut src.objects) {
            output.objects.insert(id, obj);
        }
        if src_max > output.max_id {
            output.max_id = src_max;
        }

        let page = output
            .objects
            .get_mut(&page_id)
            .ok_or_else(|| "page missing after merge".to_string())?
            .as_dict_mut()
            .map_err(|e| format!("page dict: {}", e))?;
        // Pin inherited attributes onto the page before it loses its old parent.
        for (key, value) in inherited {
            page.set(key, value);
        }
        page.set("Parent", pages_id);
        page.set(
            "MediaBox",
            vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(w_pt as f32),
                Object::Real(h_pt as f32),
            ],
        );
        // Content streams are left exactly as WebView2 produced them; `/Resources`
        // is now guaranteed on the page (materialized above if it was inherited).
        kid_ids.push(page_id);
    }

    finish(output, pages_id, kid_ids)
}

/// Build the shared Pages tree + Catalog + trailer root and serialize.
fn finish(mut output: Document, pages_id: ObjectId, kid_ids: Vec<ObjectId>) -> Result<Vec<u8>, String> {
    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Count", kid_ids.len() as i64);
    pages_dict.set(
        "Kids",
        kid_ids
            .iter()
            .map(|id| Object::Reference(*id))
            .collect::<Vec<_>>(),
    );
    output.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", pages_id);
    let catalog_id = output.add_object(Object::Dictionary(catalog));
    output.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    output.save_to(&mut buf).map_err(|e| format!("save: {}", e))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A one-page PDF whose `/Resources` lives on the `/Pages` node (inherited),
    // NOT on the page — the exact shape a print engine can emit and the shape
    // the merge must preserve across reparenting.
    fn pdf_with_inherited_resources() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let content_id = doc.add_object(Stream::new(Dictionary::new(), b"BT ET".to_vec()));

        let font_id = doc.add_object(Object::Dictionary({
            let mut f = Dictionary::new();
            f.set("Type", Object::Name(b"Font".to_vec()));
            f.set("Subtype", Object::Name(b"Type1".to_vec()));
            f.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
            f
        }));
        let mut fonts = Dictionary::new();
        fonts.set("F1", font_id);
        let mut resources = Dictionary::new();
        resources.set("Font", fonts);

        let pages_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", pages_id);
        page.set("Contents", content_id);
        // Deliberately NO /Resources and NO /MediaBox on the page — both inherited.
        let page_id = doc.add_object(Object::Dictionary(page));

        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Kids", vec![Object::Reference(page_id)]);
        pages.set("Count", 1i64);
        pages.set("Resources", resources); // <-- inherited by the page
        pages.set(
            "MediaBox",
            vec![Object::Real(0.0), Object::Real(0.0), Object::Real(200.0), Object::Real(300.0)],
        );
        pages.set(
            "CropBox",
            vec![Object::Real(0.0), Object::Real(0.0), Object::Real(200.0), Object::Real(300.0)],
        );
        doc.objects.insert(pages_id, Object::Dictionary(pages));

        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", pages_id);
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", catalog_id);

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    // Fetch the merged output's single page dict.
    fn merged_page(bytes: &[u8]) -> (Document, ObjectId) {
        let doc = Document::load_mem(bytes).unwrap();
        let page_id = doc.get_pages().into_values().next().unwrap();
        (doc, page_id)
    }

    // The materialized /Resources (possibly indirect) must still reach the font.
    fn assert_resources_reach_font(doc: &Document, page: &Dictionary) {
        let res = page
            .get(b"Resources")
            .expect("page must carry /Resources after merge");
        let res_dict = match res {
            Object::Reference(id) => doc.get_object(*id).unwrap().as_dict().unwrap(),
            Object::Dictionary(d) => d,
            other => panic!("/Resources is not a dict: {:?}", other),
        };
        assert!(res_dict.get(b"Font").is_ok(), "materialized /Resources lost /Font");
    }

    #[test]
    fn merge_concat_materializes_inherited_resources() {
        let merged = merge_concat(vec![(pdf_with_inherited_resources(), 200.0, 300.0)]).unwrap();
        let (doc, page_id) = merged_page(&merged);
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        assert_resources_reach_font(&doc, page);
    }

    #[test]
    fn merge_scaled_materializes_inherited_resources() {
        let merged = merge_scaled(vec![(pdf_with_inherited_resources(), 200.0, 300.0)], 0.75).unwrap();
        let (doc, page_id) = merged_page(&merged);
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        assert_resources_reach_font(&doc, page);
    }

    // One-page PDF carrying a Link annotation at a known rect.
    fn pdf_with_link_annotation() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let content_id = doc.add_object(Stream::new(Dictionary::new(), b"BT ET".to_vec()));
        let mut annot = Dictionary::new();
        annot.set("Type", Object::Name(b"Annot".to_vec()));
        annot.set("Subtype", Object::Name(b"Link".to_vec()));
        annot.set(
            "Rect",
            vec![Object::Real(10.0), Object::Real(20.0), Object::Real(110.0), Object::Real(40.0)],
        );
        let annot_id = doc.add_object(Object::Dictionary(annot));

        let pages_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", pages_id);
        page.set("Resources", Dictionary::new());
        page.set("Contents", content_id);
        page.set("Annots", vec![Object::Reference(annot_id)]);
        let page_id = doc.add_object(Object::Dictionary(page));

        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Kids", vec![Object::Reference(page_id)]);
        pages.set("Count", 1i64);
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", pages_id);
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    fn first_annot_rect(bytes: &[u8]) -> Vec<f32> {
        let (doc, page_id) = merged_page(bytes);
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        let annots = page.get(b"Annots").unwrap().as_array().unwrap();
        let annot = doc.get_object(annots[0].as_reference().unwrap()).unwrap().as_dict().unwrap();
        annot
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|o| match o {
                Object::Real(r) => *r,
                Object::Integer(n) => *n as f32,
                _ => panic!("rect coord not numeric"),
            })
            .collect()
    }

    fn page_box(bytes: &[u8], key: &[u8]) -> Vec<f32> {
        let (doc, page_id) = merged_page(bytes);
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        page.get(key)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|o| match o {
                Object::Real(r) => *r,
                Object::Integer(n) => *n as f32,
                _ => panic!("box coord not numeric"),
            })
            .collect()
    }

    #[test]
    fn merge_scaled_scales_inherited_cropbox() {
        // Inherited /CropBox [0,0,200,300] must shrink with the page (× 0.5).
        let merged = merge_scaled(vec![(pdf_with_inherited_resources(), 200.0, 300.0)], 0.5).unwrap();
        assert_eq!(page_box(&merged, b"CropBox"), vec![0.0, 0.0, 100.0, 150.0]);
    }

    #[test]
    fn merge_concat_keeps_inherited_cropbox_unscaled() {
        // Windows path is physical size — the materialized /CropBox stays as-is.
        let merged = merge_concat(vec![(pdf_with_inherited_resources(), 200.0, 300.0)]).unwrap();
        assert_eq!(page_box(&merged, b"CropBox"), vec![0.0, 0.0, 200.0, 300.0]);
    }

    #[test]
    fn merge_scaled_scales_annotation_rects() {
        let merged = merge_scaled(vec![(pdf_with_link_annotation(), 200.0, 300.0)], 0.5).unwrap();
        // [10,20,110,40] * 0.5
        assert_eq!(first_annot_rect(&merged), vec![5.0, 10.0, 55.0, 20.0]);
    }

    #[test]
    fn merge_concat_leaves_annotation_rects_unscaled() {
        // Windows path prints at physical size — annotations must NOT be scaled.
        let merged = merge_concat(vec![(pdf_with_link_annotation(), 200.0, 300.0)]).unwrap();
        assert_eq!(first_annot_rect(&merged), vec![10.0, 20.0, 110.0, 40.0]);
    }

    #[test]
    fn direct_resources_are_left_untouched() {
        // A page that already carries /Resources directly must merge unchanged
        // (the fix only fills gaps, never clobbers).
        let mut doc = Document::with_version("1.5");
        let content_id = doc.add_object(Stream::new(Dictionary::new(), b"BT ET".to_vec()));
        let mut res = Dictionary::new();
        res.set("ProcSet", vec![Object::Name(b"PDF".to_vec())]);
        let pages_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", pages_id);
        page.set("Contents", content_id);
        page.set("Resources", res);
        let page_id = doc.add_object(Object::Dictionary(page));
        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Kids", vec![Object::Reference(page_id)]);
        pages.set("Count", 1i64);
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", pages_id);
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        let merged = merge_concat(vec![(buf, 200.0, 300.0)]).unwrap();
        let (doc, page_id) = merged_page(&merged);
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        let res = page.get(b"Resources").unwrap().as_dict().unwrap();
        assert!(res.get(b"ProcSet").is_ok(), "direct /Resources must be preserved");
    }
}
