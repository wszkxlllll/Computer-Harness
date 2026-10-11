# F-20261011-072: exact macOS attached-sheet lifecycle

TextEdit exposes its Save sheet as a separate CGWindowID. Parent-only capture now correctly excludes the sheet, but the model continued sending input to the parent. This change lets the existing SurfaceRegistry push/pop follow a uniquely proven attached sheet when opened-window switching is explicitly enabled.

The native `get_window_state` response adds private, versioned `attached_sheet_proof`. A successful complete read of the exact parent’s direct AXChildren must contain exactly one AXSheet, whose AXParent is CFEqual to the retained parent. Direct native window IDs, AX PIDs, WindowServer owners, positive AX/CG geometry, frontmost PID, and focused child are checked again before publishing the proof. A successful no-sheet read also requires the exact parent focused. Any read failure, unclassifiable child role, ambiguity, identity/geometry change, or stale focus yields no proof.

The TS consumer matches the proof against the current parent baseline and the unique visible new row in the actual partial macOS inventory. It preserves `complete=false`, requires foreground delivery and `opened-windows-v1`, and uses the existing child push/pop and reference invalidation. The new admission source is limited to a native window with a parent across Protocol, Runtime and Trajectory. No production Guard or global inventory completeness rule is relaxed. Same PID, a title, or a newly appearing window alone never authorizes switching.

Native input is reproducible from clean `d114f35fec05ecd37bf529e5587be86852205b64` by applying these repository patches in order:

1. `patches/cua-driver/d114f35-macos-exact-window-capture.patch`
2. `patches/cua-driver/d114f35-macos-focused-element-proof.patch`
3. `patches/cua-driver/d114f35-macos-attached-sheet-proof.patch`

The third patch SHA-256 is `41756fcb23395a804bf757403b8a2732dc8d3d182c662c8fe729c653c70e9f1b`. Sol independently checked/replayed all three patches and compared the three resulting source files byte for byte with the build source. The locked offline arm64 debug build completed successfully; the raw executable SHA-256 is `c0ca517e79122d40f55a1101985f90cc74302d2f77e5ce8498fee1f341dd95c9`.

Luna’s typecheck and complete related TS suite passed; Sol independently repeated `tsc -b` and the Computer/Surface, Runtime, Trajectory and Protocol suites: 28 files / 837 tests passed. The dedicated native safety table passed; the previous native full-suite result is historical and was not repeated. Regressions include real partial inventory, parent→sheet→parent, old-reference zero-input rejection, contradictory no-sheet/visible child, wrong parent, snapshot mismatch, multiple new windows, switching disabled and truncated baseline. Native cases reject incorrect owner, focus, geometry, identity and tail reads.

These are source/build and offline validation results. A real candidate lifecycle and the original complete T2 card remain separate acceptance steps; neither a read-only proof nor a partial save attempt closes T2.

The combined candidate preserves the independent bundle ID `com.trycua.driver.capturefix.local.20261011`. Its signed executable SHA-256 is `3d3c783174d6e85da74a53ef9388e9ec12156aca1520fb8911fac1abefcf9f60`, CDHash `c69e764e618c5decc5e74d1aadc971aef4d7b0e9`; Sol independently verified the strict signature and executable hash. The previously authorized signed candidate was preserved intact for rollback. Normal launch uses a fresh dedicated socket; actual OS permission continuity and live lifecycle are verified separately. The original stock driver remains unchanged.
