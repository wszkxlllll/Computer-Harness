# A71 paired macOS Native source closure

A71 uses the N9 upstream commit and all 12 N9 patches, followed by the one additional patch recorded here. `source-chain.json` is the complete ordered 13-patch list; do not apply N9 twice. `final-source-pins.json` records all 443 source/test/resource files.

The only source delta from N9 is `libs/cua-driver/rust/crates/platform-macos/src/ax/ordinary_sharing_control.rs`; Windows Native files are unchanged. Keep the original [MIT notice](../n9/MIT-LICENSE.trycua.txt) and upstream attribution.

Use the clean pinned upstream checkout and apply-once/hash verification recipe in [N9 instructions](../n9/README.md), substituting this directory as the package. The field names and repository-relative patch paths are the same; expect 13 patches and 443 files. The independent A71 audit verified the final 443-file set and reconstructed the exact N9 source from the added patch; a new full upstream replay/build was not performed in this audit.

Build with the N9 documented Rust toolchain and locked Cargo dependencies. Package and sign locally and grant normal macOS permissions for the resulting App. The historical A71 signed executable SHA-256 is `1605e37a5260696ce6e6679706c2fb8444ada5d3e58b6480796e2a1658cd8758`; new builds/signatures need not match it or inherit its permissions. No app binary, TCC data, private socket, credentials or upstream checkout is distributed.

The Native patch is paired source provenance, not a Windows driver replacement or a new-machine behavior guarantee.
