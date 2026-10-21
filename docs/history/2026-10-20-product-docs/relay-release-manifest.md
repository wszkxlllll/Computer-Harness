# Fixed Relay release manifest verification

`scripts/relay-release-manifest.mjs` is a standalone read-only library for the
reviewed `relay-runtime-c84d6d1-v1` profile. It does not change the production
entrypoint or deploy/restart a service. It neither imports runtime JS nor opens
HTTP/socket connections. Its scope is the fixed historical Relay runtime file
set from I-20261006-002/T-20261006-005/006, with deployment links clarified by
T-20261006-010. Web assets are not included.

The profile always requires 11 JS files and four package.json files, all 19
files in ws 8.21.3, and five exact workspace/ws symlinks. Required paths,
workspace identities/exports, ws identity/version/exports, and link paths are
code constants; a manifest cannot reduce or redefine that set. It deliberately
does not add relay-connector/index.js or app-runtime, which were declared or
type-only dependencies rather than the reviewed runtime imports.

The two main exports are:

```js
captureRelayManifest({ releaseRoot, sourceRevision, wsPackageRoot })
verifyRelayRelease({ releaseRoot, expectedManifest, expectedManifestSha256 })
```

Capture returns relative fixed file paths and SHA-256 hashes, a 40-hex source
revision, and the reviewed ws packageRoot and tree hash. It provides material
for an independent review/freeze; it does not make the inspected release
trusted. A release's self-generated manifest is not authentication. The
expected manifest and SHA-256 must come from an independently reviewed,
frozen build/source. Verification requires that external digest before reading
candidate files. `serializeRelayManifest(manifest)` returns the canonical JSON
whose UTF-8 bytes are hashed for the external pin. Canonicalization sorts the
fixed entries; missing/duplicate/extra entries, non-SHA256 hashes, absolute or
traversing paths, unknown profiles, and unexpected schema fields are rejected.
There is no CLI, automatic manifest adoption, signature system, or provenance
claim about who supplied the pin. Pinning a candidate's newly generated digest
yourself defeats the external trust boundary and is not a reviewed workflow.

`wsPackageRoot` is a normalized release-relative physical directory chosen by
the external reviewed manifest. Historical staging evidence did not prove its
exact physical path; the source checkout's pnpm layout must not be assumed for
a deployment. The profile binds `apps/relay/node_modules/ws` to exactly this
directory and checks its full 19-file set and bytes. Workspace links bind to
their exact `packages/{relay-connector,protocol,voice}` roots. Each link must
resolve to its exact expected target inside the canonical release root, and
remain consistent across its immediate check and the final layout recheck.
Actual symlink text may be absolute or relative (including `..`); it is the
canonical bound target that matters. An alternate in-root package target fails.
The normalized-relative-only restriction applies to manifest file paths and
ws packageRoot, not to symlink text already present in a release.

All ordinary files and directory ancestors must be non-symlinks. File handles
use O_NOFOLLOW; read metadata and current path identity are compared before and
after reads. Missing voice, old routing bytes, incorrect metadata exports,
mixed/omitted/extra ws files, link escapes, and altered hashes fail closed. The
ws tree hash follows sorted `relative-path + NUL + bytes + NUL` for all 19
files. Reports contain only profile, validated revision/manifest hash, a fixed
result code, and explicit `provenanceScope:"release-files-only"`,
`runtimeLoaded:false`, `processAttested:false`; they never contain absolute
paths, config values, raw file/error text, or private content. The library
also replaces capture failures with fixed error categories, retaining no native
error, filesystem path or cause. It reads only the required public
runtime/metadata/ws files, not .env, local
configuration, credentials, Web assets or the rest of a release.

These checks are point-in-time disk/layout evidence on a frozen candidate,
not atomic filesystem locking, service-account ESM resolution, proof of an
already running process's modules, or live version-sensitive behavior. ws can
optionally require bufferutil/utf-8-validate outside its own package; its 19-file
tree does not attest their resolution environment. The fixed profile should
be revised and independently reviewed if runtime imports/dependencies change.
No service cold-start, authenticated contract smoke, deployment or I002
acceptance can be inferred from a `bytes_and_layout_match` result alone.

Author verification uses synthetic releases only:

```sh
node --check scripts/relay-release-manifest.mjs
node --check scripts/relay-release-manifest.test.mjs
node --test scripts/relay-release-manifest.test.mjs
```

Tests create private mktemp fixture directories, deliberately non-executable
synthetic JS and metadata, and the reviewed relative link layout. They remove
only their exact fixture directories when done. No production/shared dist is
read or imported, and no real service, desktop, SDK, model API, build, deploy,
permission edit or Git operation is performed.
