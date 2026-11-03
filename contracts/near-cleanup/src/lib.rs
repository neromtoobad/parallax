//! The bank's code is 330 KB, and NEAR won't delete an account holding more than 10 KB, so teardown.sh
//! deploys this in its place (which frees the code's storage at once), calls `clean` with every storage key
//! the bank left behind, then deletes the account. Only the account itself can call `clean`.
//!
//! Input: the keys back to back, each as a 4-byte little-endian length followed by the key's bytes.
#![no_std]

#[link(wasm_import_module = "env")]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn current_account_id(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn storage_remove(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    fn panic_utf8(len: u64, ptr: u64) -> !;
}

const MAX: usize = 1 << 20;
static mut BUF: [u8; MAX] = [0; MAX];
static mut WHO: [u8; 128] = [0; 128];

fn fail(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

#[no_mangle]
pub extern "C" fn clean() {
    unsafe {
        let (buf, who) = (&mut *core::ptr::addr_of_mut!(BUF), &mut *core::ptr::addr_of_mut!(WHO));
        current_account_id(0);
        predecessor_account_id(1);
        let (a, b) = (register_len(0) as usize, register_len(1) as usize);
        if a != b || a > 64 {
            fail("only the account itself");
        }
        read_register(0, who.as_mut_ptr() as u64);
        read_register(1, who.as_mut_ptr().add(64) as u64);
        if who[..a] != who[64..64 + a] {
            fail("only the account itself");
        }
        input(2);
        let n = register_len(2) as usize;
        if n > MAX {
            fail("too many keys at once");
        }
        read_register(2, buf.as_mut_ptr() as u64);
        let mut i = 0;
        while i + 4 <= n {
            let len = u32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
            i += 4;
            if i + len > n {
                fail("bad input");
            }
            storage_remove(len as u64, buf.as_ptr().add(i) as u64, 3);
            i += len;
        }
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
