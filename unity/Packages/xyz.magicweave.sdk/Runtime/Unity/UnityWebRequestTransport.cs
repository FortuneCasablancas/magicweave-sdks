using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine.Networking;

namespace Magicweave.Unity
{
    /// <summary>
    /// <see cref="IHttpTransport"/> backed by <see cref="UnityWebRequest"/>.
    /// </summary>
    /// <remarks>
    /// Deliberately not <c>HttpClient</c>. WebGL has no sockets and no threads —
    /// <c>HttpClient</c> either fails outright or blocks the single browser
    /// thread there — whereas <c>UnityWebRequest</c> maps onto the browser's own
    /// fetch. One transport that works on every Unity target beats two that each
    /// work on some.
    /// <para/>
    /// Completion is bridged to a <see cref="Task"/> through the request's
    /// <c>completed</c> callback, which Unity raises on the main thread. Nothing
    /// here spawns a thread, so it is safe on WebGL.
    /// </remarks>
    public sealed class UnityWebRequestTransport : IHttpTransport
    {
        private readonly int _timeoutSeconds;

        public UnityWebRequestTransport(int timeoutSeconds = 30)
        {
            _timeoutSeconds = timeoutSeconds;
        }

        public Task<HttpOutcome> SendAsync(HttpCall call, CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource<HttpOutcome>(
                TaskCreationOptions.RunContinuationsAsynchronously);

            UnityWebRequest request;
            try
            {
                request = Build(call);
            }
            catch (Exception error)
            {
                completion.SetResult(new HttpOutcome
                {
                    TransportError = "could not build request: " + error.Message
                });
                return completion.Task;
            }

            CancellationTokenRegistration registration = default;
            if (cancellationToken.CanBeCanceled)
            {
                registration = cancellationToken.Register(() =>
                {
                    try
                    {
                        request.Abort();
                    }
                    catch (Exception)
                    {
                        // Aborting an already-finished request throws; harmless.
                    }
                });
            }

            request.SendWebRequest().completed += _ =>
            {
                try
                {
                    completion.TrySetResult(ToOutcome(request));
                }
                finally
                {
                    registration.Dispose();
                    request.Dispose();
                }
            };

            return completion.Task;
        }

        private UnityWebRequest Build(HttpCall call)
        {
            var request = new UnityWebRequest(call.Url, call.Method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = _timeoutSeconds
            };

            if (!string.IsNullOrEmpty(call.Body))
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(call.Body));
            }

            if (call.Headers != null)
            {
                foreach (var header in call.Headers)
                {
                    // UnityWebRequest owns Content-Type when there is an upload
                    // handler, and rejects a duplicate.
                    if (string.Equals(header.Key, "content-type", StringComparison.OrdinalIgnoreCase))
                    {
                        if (request.uploadHandler != null)
                        {
                            request.uploadHandler.contentType = header.Value;
                            continue;
                        }
                    }

                    request.SetRequestHeader(header.Key, header.Value);
                }
            }

            return request;
        }

        private static HttpOutcome ToOutcome(UnityWebRequest request)
        {
            var outcome = new HttpOutcome
            {
                Status = (int)request.responseCode,
                Body = request.downloadHandler?.text
            };

            var responseHeaders = request.GetResponseHeaders();
            if (responseHeaders != null)
            {
                outcome.Headers = new Dictionary<string, string>(responseHeaders,
                    StringComparer.OrdinalIgnoreCase);
            }

            // A connection or protocol failure means the request never got an
            // answer — distinct from a 4xx/5xx, which did. The retry layer treats
            // the two differently, so the distinction has to survive to it.
#if UNITY_2020_2_OR_NEWER
            var failedBelowHttp = request.result == UnityWebRequest.Result.ConnectionError
                                  || request.result == UnityWebRequest.Result.DataProcessingError;
#else
            var failedBelowHttp = request.isNetworkError;
#endif

            if (failedBelowHttp || outcome.Status == 0)
            {
                outcome.TransportError = string.IsNullOrEmpty(request.error)
                    ? "connection failed"
                    : request.error;
            }

            return outcome;
        }
    }
}
