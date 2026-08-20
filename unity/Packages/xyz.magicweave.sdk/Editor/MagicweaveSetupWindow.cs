using System.IO;
using System.Linq;
using Magicweave.Unity;
using UnityEditor;
using UnityEngine;

namespace Magicweave.Editor
{
    /// <summary>
    /// <c>Window → Magicweave → Setup</c> — the first thing a developer opens.
    /// </summary>
    /// <remarks>
    /// Behaviour E8 lives here. The job is narrow: get credentials out of the
    /// console and into the project without anyone pasting a secret into a
    /// script, and make switching testing → production a dropdown.
    /// </remarks>
    public sealed class MagicweaveSetupWindow : EditorWindow
    {
        private const string SettingsDirectory = "Assets/Resources";
        private const string SettingsAssetPath = SettingsDirectory + "/MagicweaveSettings.asset";
        private const string ConsoleUrl = "https://console.magicweave.xyz";

        private MagicweaveSettings _settings;
        private Vector2 _scroll;

        [MenuItem("Window/Magicweave/Setup", priority = 100)]
        public static void Open()
        {
            var window = GetWindow<MagicweaveSetupWindow>(false, "Magicweave", true);
            window.minSize = new Vector2(420, 460);
            window.Show();
        }

        [MenuItem("Window/Magicweave/Open console", priority = 101)]
        public static void OpenConsole() => Application.OpenURL(ConsoleUrl);

        private void OnEnable() => _settings = LoadOrFindSettings();

        private void OnGUI()
        {
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            EditorGUILayout.LabelField("Magicweave", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(
                "Connect this project to your game's backend.",
                EditorStyles.wordWrappedLabel);
            EditorGUILayout.Space();

            if (_settings == null)
            {
                DrawFirstRun();
                EditorGUILayout.EndScrollView();
                return;
            }

            DrawSettings();
            EditorGUILayout.EndScrollView();
        }

        private void DrawFirstRun()
        {
            EditorGUILayout.HelpBox(
                "No settings asset yet. Create one, then paste the client id and secret from " +
                "your project's Environments page in the console.",
                MessageType.Info);

            if (GUILayout.Button("Create settings asset", GUILayout.Height(28)))
            {
                _settings = CreateSettings();
            }

            if (GUILayout.Button("Open the console"))
            {
                Application.OpenURL(ConsoleUrl);
            }
        }

        private void DrawSettings()
        {
            var serialized = new SerializedObject(_settings);
            serialized.Update();

            EditorGUILayout.PropertyField(serialized.FindProperty("baseUrl"), new GUIContent("API host"));
            EditorGUILayout.Space();

            DrawEnvironmentPicker(serialized);
            EditorGUILayout.Space();

            EditorGUILayout.PropertyField(serialized.FindProperty("environments"), true);
            EditorGUILayout.Space();

            EditorGUILayout.LabelField("Identity", EditorStyles.boldLabel);
            EditorGUILayout.PropertyField(
                serialized.FindProperty("nonNetworkProject"),
                new GUIContent("Non-network project",
                    "Identify players with your own id instead of a Magicweave session."));

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Behaviour", EditorStyles.boldLabel);
            EditorGUILayout.PropertyField(
                serialized.FindProperty("durableWrites"),
                new GUIContent("Offline-safe writes",
                    "Persist every write before sending it, so a crash or a dead network cannot lose it."));
            EditorGUILayout.PropertyField(
                serialized.FindProperty("verboseLogging"),
                new GUIContent("Verbose logging", "Leave off in a shipping build."));

            serialized.ApplyModifiedProperties();

            EditorGUILayout.Space();
            DrawWarnings();
            EditorGUILayout.Space();

            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Open the console")) Application.OpenURL(ConsoleUrl);
                if (GUILayout.Button("Select asset")) Selection.activeObject = _settings;
            }

            if (GUILayout.Button("Copy a quick-start snippet"))
            {
                EditorGUIUtility.systemCopyBuffer = QuickStartSnippet;
                ShowNotification(new GUIContent("Copied"));
            }
        }

        private void DrawEnvironmentPicker(SerializedObject serialized)
        {
            var environments = _settings.environments;
            if (environments == null || environments.Length == 0)
            {
                EditorGUILayout.HelpBox("Add an environment below to get started.", MessageType.Info);
                return;
            }

            var labels = environments
                .Select((e, i) => $"{i + 1}. {e.label} ({e.kind})" + (e.usePreviewCredentials ? " · preview" : ""))
                .ToArray();

            var property = serialized.FindProperty("activeEnvironmentIndex");
            var index = Mathf.Clamp(property.intValue, 0, environments.Length - 1);

            EditorGUI.BeginChangeCheck();
            var chosen = EditorGUILayout.Popup(
                new GUIContent("This build uses", "Switching here needs no code change."),
                index, labels);
            if (EditorGUI.EndChangeCheck()) property.intValue = chosen;
        }

        private void DrawWarnings()
        {
            var active = _settings.ActiveEnvironment;

            if (active == null || !active.IsComplete)
            {
                EditorGUILayout.HelpBox(
                    "The selected environment is missing its client id or secret. Copy both from " +
                    "the console: Project → Environments.",
                    MessageType.Warning);
                return;
            }

            if (active.kind == MagicweaveEnvironmentKind.Production)
            {
                EditorGUILayout.HelpBox(
                    "This build is pointed at PRODUCTION. Player data written from the editor is real.",
                    MessageType.Warning);
            }

            if (active.usePreviewCredentials)
            {
                EditorGUILayout.HelpBox(
                    "Using preview credentials — this build sees the DRAFT release, not the published one.",
                    MessageType.Info);
            }

            if (IsWebTarget())
            {
                EditorGUILayout.HelpBox(
                    "WebGL ships the client secret inside the build, where any player can read it " +
                    "from devtools. Route these calls through a server you control.",
                    MessageType.Warning);
            }

            if (IsAssetTracked())
            {
                EditorGUILayout.HelpBox(
                    "The settings asset holds a secret and appears to be inside a git repository. " +
                    "Add it to .gitignore, or keep production credentials out of it.",
                    MessageType.Info);

                if (GUILayout.Button("Add the settings asset to .gitignore"))
                {
                    AppendToGitignore();
                }
            }
        }

        private static bool IsWebTarget() =>
            EditorUserBuildSettings.activeBuildTarget == BuildTarget.WebGL;

        private static bool IsAssetTracked() =>
            Directory.Exists(Path.Combine(Directory.GetCurrentDirectory(), ".git"));

        private static void AppendToGitignore()
        {
            var path = Path.Combine(Directory.GetCurrentDirectory(), ".gitignore");
            const string entry = "Assets/Resources/MagicweaveSettings.asset";

            if (File.Exists(path) && File.ReadAllText(path).Contains(entry)) return;

            File.AppendAllText(path,
                "\n# Magicweave environment credentials — never commit a client secret.\n" +
                entry + "\n" + entry + ".meta\n");

            AssetDatabase.Refresh();
            Debug.Log("[Magicweave] added the settings asset to .gitignore");
        }

        private static MagicweaveSettings LoadOrFindSettings()
        {
            var existing = AssetDatabase.LoadAssetAtPath<MagicweaveSettings>(SettingsAssetPath);
            if (existing != null) return existing;

            // The asset only has to be somewhere under a Resources folder, so
            // find it wherever the developer moved it to.
            var guid = AssetDatabase.FindAssets("t:MagicweaveSettings").FirstOrDefault();
            return guid == null
                ? null
                : AssetDatabase.LoadAssetAtPath<MagicweaveSettings>(AssetDatabase.GUIDToAssetPath(guid));
        }

        private static MagicweaveSettings CreateSettings()
        {
            Directory.CreateDirectory(SettingsDirectory);

            var settings = CreateInstance<MagicweaveSettings>();
            AssetDatabase.CreateAsset(settings, SettingsAssetPath);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Selection.activeObject = settings;
            Debug.Log("[Magicweave] created " + SettingsAssetPath);
            return settings;
        }

        private const string QuickStartSnippet = @"using System.Threading.Tasks;
using Magicweave.Unity;
using UnityEngine;

public class Boot : MonoBehaviour
{
    private async void Start()
    {
        await MagicweaveSDK.InitAsync();

        if (!MagicweaveSDK.Client.IsSignedIn)
        {
            await MagicweaveSDK.Client.Auth.RequestOtpAsync(""player@example.com"");
            // … collect the code from the player, then:
            // await MagicweaveSDK.Client.Auth.VerifyOtpAsync(""player@example.com"", code);
        }

        Debug.Log(await MagicweaveSDK.Client.Wallet.GetAsync());
    }
}
";
    }
}
