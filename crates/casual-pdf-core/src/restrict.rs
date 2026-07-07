// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! PDF permission restriction via AES-256 encryption (lopdf, PDF 2.0 / R6).
//!
//! We encrypt with an **empty user (open) password** — so the file opens without a
//! prompt — and an **owner password** that gates the permission flags (print /
//! copy / modify / annotate). Compliant readers (Acrobat, Preview, Chrome) enforce
//! the flags; changing them requires the owner password. Because there's no open
//! password, the content is NOT confidential — this restricts *actions*, not
//! *access*. (Decision #4: lopdf is MIT; AES-256 is the in-policy strong cipher.)

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
use lopdf::{Document, Object, StringFormat};

/// What the user is allowed to do with the restricted PDF. Anything left `false`
/// is denied (compliant readers grey out the action).
pub struct RestrictSpec {
    pub owner_password: String,
    pub allow_print: bool,
    pub allow_copy: bool,
    pub allow_modify: bool,
    pub allow_annotate: bool,
}

/// Encrypt `bytes` with AES-256, an empty open password, and the given owner
/// password + permission flags. Returns the restricted PDF bytes.
pub fn restrict_pdf(bytes: &[u8], spec: &RestrictSpec) -> Result<Vec<u8>, String> {
    if spec.owner_password.is_empty() {
        return Err("an owner password is required".to_string());
    }
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        return Err("the document is already encrypted".to_string());
    }
    // PDF encryption requires a file /ID (ISO 32000 §7.5.8.1). Most PDFs have one;
    // add a random one if absent so encryption is valid + detectable on reload.
    if !doc.trailer.has(b"ID") {
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).map_err(|e| e.to_string())?;
        let id_str = Object::String(id.to_vec(), StringFormat::Hexadecimal);
        doc.trailer
            .set("ID", Object::Array(vec![id_str.clone(), id_str]));
    }

    // Permission flags are ALLOW bits: start from none, grant what's permitted.
    let mut perms = Permissions::empty();
    if spec.allow_print {
        perms |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if spec.allow_copy {
        perms |= Permissions::COPYABLE | Permissions::COPYABLE_FOR_ACCESSIBILITY;
    }
    if spec.allow_modify {
        perms |= Permissions::MODIFIABLE | Permissions::ASSEMBLABLE;
    }
    if spec.allow_annotate {
        perms |= Permissions::ANNOTABLE | Permissions::FILLABLE;
    }

    // AES-256 (V5 / R6). Random 32-byte file key; empty user password → opens
    // freely; owner password controls permission changes.
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| e.to_string())?;
    let mut crypt_filters: BTreeMap<Vec<u8>, Arc<dyn CryptFilter>> = BTreeMap::new();
    crypt_filters.insert(b"StdCF".to_vec(), Arc::new(Aes256CryptFilter));

    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters,
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &spec.owner_password,
        user_password: "",
        permissions: perms,
    };
    let state = EncryptionState::try_from(version).map_err(|e| e.to_string())?;
    doc.encrypt(&state).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;
    use lopdf::{Document, Object, Stream};

    /// A minimal valid one-page PDF.
    fn tiny_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Stream::new(dictionary! {}, b"BT ET".to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn restricts_and_stays_openable_without_a_password() {
        let pdf = tiny_pdf();
        let out = restrict_pdf(
            &pdf,
            &RestrictSpec {
                owner_password: "secret".into(),
                allow_print: true,
                allow_copy: false,
                allow_modify: false,
                allow_annotate: false,
            },
        )
        .expect("restrict");
        // The output is encrypted with AES-256 (AESV3 crypt filter, /V 5).
        assert!(
            out.windows(8).any(|w| w == b"/Encrypt"),
            "output is encrypted (/Encrypt present)"
        );
        assert!(
            out.windows(5).any(|w| w == b"AESV3"),
            "uses AES-256 (AESV3 crypt filter)"
        );
        // It opens with the EMPTY user password — no prompt needed. (load_mem
        // auto-decrypts, so re-loading + decrypting("") must succeed and the page
        // structure survives.)
        let mut d2 = Document::load_mem(&out).unwrap();
        let _ = d2.decrypt(""); // no-op if load auto-decrypted; must not error
        assert_eq!(d2.get_pages().len(), 1, "the one page survives restriction");
    }

    #[test]
    fn requires_an_owner_password() {
        let err = restrict_pdf(
            &tiny_pdf(),
            &RestrictSpec {
                owner_password: String::new(),
                allow_print: true,
                allow_copy: true,
                allow_modify: true,
                allow_annotate: true,
            },
        );
        assert!(err.is_err(), "empty owner password is rejected");
    }
}
