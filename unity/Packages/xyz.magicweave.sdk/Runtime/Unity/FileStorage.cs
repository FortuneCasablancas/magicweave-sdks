using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

namespace Magicweave.Unity
{
    /// <summary>
    /// Durable storage under <see cref="Application.persistentDataPath"/>.
    /// </summary>
    /// <remarks>
    /// Explicitly <em>not</em> <c>PlayerPrefs</c>. On desktop that is a plaintext
    /// registry key or plist any player can edit, and on WebGL it is IndexedDB
    /// with a size cap that a write queue can hit. Files are also what the queue
    /// wants: one small value, rewritten often.
    /// <para/>
    /// This is durable, not secret. It stops a token disappearing on restart; it
    /// does not stop a determined player reading it off their own device. For a
    /// game where that matters, implement <see cref="IMagicweaveStorage"/> over
    /// the platform keystore and pass it in <see cref="MagicweaveOptions.Storage"/>.
    /// WebGL has no keystore at all, which is one more reason web builds should
    /// talk to a server you own rather than straight to the API.
    /// </remarks>
    public sealed class FileStorage : IMagicweaveStorage
    {
        private readonly string _root;

        public FileStorage(string subdirectory = "magicweave")
        {
            _root = Path.Combine(Application.persistentDataPath, subdirectory);
        }

        private string PathFor(string key)
        {
            // Keys are namespaced with ':' and may contain '/', neither of which
            // is a safe filename everywhere.
            var safe = new StringBuilder(key.Length);
            foreach (var ch in key)
            {
                safe.Append(char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' ? ch : '_');
            }

            return Path.Combine(_root, safe + ".json");
        }

        public Task<string> GetAsync(string key)
        {
            var path = PathFor(key);
            return Task.FromResult(File.Exists(path) ? File.ReadAllText(path) : null);
        }

        public Task SetAsync(string key, string value)
        {
            Directory.CreateDirectory(_root);
            var path = PathFor(key);

            // Write-then-rename, so a crash mid-write cannot leave a truncated
            // queue file behind — which would look exactly like corruption and
            // cost the player everything queued.
            var temp = path + ".tmp";
            File.WriteAllText(temp, value);
            if (File.Exists(path)) File.Delete(path);
            File.Move(temp, path);

            return Task.CompletedTask;
        }

        public Task RemoveAsync(string key)
        {
            var path = PathFor(key);
            if (File.Exists(path)) File.Delete(path);
            return Task.CompletedTask;
        }
    }
}
