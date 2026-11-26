# Maintained r186 declarations over published @types/three 0.185.4

This is a declaration-only compatibility patch, not a runtime fork and not an unpublished package presented as an npm release.

## Sources and identity

Verified September 10, 2026:

- The [npm registry](https://registry.npmjs.org/@types%2fthree) publishes `@types/three@0.185.4`; no `0.186.x` version was available at preparation.
- The maintainers' [exact r186 commit](https://github.com/three-types/three-ts-types/commit/5d4b38df3679e8383063a75539b6c71cdff4b66a) is `5d4b38df3679e8383063a75539b6c71cdff4b66a`, dated September 8, 2026, subject `r186`. Its `types/three` subtree identifies itself as private development version `0.186.9999`.
- The [r186 tracker](https://github.com/three-types/three-ts-types/issues/2251) had all 157 entries checked, although the tracker remained open and the latest release tag was r185. This supports selecting the maintained source; it does not establish project compatibility.
- Its Three.js test submodule is `e719c4fdb3025795cd82d7a846f4b7426fb69f0e`. The runtime [r186 tag](https://github.com/mrdoob/three.js/releases/tag/r186) resolves to `148ef33ecb6d2502ff796d4554abd1549c95d519`, four commits later (documentation, package allow-list, playground resize, release). The declaration snapshot is maintained for r186 but its test submodule is not literally the release commit.
- Published `LICENSE`, package metadata and README remain byte-identical to the npm tarball, including the MIT license. No upstream tests, compiler/tooling configuration, private package metadata or workspace dependencies are imported.

## Exact scope

Patch file: `patches/@types%2Fthree@0.185.4.patch`.

Root package-manager identity remains `@types/three@0.185.4`. Its patched declarations come from the pinned r186 subtree. The root override is `"@types/three": "file:vendor/three-types-r186.tgz"`. The declaration patch is an immutable reconstruction input, **not** registered in Bun's `patchedDependencies`. Do not replace runtime Three.js with a types repository or use an unpinned Git branch.

The vendored archive avoids a reproduced Bun 1.3.14 patch-install defect: newly created declaration parent directories received mode `0644`, making them untraversable (`EACCES`). Two isolated non-root reproductions, with and without patch index headers, showed the same behavior. A normal file-override install plus a frozen repeat succeeded in a clean isolated cache; the new directory had mode `0755`, and all 966 declaration hashes matched. This is a packaging workaround, not permission changes to installed files or a weakened declaration subset.

The patch changes 182 declaration files: 129 modifications, 47 additions, six deletions. It preserves 785 unchanged upstream declarations and five additional npm-generated `build/*.min.d.ts` forwarding files. The resulting published declaration set contains 966 files. Retaining those forwarding files preserves package layout; their bytes are independently checked.

No dependency or package-export edits are needed. The only upstream metadata dependency-range difference is `fflate ~0.8.2` versus `~0.8.3`; the retained range already admits 0.8.3, and none of the changed declarations adds an fflate import. The published package's `typesPublisherContentHash` remains original package metadata, not a claim about patched bytes; the hashes below qualify the actual content.

## Integrity receipts

| Item                                                                                                                                               | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| npm [three-0.185.4.tgz](https://registry.npmjs.org/@types/three/-/three-0.185.4.tgz), 348,571 bytes                                                | `4012a0b1c7842ba67230cc8fa1698e520aa370dbe9f5131f2d7c707e1d7088cd` |
| Pinned [maintainer archive](https://codeload.github.com/three-types/three-ts-types/tar.gz/5d4b38df3679e8383063a75539b6c71cdff4b66a), 775,043 bytes | `6d256d1f00ae349d8fd4b584593a14a48334e9edf738882e027f7adf34e4cbd4` |
| Declaration patch, 296,250 bytes                                                                                                                   | `ddd42c592b40c62f1aef18a0b9b47fc166e5d886e8191fb7daee8c274b51cef5` |
| Vendored `vendor/three-types-r186.tgz`, 362,202 bytes                                                                                              | `4ce38cd4af22a49a6317ebbdef3c713b52ff243b24c853c0b3cd71ec8070c27e` |
| Uncompressed deterministic package tar                                                                                                             | `bb287dfa049c3d6e2130fa85681f9b33057252a78ff5ad7359790d9d6ff19ba9` |
| Complete installed declaration manifest                                                                                                            | `8b3f10bc081ee1bf28b64cb533dace52d69aa826c9182fda06aa770875a09b71` |

The complete declaration manifest is constructed deterministically: recursively enumerate published `.d.ts`, `.d.cts` and `.d.mts` files (exclude dependency `node_modules`); sort relative POSIX paths by JavaScript code-unit order; for each append `path + NUL + SHA256(fileBytes) + LF`; hash that UTF-8 string. The installed regression additionally checks byte hashes of original package metadata, MIT license, README and five preserved forwarders.

## Reproduction and verification

1. Fetch the two exact archives above and verify their hashes before extracting into separate isolated temporary directories.
2. Take the npm package as the baseline. From the pinned maintainer `types/three` subtree, copy only declaration files; remove baseline declaration files absent upstream, except the five published `build/*.min.d.ts` forwarders. Preserve all non-declaration files byte-for-byte.
3. Generate a conventional unified diff with package-relative `a/` and `b/` paths. This patch used the already installed jsdiff 9.0.0 `createTwoFilesPatch` defaults, sorted paths, git headers and explicit new/deleted modes. No declaration was hand-edited.
4. During preparation every generated hunk was independently applied in memory against original lines with exact context/deletion checks; every resulting file matched the upstream target bytes. Git parsed the finished patch with `git apply --numstat`.
5. Run `node scripts/package-three-r186-types.mjs --output /absolute/new/output.tgz` (optionally `--baseline /absolute/verified/three-0.185.4.tgz`). The script authenticates the exact published archive and patch, checks/applies/reverse-checks the patch in an isolated temporary directory, validates all declarations and preserved metadata, and writes a new archive exclusively. Its 969 regular files comprise 966 declarations and the original three metadata/license files. Sorted POSIX ustar records use zero timestamps/ownership, `0644` file modes and implicit normal directories; no platform/PAX metadata. Two reconstructions were byte-identical under Node 22.23.2 / zlib 1.2.12. Other compression-library versions must be checked against the exact archive hash; the uncompressed tar hash distinguishes packaging from declaration differences.
6. After the normal locked file-override dependency install, run `node --test scripts/three-types-patch.test.mjs`. Require all five tests, including the archive identity and entire installed declaration hash, to pass. Then run actual project typechecks/builds and scoped runtime/renderer verification. Do not relax declarations, introduce broad casts, or add type suppression to force compatibility.

The patch preparation did not install packages, edit package manifests, modify runtime copies or run a renderer.

## Runtime singleton baseline and acceptance

Before the upgrade, `node_modules/three` is a materialized r183.2 directory while shared/client package links and VRM's realpath peer resolve to Bun's separate `.bun/three@0.183.2/node_modules/three`. A read-only ESM import check proved their `Object3D` constructors unequal despite equal `REVISION === "183"`. Within one package root, `three` and `three/webgpu` share `Object3D`, and `three/tsl.uniform === three/webgpu.TSL.uniform`.

The client has `resolve.dedupe: ["three", "buffer"]` and no Three-specific alias, while shared's facade imports core and WebGPU and patches prototypes. A package-manager relink must eliminate unintended physical runtime copies; a version override alone does not prove this. After normal installation, verify ESM resolution from root, shared, client, server and real VRM/addon importers lands in the same package root. Confirm core/WebGPU object, geometry and material class identities and TSL node-factory identity. Check bundle module provenance too: no old prebundled/shared artifact, absolute source entry, CJS/ESM crossing or copied root directory may silently retain another instance. Source `three/src/*` helpers require their own review; importing source constructors does not automatically share distributed-build class identity.

Current project-local `three-examples.d.ts` and `three-extensions.d.ts` include legacy declarations. New typings do not automatically supersede these ambient declarations. Review actual diagnostics against upstream signatures; prefer correct public types and precise application-owned augmentations over replacement module stubs. Neither existing `skipLibCheck` nor a passing metadata check establishes runtime correctness.
