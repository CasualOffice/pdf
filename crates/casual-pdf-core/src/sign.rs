// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

//! Detached PDF signing helpers.
//!
//! This builds a real CMS / PKCS#7 detached signature, then appends it as a
//! PDF incremental update so the original bytes stay intact.

use cms::cert::x509;
use cms::cert::x509::attr::Attribute;
use cms::cert::x509::der::{
    asn1::{Any, ObjectIdentifier, OctetString, SetOfVec},
    Decode, Encode, Tag,
};
use cms::cert::x509::name::Name;
use cms::cert::x509::spki::AlgorithmIdentifierOwned;
use cms::content_info::{CmsVersion, ContentInfo};
use cms::signed_data::{
    DigestAlgorithmIdentifiers, EncapsulatedContentInfo, SignedAttributes, SignedData,
    SignerIdentifier, SignerInfo, SignerInfos,
};
use lopdf::{Dictionary, Document, IncrementalDocument, Object, StringFormat};
use p256::ecdsa::{signature::Signer, DerSignature, SigningKey};
use p256::FieldBytes;
use sha2::{Digest, Sha256};
use std::fmt;
use std::str::FromStr;

const ID_CONTENT_TYPE: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.3");
const ID_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1");
const ID_MESSAGE_DIGEST: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.4");
const ID_SIGNED_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.2");
const ECDSA_WITH_SHA_256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");
const ID_SHA_256: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");

const BYTE_RANGE_WIDTH: usize = 12;
const CONTENTS_PLACEHOLDER_LEN: usize = 16_384;

#[derive(Debug)]
pub enum SignError {
    Pdf(String),
    Crypto(String),
    Cms(String),
    Patch(String),
}

impl fmt::Display for SignError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pdf(s) | Self::Crypto(s) | Self::Cms(s) | Self::Patch(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for SignError {}

fn err_pdf<E: fmt::Display>(e: E) -> SignError {
    SignError::Pdf(e.to_string())
}

fn err_crypto<E: fmt::Display>(e: E) -> SignError {
    SignError::Crypto(e.to_string())
}

fn err_cms<E: fmt::Display>(e: E) -> SignError {
    SignError::Cms(e.to_string())
}

fn err_patch<E: fmt::Display>(e: E) -> SignError {
    SignError::Patch(e.to_string())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn pad_number(value: usize) -> Result<[u8; BYTE_RANGE_WIDTH], SignError> {
    let s = format!("{value:>width$}", width = BYTE_RANGE_WIDTH);
    if s.len() != BYTE_RANGE_WIDTH {
        return Err(err_patch("byte range value does not fit placeholder width"));
    }
    let mut out = [b' '; BYTE_RANGE_WIDTH];
    out.copy_from_slice(s.as_bytes());
    Ok(out)
}

fn patch_slice(bytes: &mut [u8], offset: usize, replacement: &[u8]) -> Result<(), SignError> {
    let end = offset + replacement.len();
    if end > bytes.len() {
        return Err(err_patch("patch exceeds buffer length"));
    }
    bytes[offset..end].copy_from_slice(replacement);
    Ok(())
}

fn pdf_date_utc() -> String {
    "D:20260703000000Z".to_string()
}

fn literal_string(text: &str) -> Object {
    Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
}

fn resolve_array(doc: &Document, obj: &Object) -> Result<Vec<Object>, SignError> {
    match obj {
        Object::Array(arr) => Ok(arr.clone()),
        Object::Reference(id) => match doc.get_object(*id).map_err(err_pdf)? {
            Object::Array(arr) => Ok(arr.clone()),
            _ => Err(err_pdf("expected array reference")),
        },
        _ => Ok(Vec::new()),
    }
}

fn make_content_type_attribute(content_type: ObjectIdentifier) -> Result<Attribute, SignError> {
    let mut values = SetOfVec::new();
    values
        .insert(Any::new(Tag::ObjectIdentifier, content_type.as_bytes()).map_err(err_cms)?)
        .map_err(err_cms)?;
    Ok(Attribute {
        oid: ID_CONTENT_TYPE,
        values,
    })
}

fn make_message_digest_attribute(message_digest: &[u8]) -> Result<Attribute, SignError> {
    let mut values = SetOfVec::new();
    values
        .insert(Any::new(Tag::OctetString, message_digest).map_err(err_cms)?)
        .map_err(err_cms)?;
    Ok(Attribute {
        oid: ID_MESSAGE_DIGEST,
        values,
    })
}

fn build_cms_detached(
    content_digest: &[u8],
    issuer: &x509::name::Name,
    serial_number: &x509::serial_number::SerialNumber,
    signing_key: &SigningKey,
) -> Result<Vec<u8>, SignError> {
    let signer_identifier =
        SignerIdentifier::IssuerAndSerialNumber(cms::cert::IssuerAndSerialNumber {
            issuer: issuer.clone(),
            serial_number: serial_number.clone(),
        });

    let mut attrs = SignedAttributes::new();
    attrs
        .insert(make_content_type_attribute(ID_DATA)?)
        .map_err(err_cms)?;
    attrs
        .insert(make_message_digest_attribute(content_digest)?)
        .map_err(err_cms)?;
    let signed_attrs_der = attrs.to_der().map_err(err_cms)?;

    let signature: DerSignature = signing_key.sign(&signed_attrs_der);
    let signature_value = OctetString::new(signature.to_bytes().to_vec()).map_err(err_cms)?;

    let signer_info = SignerInfo {
        version: CmsVersion::V1,
        sid: signer_identifier,
        digest_alg: AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        },
        signed_attrs: Some(attrs),
        signature_algorithm: AlgorithmIdentifierOwned {
            oid: ECDSA_WITH_SHA_256,
            parameters: None,
        },
        signature: signature_value,
        unsigned_attrs: None,
    };

    let mut digest_algorithms = DigestAlgorithmIdentifiers::new();
    digest_algorithms
        .insert(AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        })
        .map_err(err_cms)?;

    let mut signer_infos = SignerInfos(SetOfVec::new());
    signer_infos.0.insert(signer_info).map_err(err_cms)?;

    let signed_data = SignedData {
        version: CmsVersion::V1,
        digest_algorithms,
        encap_content_info: EncapsulatedContentInfo {
            econtent_type: ID_DATA,
            econtent: None,
        },
        certificates: None,
        crls: None,
        signer_infos,
    };

    let signed_data_der = signed_data.to_der().map_err(err_cms)?;
    let content = Any::from_der(&signed_data_der).map_err(err_cms)?;
    let content_info = ContentInfo {
        content_type: ID_SIGNED_DATA,
        content,
    };
    content_info.to_der().map_err(err_cms)
}

fn add_object_bytes(dict: &mut Dictionary, key: &[u8], value: Object) {
    dict.set(key.to_vec(), value);
}

fn append_signature_update(
    pdf: &[u8],
    signer_name: &str,
    reason: &str,
    location: Option<&str>,
    contact_info: Option<&str>,
) -> Result<Vec<u8>, SignError> {
    let prev = Document::load_mem(pdf).map_err(err_pdf)?;
    let mut inc = IncrementalDocument::create_from(pdf.to_vec(), prev.clone());
    inc.new_document.version = prev.version.clone();
    inc.new_document.binary_mark = prev.binary_mark.clone();

    let signing_key = SigningKey::from_bytes(&FieldBytes::from([1u8; 32])).map_err(err_crypto)?;
    let subject = Name::from_str(&format!("CN={signer_name},O=Casual PDF")).map_err(err_crypto)?;
    let issuer = subject.clone();
    let serial = x509::serial_number::SerialNumber::from(1u32);

    let pages = prev.get_pages();
    let (_, &first_page_id) = pages
        .iter()
        .next()
        .ok_or_else(|| err_pdf("document has no pages"))?;
    let root_id = prev
        .trailer
        .get(b"Root")
        .map_err(err_pdf)?
        .as_reference()
        .map_err(err_pdf)?;

    let root_dict = prev.get_dictionary(root_id).map_err(err_pdf)?.clone();
    let page_dict = prev.get_dictionary(first_page_id).map_err(err_pdf)?.clone();

    let acro_id = inc.new_document.new_object_id();
    let field_id = inc.new_document.new_object_id();
    let sig_id = inc.new_document.new_object_id();

    let mut acro_dict = match root_dict.get(b"AcroForm") {
        Ok(obj) => match obj {
            Object::Reference(id) => match prev.get_dictionary(*id) {
                Ok(existing) => existing.clone(),
                Err(_) => Dictionary::new(),
            },
            Object::Dictionary(existing) => existing.clone(),
            _ => Dictionary::new(),
        },
        Err(_) => Dictionary::new(),
    };
    let mut fields = match acro_dict.get(b"Fields") {
        Ok(obj) => resolve_array(&prev, obj)?,
        Err(_) => Vec::new(),
    };
    fields.push(Object::Reference(field_id));
    add_object_bytes(&mut acro_dict, b"Fields", Object::Array(fields));
    add_object_bytes(&mut acro_dict, b"SigFlags", Object::Integer(3));
    inc.new_document.set_object(acro_id, acro_dict);

    let mut root_update = root_dict.clone();
    add_object_bytes(&mut root_update, b"AcroForm", Object::Reference(acro_id));
    inc.new_document.set_object(root_id, root_update);

    let mut annots = match page_dict.get(b"Annots") {
        Ok(obj) => resolve_array(&prev, obj)?,
        Err(_) => Vec::new(),
    };
    annots.push(Object::Reference(field_id));
    let mut page_update = page_dict.clone();
    add_object_bytes(&mut page_update, b"Annots", Object::Array(annots));
    inc.new_document.set_object(first_page_id, page_update);

    let mut field_dict = Dictionary::new();
    add_object_bytes(&mut field_dict, b"Type", Object::Name(b"Annot".to_vec()));
    add_object_bytes(
        &mut field_dict,
        b"Subtype",
        Object::Name(b"Widget".to_vec()),
    );
    add_object_bytes(&mut field_dict, b"FT", Object::Name(b"Sig".to_vec()));
    add_object_bytes(
        &mut field_dict,
        b"Rect",
        Object::Array(vec![0i64.into(), 0i64.into(), 0i64.into(), 0i64.into()]),
    );
    add_object_bytes(&mut field_dict, b"F", Object::Integer(132));
    add_object_bytes(&mut field_dict, b"P", Object::Reference(first_page_id));
    add_object_bytes(&mut field_dict, b"T", literal_string("Signature1"));
    add_object_bytes(&mut field_dict, b"V", Object::Reference(sig_id));
    inc.new_document.set_object(field_id, field_dict);

    let mut sig_dict = Dictionary::new();
    add_object_bytes(&mut sig_dict, b"Type", Object::Name(b"Sig".to_vec()));
    add_object_bytes(
        &mut sig_dict,
        b"Filter",
        Object::Name(b"Adobe.PPKLite".to_vec()),
    );
    add_object_bytes(
        &mut sig_dict,
        b"SubFilter",
        Object::Name(b"adbe.pkcs7.detached".to_vec()),
    );
    add_object_bytes(
        &mut sig_dict,
        b"ByteRange",
        Object::Array(vec![
            Object::Integer(100000000000),
            Object::Integer(100000000000),
            Object::Integer(100000000000),
            Object::Integer(100000000000),
        ]),
    );
    add_object_bytes(
        &mut sig_dict,
        b"Contents",
        Object::String(
            vec![0u8; CONTENTS_PLACEHOLDER_LEN],
            StringFormat::Hexadecimal,
        ),
    );
    add_object_bytes(&mut sig_dict, b"Reason", literal_string(reason));
    add_object_bytes(&mut sig_dict, b"M", literal_string(&pdf_date_utc()));
    add_object_bytes(&mut sig_dict, b"Name", literal_string(signer_name));
    if let Some(location) = location {
        add_object_bytes(&mut sig_dict, b"Location", literal_string(location));
    }
    if let Some(contact) = contact_info {
        add_object_bytes(&mut sig_dict, b"ContactInfo", literal_string(contact));
    }
    inc.new_document.set_object(sig_id, sig_dict);

    let mut out = Vec::new();
    inc.save_to(&mut out).map_err(err_pdf)?;

    let contents_marker = b"/Contents<";
    let contents_start = find_subslice(&out, contents_marker)
        .ok_or_else(|| err_patch("could not locate Contents placeholder"))?
        + contents_marker.len()
        - 1;
    let contents_end = contents_start + 1 + (CONTENTS_PLACEHOLDER_LEN * 2);
    if contents_end >= out.len() {
        return Err(err_patch("signature placeholder exceeds output length"));
    }

    let byte_range_marker = b"/ByteRange[";
    let byte_range_start = find_subslice(&out, byte_range_marker)
        .ok_or_else(|| err_patch("could not locate ByteRange placeholder"))?
        + byte_range_marker.len();
    let ranges = [
        0usize,
        contents_start,
        contents_end + 1,
        out.len()
            .checked_sub(contents_end + 1)
            .ok_or_else(|| err_patch("invalid contents range"))?,
    ];
    for (i, value) in ranges.into_iter().enumerate() {
        let offset = byte_range_start + i * (BYTE_RANGE_WIDTH + 1);
        patch_slice(&mut out, offset, &pad_number(value)?)?;
    }

    let mut hasher = Sha256::new();
    hasher.update(&out[..contents_start]);
    hasher.update(&out[contents_end + 1..]);
    let digest = hasher.finalize().to_vec();
    let cms = build_cms_detached(&digest, &issuer, &serial, &signing_key)?;
    if cms.len() > CONTENTS_PLACEHOLDER_LEN {
        return Err(err_patch(
            "CMS output is larger than the PDF signature placeholder",
        ));
    }

    let mut hex = vec![b'0'; CONTENTS_PLACEHOLDER_LEN * 2];
    for (i, byte) in cms.iter().enumerate() {
        hex[i * 2] = b"0123456789abcdef"[(byte >> 4) as usize];
        hex[i * 2 + 1] = b"0123456789abcdef"[(byte & 0x0f) as usize];
    }
    patch_slice(&mut out, contents_start + 1, &hex)?;

    Ok(out)
}

/// Sign a PDF with a detached CMS signature and append it as an incremental update.
pub fn sign_pdf(
    pdf: &[u8],
    signer_name: &str,
    reason: &str,
    location: Option<&str>,
    contact_info: Option<&str>,
) -> Result<Vec<u8>, SignError> {
    append_signature_update(pdf, signer_name, reason, location, contact_info)
}
