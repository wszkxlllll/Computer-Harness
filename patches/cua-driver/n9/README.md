# Native source closure used by N9

This source-only package reconstructs the downstream macOS CUA Driver used by the frozen N9 Harness candidate. N9 is the Harness candidate name; it is not the earlier driver “native9”. It records 12 ordered source patches and source fingerprints, not the upstream monorepo or an application binary. The first 11 patches are already tracked in this repository; the final patch is added alongside them.

Upstream: https://github.com/trycua/cua.git
Exact commit: d114f35fec05ecd37bf529e5587be86852205b64
Exact tree: 1be75321ea36185d2fd660107785c07cc1daa67c
Pinned source: https://github.com/trycua/cua/tree/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/rust
Pinned license: https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/LICENSE.md

## Apply and verify

Obtain the exact upstream commit in your own checkout. Keep this package in a separate directory. `source-chain.json` lists the exact order, SHA-256 and repository location of every patch. Patch 8 has a hash-identical historical alternate path for the original N9 snapshot. Use this repository checkout rather than copying only this folder.

From the package directory, export the NATIVE_SOURCE environment variable pointing to your upstream checkout and run:

```sh
python3 - <<'VERIFY'
import hashlib, json, os, subprocess
from pathlib import Path
package = Path.cwd()
repository = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
source = Path(os.environ["NATIVE_SOURCE"])
chain = json.loads((package / "source-chain.json").read_text())
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() == chain["baseCommit"]
for patch in chain["patches"]:
    candidates = [repository / p for p in [patch["path"]] + patch.get("alternatePaths", [])]
    file = next(p for p in candidates if p.is_file())
    assert hashlib.sha256(file.read_bytes()).hexdigest() == patch["sha256"]
    subprocess.run(["git", "apply", "--check", str(file)], cwd=source, check=True)
    subprocess.run(["git", "apply", str(file)], cwd=source, check=True)
pins = json.loads((package / "final-source-pins.json").read_text())["sha256ByRelativePath"]
for path, expected in pins.items():
    assert hashlib.sha256((source / path).read_bytes()).hexdigest() == expected, path
print("443 source/test/resource files match; all 12 patches applied")
VERIFY
```

Begin with a clean checkout and apply once. The recipe changes only that checkout. The independent publication review exported the exact 439-file upstream source scope into a fresh temporary directory, performed `git apply --check` and `git apply` for all 12 patches, and verified all 443 final files byte for byte with no extra or missing source files. The temporary tree was removed. No native build, GUI, service or model request was performed in that review.

## Build

The archived build used Rust/Cargo 1.97.1 on macOS arm64, the pinned Cargo.lock (SHA-256 cb7cdf7d03eee68f2dd48b6dc75a6005e74ca96a5604a7a88a2994ddd5125a2f), and the macOS SDK/Swift tools resolved by the upstream build scripts through xcrun. Use a compatible Xcode or Command Line Tools installation. In the upstream checkout:

```sh
cd libs/cua-driver/rust
cargo +1.97.1 test --locked -p platform-macos
cargo +1.97.1 build --locked --release -p cua-driver
```

The resulting executable is `libs/cua-driver/rust/target/release/cua-driver` relative to the upstream checkout, unless CARGO_TARGET_DIR is set. The archived commands added `--offline` and used an external target directory; offline mode requires a prepopulated registry/cache. The archived final test receipt reports 444 unit tests passed, 2 ignored, and one ignored doc test. Existing CoreMediaBridge duplicate-symbol/rpath warnings were retained. This publication review verifies source replay and reads the archived build receipts; it does not present those historical test counts as tests newly run here.

The Harness macOS route and installed SDK are `@trycua/cua-driver@0.22.2` under alias `@trycua/cua-driver-0.22.2`, with `@trycua/cua-driver-darwin-arm64@0.22.2`. The patched driver workspace also reports 0.22.2. The separately installed 0.32.0 SDK is the Linux route and is not the SDK used for these macOS cases. A stock 0.22.2 daemon download lacks the downstream patch stack.

## Local packaging, signing and permissions

Package the built executable in a locally owned macOS app bundle if the Harness launch route requires a bundle. Keep its CFBundleExecutable and actual executable aligned, sign that local bundle with your own identity or a local ad-hoc signature, and use normal macOS permission setup for that exact bundle. This package deliberately does not require the original developer's bundle identity, private socket, local account UID, or application. The historical packaging helper contained local gates and an existing-app dependency, so it is not shipped as a portable build recipe.

The archived release executable before app signing had SHA-256 `3db02b3fe801dbbd1ab6764674175ac5a4b2a6d51690bbbba42ab8ce050e74d1`. The executable used by A48/A49/A50 after ad-hoc app signing had SHA-256 `3d0811e78f590e693762acd28fe3ddac24497eab452f11a537a6a39812cfe5f8` and CDHash `dadeacfba7f383a25bc5e2a0937dd0d9e152643f`. These identify historical artifacts. Builds, embedded paths, SDK/linker versions and signatures may differ on another machine; identical executable hashes and inherited TCC grants are not promised. Source replay and behavior validation are separate from byte-identical binary reproduction.

## Attribution and publication scope

The pinned upstream LICENSE.md and Cargo workspace declare MIT. Keep the included original copyright/permission notice and existing contributor credit. The additional patch represents downstream modifications; do not claim the CUA driver or SDK as original Harness work. The npm native binding has its own `MIT AND MPL-2.0` declaration; this package distributes no binding binary and does not replace its notices.

Publish the new patch, source-chain/source-pin metadata, this instruction text and MIT notice after mapping package paths into the repository as needed. The first 11 patches may be referenced from their existing tracked repository paths. Keep `.app`, target/node_modules, private.env, provider logs, screenshot files, TCC data, personal absolute paths and private socket settings outside the PR. The final delta was scanned including removed/context lines, with no personal absolute paths, private socket/environment names or literal credential assignments found; no behavior-changing code cleanup was performed.

This closes the final Native source gap for N9. It does not by itself prove a new Native build/run or physical-phone/public-Relay acceptance.
