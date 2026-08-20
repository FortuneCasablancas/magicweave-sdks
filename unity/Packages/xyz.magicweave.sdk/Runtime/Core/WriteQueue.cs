using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Magicweave
{
    /// <summary>
    /// Behaviours E3 + E4 — crash-safe writes and the offline queue.
    /// </summary>
    /// <remarks>
    /// These are one mechanism, not two. Every write is persisted <em>before</em>
    /// it is sent, carrying the idempotency key it will use. That single ordering
    /// buys both properties: a crash between persisting and sending replays with
    /// the same key, and a send that never leaves the device simply stays queued.
    /// <para/>
    /// The whole thing is only safe because the API guarantees idempotent replay.
    /// Without that guarantee a retry queue is a double-spend generator.
    /// </remarks>
    public sealed class WriteQueue
    {
        private const string QueueKey = "write_queue";

        private readonly IMagicweaveStorage _storage;
        private readonly string _namespace;
        private readonly IMagicweaveLogger _logger;
        private readonly Func<QueuedWrite, Task<string>> _sender;
        private readonly Func<Exception, bool> _shouldRetry;
        private readonly int _maxAttempts;
        private readonly SemaphoreSlim _drainGate = new SemaphoreSlim(1, 1);

        private List<QueuedWrite> _entries = new List<QueuedWrite>();
        private bool _loaded;

        public event EventHandler<QueueEventArgs> Changed;

        public WriteQueue(
            IMagicweaveStorage storage,
            string storageNamespace,
            IMagicweaveLogger logger,
            Func<QueuedWrite, Task<string>> sender,
            Func<Exception, bool> shouldRetry,
            int maxAttempts = 0)
        {
            _storage = storage;
            _namespace = storageNamespace;
            _logger = logger;
            _sender = sender;
            _shouldRetry = shouldRetry;
            _maxAttempts = maxAttempts;
        }

        private string Key => _namespace + ":" + QueueKey;

        private async Task LoadAsync()
        {
            if (_loaded) return;

            var raw = await _storage.GetAsync(Key).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(raw))
            {
                try
                {
                    _entries = QueueSerializer.Deserialize(raw);
                }
                catch (Exception)
                {
                    // A corrupt queue is worse than an empty one: replaying garbage
                    // would send malformed writes forever. Drop it loudly.
                    _logger?.Error("write queue was corrupt and has been discarded");
                    _entries = new List<QueuedWrite>();
                }
            }

            _loaded = true;
        }

        private async Task PersistAsync()
        {
            if (_entries.Count == 0)
            {
                await _storage.RemoveAsync(Key).ConfigureAwait(false);
                return;
            }

            await _storage.SetAsync(Key, QueueSerializer.Serialize(_entries)).ConfigureAwait(false);
        }

        private void Emit(QueueEventKind kind, QueuedWrite entry,
            string body = null, Exception error = null)
        {
            var handler = Changed;
            if (handler == null) return;

            try
            {
                handler(this, new QueueEventArgs(kind, entry, body, error));
            }
            catch (Exception listenerError)
            {
                // A subscriber throwing must not abort the drain.
                _logger?.Warn("queue listener threw: " + listenerError.Message);
            }
        }

        /// <summary>Persist an entry before any attempt to send it.</summary>
        public async Task EnqueueAsync(QueuedWrite entry)
        {
            await LoadAsync().ConfigureAwait(false);
            _entries.Add(entry);
            await PersistAsync().ConfigureAwait(false);
            Emit(QueueEventKind.Enqueued, entry);
        }

        public async Task RemoveAsync(string id)
        {
            await LoadAsync().ConfigureAwait(false);
            _entries.RemoveAll(e => e.Id == id);
            await PersistAsync().ConfigureAwait(false);
        }

        public async Task<int> CountAsync()
        {
            await LoadAsync().ConfigureAwait(false);
            return _entries.Count;
        }

        public async Task<IReadOnlyList<QueuedWrite>> PendingAsync()
        {
            await LoadAsync().ConfigureAwait(false);
            return _entries.ToArray();
        }

        public async Task ClearAsync()
        {
            _entries = new List<QueuedWrite>();
            _loaded = true;
            await PersistAsync().ConfigureAwait(false);
        }

        /// <summary>
        /// Attempt every pending entry, oldest first.
        /// </summary>
        /// <remarks>
        /// Stops at the first entry that fails retryably: order matters in a game
        /// economy (a purchase that spends coins a queued grant provides must not
        /// jump ahead of it), and if the network is down for one entry it is down
        /// for the next. Entries that fail <em>permanently</em> are dropped —
        /// replaying a 422 forever would wedge the queue behind a request that can
        /// never succeed.
        /// </remarks>
        public async Task DrainAsync()
        {
            if (!await _drainGate.WaitAsync(0).ConfigureAwait(false)) return;

            try
            {
                await LoadAsync().ConfigureAwait(false);

                while (_entries.Count > 0)
                {
                    var entry = _entries[0];
                    entry.Attempts += 1;

                    try
                    {
                        var body = await _sender(entry).ConfigureAwait(false);
                        _entries.RemoveAt(0);
                        await PersistAsync().ConfigureAwait(false);
                        Emit(QueueEventKind.Sent, entry, body);
                    }
                    catch (Exception error)
                    {
                        entry.LastError = error.Message;

                        var permanent = !_shouldRetry(error);
                        var exhausted = _maxAttempts > 0 && entry.Attempts >= _maxAttempts;

                        if (permanent || exhausted)
                        {
                            _entries.RemoveAt(0);
                            await PersistAsync().ConfigureAwait(false);
                            _logger?.Warn(
                                $"dropping queued write {entry.Method} {entry.Path} after " +
                                $"{entry.Attempts} attempt(s): {entry.LastError}");
                            Emit(QueueEventKind.Failed, entry, null, error);
                            continue;
                        }

                        await PersistAsync().ConfigureAwait(false);
                        _logger?.Debug(
                            $"queued write {entry.Method} {entry.Path} still pending: {entry.LastError}");
                        return;
                    }
                }

                Emit(QueueEventKind.Drained, null);
            }
            finally
            {
                _drainGate.Release();
            }
        }
    }
}
