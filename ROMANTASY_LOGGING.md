# romantasy-v1 API Cost Logging

api-dash tracks costs from romantasy-v1 via a shared Supabase `api_usage` table.

The table already exists (Azure TTS logs to it). The providers below just need their logging snippets wired in.

---

## Which providers need logging

| Provider | Status | Usage field available |
|---|---|---|
| Anthropic | ⚠ Partial — only screenplay/story routes | `res.usage.input_tokens` / `output_tokens` |
| Gemini | ⚠ Partial — only via geminiJson helper, scene-agent skips | `usageMetadata.promptTokenCount` / `candidatesTokenCount` |
| Azure TTS | ✅ Fully logged | character count |
| OpenAI | ❌ Not logged | `data.usage.prompt_tokens` / `completion_tokens` |
| Venice | ❌ Not logged | no usage field — log per call |
| WaveSpeed | ❌ Not logged | no usage field — log per call |
| Akool | ❌ Not logged | no usage field — log per call |
| PiAPI | ❌ Not logged | no usage field — log per call |
| Modal | ❌ Not logged | no usage field — log per call |

---

## Pricing constants (as of 2025)

```ts
// lib/api-pricing.ts
export const PRICING = {
  // Anthropic — per million tokens
  anthropic: {
    "claude-haiku-4-5-20251001":    { input: 0.80,  output: 4.00  },
    "claude-sonnet-4-5-20250514":   { input: 3.00,  output: 15.00 },
    "claude-sonnet-4-6-20250131":   { input: 3.00,  output: 15.00 },
    "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00 },
    "claude-sonnet-4-6":            { input: 3.00,  output: 15.00 },
  },
  // OpenAI — per million tokens
  openai: {
    "gpt-4o":                       { input: 2.50,  output: 10.00 },
    "gpt-4o-mini":                  { input: 0.15,  output: 0.60  },
  },
  // Gemini — per million tokens
  google: {
    "gemini-2.5-pro":               { input: 1.25,  output: 10.00 },
    "gemini-2.5-flash":             { input: 0.15,  output: 0.60  },
    "gemini-2.0-flash":             { input: 0.10,  output: 0.40  },
  },
  // Flat per-generation estimates (no usage fields in responses)
  venice: {
    image: 0.006,   // ~$0.006/image (varies by model)
    video: 0.30,    // ~$0.30/video clip
    llm_per_1k: 0.0006, // llama-3.3-70b via venice
  },
  wavespeed: {
    image: 0.004,
    video: 0.25,
  },
  akool: {
    faceswap: 0.02,
    faceswap_plus: 0.04,
  },
  piapi: {
    faceswap: 0.015,
    video: 0.30,
  },
  modal: {
    image: 0.003,   // SDXL — rough estimate
    video: 0.20,    // AnimateDiff
    faceswap: 0.01,
  },
};
```

---

## Logging snippets

### Anthropic (add to every direct `anthropic.messages.create()` call)

```ts
import { supabase } from "@/lib/supabase"; // your existing client
import { PRICING } from "@/lib/api-pricing";

// After: const res = await anthropic.messages.create({ model, ... })
const p = PRICING.anthropic[model] ?? { input: 3.00, output: 15.00 };
const cost = (res.usage.input_tokens * p.input + res.usage.output_tokens * p.output) / 1_000_000;
supabase.from("api_usage").insert({
  provider: "anthropic", model,
  input_units: res.usage.input_tokens,
  output_units: res.usage.output_tokens,
  cost,
}).then(() => {}).catch(() => {});
```

Files that need this (currently skip logging):
- `lib/scene-agent.ts`, `lib/character-agent.ts`
- All routes in `app/api/authors/`, `app/api/forge/`, `app/api/copilot/`, `app/api/card-caption/`, etc.

### OpenAI (add to every `fetch` to `/v1/chat/completions`)

```ts
// After: const data = await res.json()
const model = body.model; // the model you passed in
const p = PRICING.openai[model] ?? { input: 2.50, output: 10.00 };
const cost = (data.usage.prompt_tokens * p.input + data.usage.completion_tokens * p.output) / 1_000_000;
supabase.from("api_usage").insert({
  provider: "openai", model,
  input_units: data.usage.prompt_tokens,
  output_units: data.usage.completion_tokens,
  cost,
}).then(() => {}).catch(() => {});
```

Files: `lib/scene-agent.ts`, `lib/character-agent.ts`, `app/api/authors/character-copilot`, `entity-copilot`, `app/api/copilot/route.ts`

### Venice image generation

```ts
// After a successful venice image response
supabase.from("api_usage").insert({
  provider: "venice", model: veniceModel,
  input_units: 1, output_units: 0,
  cost: PRICING.venice.image,
  metadata: { type: "image" },
}).then(() => {}).catch(() => {});
```

### Venice video generation

```ts
// After polling confirms video complete
supabase.from("api_usage").insert({
  provider: "venice", model: veniceModel,
  input_units: 1, output_units: 0,
  cost: PRICING.venice.video,
  metadata: { type: "video" },
}).then(() => {}).catch(() => {});
```

### Venice LLM (llama-3.3-70b)

```ts
// After venice chat completions response — no usage field, estimate from response length
const approxTokens = Math.ceil(responseText.length / 4);
supabase.from("api_usage").insert({
  provider: "venice", model: "llama-3.3-70b",
  input_units: 0, output_units: approxTokens,
  cost: (approxTokens / 1000) * PRICING.venice.llm_per_1k,
}).then(() => {}).catch(() => {});
```

### WaveSpeed image

```ts
supabase.from("api_usage").insert({
  provider: "wavespeed", model: wsModel,
  input_units: 1, output_units: 0,
  cost: PRICING.wavespeed.image,
}).then(() => {}).catch(() => {});
```

### WaveSpeed video

```ts
supabase.from("api_usage").insert({
  provider: "wavespeed", model: wsModel,
  input_units: 1, output_units: 0,
  cost: PRICING.wavespeed.video,
}).then(() => {}).catch(() => {});
```

### Akool face swap

```ts
// After job completes (faceswap_status === 3)
supabase.from("api_usage").insert({
  provider: "akool", model: akoolModel, // "akool" or "akool-plus"
  input_units: 1, output_units: 0,
  cost: akoolModel === "akool-plus" ? PRICING.akool.faceswap_plus : PRICING.akool.faceswap,
}).then(() => {}).catch(() => {});
```

### PiAPI face swap / video

```ts
// After task polling completes successfully
const isVideo = task.task_type?.includes("video") || !!data.output?.video_url;
supabase.from("api_usage").insert({
  provider: "piapi", model: piModel,
  input_units: 1, output_units: 0,
  cost: isVideo ? PRICING.piapi.video : PRICING.piapi.faceswap,
}).then(() => {}).catch(() => {});
```

### Modal image / video / face swap

```ts
// After successful Modal response
supabase.from("api_usage").insert({
  provider: "modal", model: modalModel,
  input_units: 1, output_units: 0,
  cost: isVideo ? PRICING.modal.video : isFaceSwap ? PRICING.modal.faceswap : PRICING.modal.image,
}).then(() => {}).catch(() => {});
```

---

## What api-dash shows once logged

Once any provider appears in `api_usage`, api-dash auto-discovers it and creates a dial tile:

- **romantasy-v1 / Gemini** — already shows (partial data)
- **romantasy-v1 / Azure TTS** — already shows (full data)
- **romantasy-v1 / Venice** — appears once first call is logged
- **romantasy-v1 / WaveSpeed** — appears once first call is logged
- **romantasy-v1 / Akool** — appears once first call is logged
- **romantasy-v1 / PiAPI** — appears once first call is logged
- **romantasy-v1 / Modal** — appears once first call is logged

Anthropic and OpenAI from romantasy-v1 are intentionally excluded from Supabase tiles
(they show up in the top-level Anthropic and OpenAI tiles via admin API).
