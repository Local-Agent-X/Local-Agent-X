using System.Text.Json.Serialization;

namespace LocalAgentX.Installer.Services;

// JSONL events emitted by `node scripts/install-common.mjs --ipc`. Schema
// lives in the top-of-file comment of that script — keep this in sync.
public class ProgressEvent
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("steps")] public StepPlan[]? Steps { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("state")] public string? State { get; set; }
    [JsonPropertyName("detail")] public string? Detail { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("level")] public string? Level { get; set; }
    [JsonPropertyName("line")] public string? Line { get; set; }
}

public class StepPlan
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("label")] public string Label { get; set; } = "";
}
