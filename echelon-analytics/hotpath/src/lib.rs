//! Echelon Analytics — hot path helpers, compiled to `wasm32-unknown-unknown`.
//!
//! Two things every tracking request does are slow in JS: HMAC-SHA256 through
//! WebCrypto (an async round trip per call) and testing the user agent against
//! the crawler feed (one RegExp with ~1,500 alternatives, all of which are
//! tried when nothing matches). Both are done here instead.
//!
//! The caller is `lib/hotpath.ts`, which owns every decision about what is
//! safe to send: this module only ever sees printable-ASCII user agents and
//! patterns that mean the same thing to this engine as to a JS RegExp.
//!
//! The module is single-threaded and keeps one pattern set at a time.

use hmac::{Hmac, Mac};
use regex_automata::hybrid::dfa::{Cache, DFA};
use regex_automata::nfa::thompson;
use regex_automata::util::syntax;
use regex_automata::{Input, MatchKind};
use regex_syntax::ParserBuilder;
use sha2::Sha256;
use std::cell::RefCell;

/// One lazy DFA for all patterns, and the cache its states are built into.
struct UaSet {
    dfa: DFA,
    cache: Cache,
}

thread_local! {
    static UA_SET: RefCell<Option<UaSet>> = const { RefCell::new(None) };
}

/// Budget for the compiled NFA. The crawler feed needs well under a megabyte;
/// a feed that needs more than this is refused, and JS keeps it.
const NFA_SIZE_LIMIT: usize = 16 << 20;
/// Memory for DFA states, built as user agents are seen. When it fills, the
/// cache is cleared and rebuilt, so this bounds memory, not correctness.
const DFA_CACHE_BYTES: usize = 8 << 20;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `alloc(len)` with the same `len`, and not be used again.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// HMAC-SHA256 of `msg` under `key`; writes the 32-byte tag to `out`.
///
/// # Safety
/// The three regions must be valid for the given lengths (`out` for 32 bytes).
#[no_mangle]
pub unsafe extern "C" fn hmac_sha256(
    key: *const u8,
    key_len: usize,
    msg: *const u8,
    msg_len: usize,
    out: *mut u8,
) {
    let key = std::slice::from_raw_parts(key, key_len);
    let msg = std::slice::from_raw_parts(msg, msg_len);
    // HMAC takes a key of any length, so this cannot fail.
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(msg);
    let tag = mac.finalize().into_bytes();
    std::ptr::copy_nonoverlapping(tag.as_ptr(), out, 32);
}

/// Replace the pattern set with the newline-separated patterns in `text`.
///
/// Returns how many patterns this engine cannot parse, and writes their
/// indexes (up to `rejected_cap`) to `rejected`: the caller keeps those in JS.
/// Returns -1, and leaves no set installed, when the input is not UTF-8 or the
/// accepted patterns do not compile together within the size limit.
///
/// # Safety
/// `text` must be valid for `text_len` bytes and `rejected` for
/// `rejected_cap` u32s.
#[no_mangle]
pub unsafe extern "C" fn ua_set(
    text: *const u8,
    text_len: usize,
    rejected: *mut u32,
    rejected_cap: usize,
) -> i32 {
    UA_SET.with(|set| *set.borrow_mut() = None);
    let Ok(text) = std::str::from_utf8(std::slice::from_raw_parts(text, text_len)) else {
        return -1;
    };

    let mut accepted: Vec<&str> = Vec::new();
    let mut n_rejected = 0usize;
    if !text.is_empty() {
        let mut builder = ParserBuilder::new();
        builder.unicode(false).utf8(false).case_insensitive(true);
        for (i, pattern) in text.split('\n').enumerate() {
            // A parser per pattern: one that has failed cannot be reused.
            if builder.build().parse(pattern).is_ok() {
                accepted.push(pattern);
            } else {
                if n_rejected < rejected_cap {
                    // `rejected` is byte-aligned memory from `alloc`.
                    rejected.add(n_rejected).write_unaligned(i as u32);
                }
                n_rejected += 1;
            }
        }
    }
    if accepted.is_empty() {
        return n_rejected as i32;
    }

    let built = DFA::builder()
        .configure(
            DFA::config()
                .match_kind(MatchKind::All)
                .cache_capacity(DFA_CACHE_BYTES),
        )
        .syntax(
            syntax::Config::new()
                .unicode(false)
                .utf8(false)
                .case_insensitive(true),
        )
        .thompson(
            thompson::Config::new()
                .utf8(false)
                .nfa_size_limit(Some(NFA_SIZE_LIMIT)),
        )
        .build_many(&accepted);
    match built {
        Ok(dfa) => {
            let cache = dfa.create_cache();
            UA_SET.with(|set| *set.borrow_mut() = Some(UaSet { dfa, cache }));
            n_rejected as i32
        }
        Err(_) => -1,
    }
}

/// 1 when any pattern of the installed set matches `ua`, 0 when none does,
/// and 2 when the search could not be completed: the caller then asks JS.
///
/// # Safety
/// `ua` must be valid for `ua_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn ua_match(ua: *const u8, ua_len: usize) -> u32 {
    let ua = std::slice::from_raw_parts(ua, ua_len);
    UA_SET.with(|set| match set.borrow_mut().as_mut() {
        Some(UaSet { dfa, cache }) => {
            match dfa.try_search_fwd(cache, &Input::new(ua).earliest(true)) {
                Ok(found) => found.is_some() as u32,
                Err(_) => 2,
            }
        }
        None => 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(patterns: &str) -> (i32, Vec<u32>) {
        let mut rejected = vec![0u32; 16];
        let n = unsafe { ua_set(patterns.as_ptr(), patterns.len(), rejected.as_mut_ptr(), 16) };
        rejected.truncate(n.max(0) as usize);
        (n, rejected)
    }

    fn matches(ua: &str) -> bool {
        unsafe { ua_match(ua.as_ptr(), ua.len()) == 1 }
    }

    #[test]
    fn hmac_rfc4231_case_2() {
        let (key, msg) = (b"Jefe", b"what do ya want for nothing?");
        let mut out = [0u8; 32];
        unsafe {
            hmac_sha256(
                key.as_ptr(),
                key.len(),
                msg.as_ptr(),
                msg.len(),
                out.as_mut_ptr(),
            )
        };
        let hex: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn a_set_can_be_replaced() {
        assert_eq!(install("a"), (0, vec![]));
        assert!(matches("xAx"));
        assert_eq!(install("b\n[wW]get"), (0, vec![]));
        assert!(!matches("a"));
        assert!(matches("WGET/1"));
    }

    #[test]
    fn unparseable_patterns_are_reported_by_index() {
        assert_eq!(install("ok\ncurl(?!/8)\n(ab)\\1\nfine"), (2, vec![1, 2]));
        assert!(matches("FINE"));
        assert!(!matches("curl/7"));
    }

    #[test]
    fn no_patterns_match_nothing() {
        assert_eq!(install(""), (0, vec![]));
        assert!(!matches(""));
        assert!(!matches("anything"));
    }
}
