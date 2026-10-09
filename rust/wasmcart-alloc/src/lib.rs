//! `wc_alloc` / `wc_free` for Rust wasmcart carts.
//!
//! Some host calls hand a cart bytes at an address the host has to pick:
//! GL's `glGetString` and `glMapBufferRange`, the WebGPU glue, text input and
//! network messages. The host owns none of the cart's memory, so it asks the
//! cart to allocate through two optional exports (wasmcart SPEC.md, "Cart
//! memory the host writes"):
//!
//! ```text
//! wc_alloc(size: u32, align: u32) -> ptr   (0 on failure)
//! wc_free(ptr: u32)
//! ```
//!
//! Depending on this crate exports both, over Rust's global allocator. Name
//! it once so the linker keeps it:
//!
//! ```ignore
//! use wasmcart_alloc as _;
//! ```
//!
//! Blocks carry a small header (their size and alignment) in front of the
//! pointer, because Rust's `dealloc` needs the layout and `wc_free` gets only
//! the pointer. Memory from here must be released with `wc_free`, never C's
//! `free()`: a cart that also links emdawnwebgpu's C++ (which frees some host
//! blocks with `free()`) should use wasmcart.h's C pair instead.

#![no_std]
extern crate alloc;

use alloc::alloc::{alloc, dealloc, Layout};
use core::ptr::null_mut;

/// Allocate `size` bytes aligned to `align` (a power of two) for the host.
/// Returns null on failure or a bad alignment.
#[no_mangle]
pub unsafe extern "C" fn wc_alloc(size: usize, align: usize) -> *mut u8 {
    if !align.is_power_of_two() {
        return null_mut();
    }
    // The header (size, align as two u32s) sits in the `align` bytes before
    // the pointer, so the block's start is always the pointer minus `align`.
    let align = align.max(8);
    let total = match size.checked_add(align) {
        Some(t) => t,
        None => return null_mut(),
    };
    let layout = match Layout::from_size_align(total, align) {
        Ok(l) => l,
        Err(_) => return null_mut(),
    };
    let base = alloc(layout);
    if base.is_null() {
        return null_mut();
    }
    let p = base.add(align);
    (p as *mut u32).sub(2).write(total as u32);
    (p as *mut u32).sub(1).write(align as u32);
    p
}

/// Release a block from `wc_alloc`. Null is ignored.
#[no_mangle]
pub unsafe extern "C" fn wc_free(p: *mut u8) {
    if p.is_null() {
        return;
    }
    let total = (p as *const u32).sub(2).read() as usize;
    let align = (p as *const u32).sub(1).read() as usize;
    dealloc(p.sub(align), Layout::from_size_align_unchecked(total, align));
}
