using System.Runtime.CompilerServices;

// The ergonomics layer keeps its helpers internal — backoff maths, header
// lookup, Retry-After parsing are implementation detail, not API surface a game
// should call. The test assemblies still need to reach them, because those
// helpers are exactly where an off-by-one hides.
[assembly: InternalsVisibleTo("Magicweave.Tests")]        // Unity test assembly
[assembly: InternalsVisibleTo("Tests")]                    // dotnet-verify harness
