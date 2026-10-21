# F-20261007-008 archive manifest

This directory archives the frozen pure phase-controller candidate and its synthetic tests. No production adapter or native/runtime artifact is included.

| Artifact | SHA-256 | Source / migration note |
| --- | --- | --- |
| `diagnostic-launcher.mjs` | `9b0807249621a6f550f8e205763ddcec36fdf80f79a48ebc3de5148d693201dc` | Frozen temporary controller; copied byte-for-byte from `/private/tmp/diagnostic-launcher-F008.P9A4zV/` |
| `diagnostic-launcher.test.mjs` | `5743ea433465dbb4df8a5fcad6a475c331fd4002a014e07e0770d03cada57ab2` | Frozen author synthetic tests; copied byte-for-byte from the same temporary directory |
| `independent.test.mjs` | `46332810c8a844bad43686d83e9dc0b679371dd378d38760403619da17c81d70` | Independent synthetic tests. Source SHA-256 `99efd9f62142c51ec58cc4a7026237b02f8beca3570bf0169dbfd0b0cd2e6b4a`; sole content change replaces the absolute temp-module import with `./diagnostic-launcher.mjs` |
| `README.md` | `19fcbbb5613763f271c075aa0b13ed8ef08394abb08c435cf3e3f59e6fc39bce` | Candidate README plus a short explicit limitation note: no real adapter/permission check, token is not human authorization, timers cannot preempt a non-cooperative native call. Original candidate SHA-256 `cb9f70ba4b087843eb0ff082e2cee822aa63cf4094bc346147862a2ba74e9fd5` |

Archive verification performed from this directory:

```sh
node --check diagnostic-launcher.mjs
node --check diagnostic-launcher.test.mjs
node --check independent.test.mjs
node --test diagnostic-launcher.test.mjs independent.test.mjs
```

Observed result: 23 top-level subtests, 31 total tests, all passed. These are fake-clock/fake-lifecycle tests only. They do not verify a real child-process adapter, OS permission state, native dispatch, or live cleanup. The independent reviewer’s prose report remains separately owned by the root and is not copied into this artifact bundle.
