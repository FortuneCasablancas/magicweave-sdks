#!/usr/bin/env bash
# Regenerate a platform's transport layer from the committed OpenAPI snapshot.
#
#   ./scripts/generate.sh typescript
#   ./scripts/generate.sh unity
#   ./scripts/generate.sh all
#
# Generator versions are PINNED here on purpose. Template churn between
# openapi-generator releases is the single biggest maintenance risk in this
# repo: an unpinned upgrade silently rewrites thousands of lines of client code
# in four languages. Upgrading is its own reviewed change, never a side effect.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/spec/client-openapi.snapshot.json"

# ── pinned toolchain ────────────────────────────────────────────────────────
OPENAPI_GENERATOR_VERSION="7.11.0"
GENERATOR_IMAGE="openapitools/openapi-generator-cli:v${OPENAPI_GENERATOR_VERSION}"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$SPEC" ] || die "missing spec: $SPEC (run scripts/sync-spec.sh)"

generate_typescript() {
  echo "→ typescript (openapi-typescript, pinned in typescript/package.json)"
  ( cd "$ROOT/typescript" && npm run --silent generate )
}

# The generator emits scaffolding for a standalone library — a git push helper,
# a README, a copy of the spec, and (worst) a .gitignore that would exclude the
# very code we commit. Strip it: this output is a subdirectory of a package that
# already has all of those.
prune() {
  local dir="$1"
  rm -rf "$dir/.gitignore" "$dir/git_push.sh" "$dir/README.md" "$dir/api" \
         "$dir/.travis.yml" "$dir/appveyor.yml" "$dir/docs"
}

# openapi-generator ships as a JVM tool; running it through Docker keeps a Java
# toolchain off every contributor's machine and pins the version exactly.
run_generator() {
  command -v docker >/dev/null || die "docker is required to run openapi-generator"
  docker run --rm \
    -v "$ROOT:/work" \
    -u "$(id -u):$(id -g)" \
    "$GENERATOR_IMAGE" "$@"
}

generate_unity() {
  echo "→ unity (openapi-generator csharp, UnityWebRequest)"
  local out="/work/unity/Packages/xyz.magicweave.sdk/Runtime/Generated"
  rm -rf "$ROOT/unity/Packages/xyz.magicweave.sdk/Runtime/Generated"
  run_generator generate \
    -i /work/spec/client-openapi.snapshot.json \
    -g csharp \
    -o "$out" \
    --additional-properties=\
library=unityWebRequest,\
targetFramework=netstandard2.1,\
packageName=Magicweave.Generated,\
nullableReferenceTypes=true,\
useOneOfDiscriminatorLookup=true \
    --global-property=apiTests=false,modelTests=false,apiDocs=false,modelDocs=false
  prune "$ROOT/unity/Packages/xyz.magicweave.sdk/Runtime/Generated"
}

generate_flutter() {
  echo "→ flutter (openapi-generator dart-dio)"
  local out="/work/flutter/lib/src/generated"
  rm -rf "$ROOT/flutter/lib/src/generated"
  run_generator generate \
    -i /work/spec/client-openapi.snapshot.json \
    -g dart-dio \
    -o "$out" \
    --additional-properties=pubName=magicweave_generated,nullableFields=true \
    --global-property=apiTests=false,modelTests=false,apiDocs=false,modelDocs=false
  prune "$ROOT/flutter/lib/src/generated"
}

generate_unreal() {
  echo "→ unreal (openapi-generator cpp-ue4)"
  local out="/work/unreal/Source/MagicweaveGenerated"
  rm -rf "$ROOT/unreal/Source/MagicweaveGenerated"
  run_generator generate \
    -i /work/spec/client-openapi.snapshot.json \
    -g cpp-ue4 \
    -o "$out" \
    --additional-properties=cppNamespace=Magicweave,unrealModuleName=MagicweaveGenerated \
    --global-property=apiTests=false,modelTests=false,apiDocs=false,modelDocs=false
  prune "$ROOT/unreal/Source/MagicweaveGenerated"
}

target="${1:-all}"
case "$target" in
  typescript) generate_typescript ;;
  unity)      generate_unity ;;
  flutter)    generate_flutter ;;
  unreal)     generate_unreal ;;
  all)        generate_typescript; generate_unity ;;
  *)          die "unknown target '$target' (typescript|unity|flutter|unreal|all)" ;;
esac

echo "done. Review the diff — generated files are committed, never hand-edited."
