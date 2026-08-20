using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Magicweave
{
    /// <summary>
    /// JSON helpers shared by the queue and the error decoder.
    /// </summary>
    /// <remarks>
    /// Newtonsoft rather than <c>JsonUtility</c>: the generated transport already
    /// requires it (see <c>Magicweave.Generated.asmdef</c>), Unity ships it as a
    /// first-party package, and <c>JsonUtility</c> cannot represent a dictionary
    /// or a top-level array — both of which the error envelope and the write
    /// queue need.
    /// </remarks>
    internal static class Json
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
            // A shipped game must not crash on a field the server added after the
            // build went out.
            MissingMemberHandling = MissingMemberHandling.Ignore
        };

        public static string Serialize(object value) =>
            JsonConvert.SerializeObject(value, Settings);

        public static T Deserialize<T>(string json) =>
            JsonConvert.DeserializeObject<T>(json, Settings);

        public static JObject ParseObject(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                return JsonConvert.DeserializeObject<JObject>(json, Settings);
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    internal static class QueueSerializer
    {
        public static string Serialize(List<QueuedWrite> entries) => Json.Serialize(entries);

        public static List<QueuedWrite> Deserialize(string raw)
        {
            var entries = Json.Deserialize<List<QueuedWrite>>(raw);
            return entries ?? new List<QueuedWrite>();
        }
    }

    /// <summary>Turns the client API's error envelope into a typed exception.</summary>
    internal static class ErrorDecoder
    {
        /// <summary>
        /// The API returns <c>{ detail, error: { code, message, status, context } }</c>.
        /// <c>detail</c> is display text; <c>code</c> is the stable contract. When the
        /// envelope is missing — an old deployment, or a proxy's own error page — fall
        /// back to a code derived from the status, which is honest about what we know.
        /// </summary>
        public static MagicweaveApiException Decode(int status, string body)
        {
            var root = Json.ParseObject(body);
            var envelope = root?["error"] as JObject;

            var code = envelope?["code"]?.ToString();
            if (string.IsNullOrEmpty(code)) code = MagicweaveApiException.CodeForStatus(status);

            var message = envelope?["message"]?.ToString()
                          ?? root?["detail"]?.ToString()
                          ?? $"Request failed ({status})";

            Dictionary<string, object> context = null;
            if (envelope?["context"] is JObject ctx)
            {
                context = new Dictionary<string, object>();
                foreach (var property in ctx.Properties())
                {
                    context[property.Name] = property.Value?.ToObject<object>();
                }
            }

            return MagicweaveApiException.FromResponse(status, code, message, context);
        }
    }
}
