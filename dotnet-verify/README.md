# dotnet-verify

Compile-verification and unit tests for the Unity SDK's engine-independent half.

`unity/Packages/xyz.magicweave.sdk/Runtime/Core/` deliberately has no `UnityEngine` dependency, so
it builds as a plain netstandard2.1 library. That is what this directory exercises: 41 xUnit tests
mirroring `typescript/test/ergonomics.test.ts` case for case, because two SDKs implementing "the
same" behaviour from prose will drift, and two SDKs asserting the same sequences will not.

```bash
docker run --rm -v "$PWD/..:/src" -w /src/dotnet-verify/Tests \
  mcr.microsoft.com/dotnet/sdk:8.0 dotnet test
```

Docker rather than a local install, for the same reason `scripts/generate.sh` uses it: no
contributor needs a .NET toolchain on their machine, and the version is pinned.

`Runtime/Unity/` and `Editor/` are excluded — they reference `UnityEngine` and are verified in the
editor. Keeping the ergonomics logic out of those files is what makes the rest testable here.
