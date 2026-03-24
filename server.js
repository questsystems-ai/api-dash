#!/usr/bin/env node
// api-dash — Standalone API spend dashboard
// Run: node server.js   or   npx api-dash

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { WebSocketServer } = require("ws");

function pickFolderDialog() {
  return new Promise((resolve) => {
    let cmd;
    if (process.platform === "win32") {
      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select project folder'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { '' }"`;
    } else if (process.platform === "darwin") {
      cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select project folder")'`;
    } else {
      cmd = `zenity --file-selection --directory --title="Select project folder" 2>/dev/null`;
    }
    exec(cmd, { timeout: 60000 }, (err, stdout) => {
      resolve(stdout.trim().replace(/[\r\n]+$/, "") || null);
    });
  });
}

// Load .env — prioritize local dir, then cwd (for drop-in-repo usage)
require("dotenv").config({ path: path.join(__dirname, ".env.local") });
require("dotenv").config({ path: path.join(__dirname, ".env") });
if (process.cwd() !== __dirname) {
  require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
}
// Also check parent repo root (when api-dash is nested inside a larger project)
// Use override:false so repo-root keys fill in gaps without clobbering local ones
const repoRoot = path.resolve(__dirname, "../..");
if (repoRoot !== __dirname && repoRoot !== process.cwd()) {
  const parsed = require("dotenv").config({ path: path.join(repoRoot, ".env.local") }).parsed || {};
  // Manually set any keys that are missing or empty
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

const { createClient } = require("@supabase/supabase-js");

const PORT = parseInt(process.env.PORT || "3737", 10);
const POLL_INTERVAL = 60_000; // refresh every 60s
const BUDGET = parseFloat(process.env.MONTHLY_BUDGET || "100");

// ── Provider result cache (slow billing APIs shouldn't be hit every 60s) ──────
const providerCache = {};
const PROVIDER_TTL = {
  default: 60 * 60 * 1000,  // 1 hour for all providers
};

function getCached(provider) {
  const entry = providerCache[provider];
  if (!entry) return null;
  const ttl = PROVIDER_TTL[provider] || PROVIDER_TTL.default;
  if (Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(provider, data) {
  providerCache[provider] = { ts: Date.now(), data };
}

// ── Key detection + management ────────────────────────────────────────────────

const KEY_PATTERNS = [
  { test: k => k.startsWith("sk-ant-admin"), envKey: "ANTHROPIC_ADMIN_KEY", provider: "anthropic", label: "Anthropic Admin Key" },
  { test: k => k.startsWith("sk-ant-"),      envKey: "ANTHROPIC_API_KEY",   provider: "anthropic", label: "Anthropic API Key",  llm: "anthropic" },
  { test: k => k.startsWith("sk-admin-"),    envKey: "OPENAI_ADMIN_KEY",    provider: "openai",    label: "OpenAI Admin Key" },
  { test: k => k.startsWith("sk-proj-"),     envKey: "OPENAI_API_KEY",      provider: "openai",    label: "OpenAI API Key",    llm: "openai" },
  { test: k => k.startsWith("gsk_"),         envKey: "GROQ_API_KEY",        provider: null,        label: "Groq API Key",      llm: "groq" },
  { test: k => k.startsWith("r8_"),          envKey: "REPLICATE_API_TOKEN", provider: "replicate", label: "Replicate Token" },
  { test: k => k.startsWith("VENICE_INFERENCE_KEY"), envKey: "VENICE_API_KEY", provider: "venice", label: "Venice API Key" },
  { test: k => k.startsWith("AIzaSy"),       envKey: "GOOGLE_API_KEY",      provider: "google",    label: "Google API Key",    llm: "google" },
  { test: k => k.startsWith("sk_") && k.length > 30 && !k.startsWith("sk-"), envKey: "ELEVENLABS_API_KEY", provider: "elevenlabs", label: "ElevenLabs Key" },
  { test: k => /^[0-9a-f]{8}-[0-9a-f]{4}/.test(k), envKey: "FAL_KEY",     provider: "fal",       label: "fal.ai Key" },
];

const LLM_PROVIDERS = {
  anthropic: { label: "Claude",  envKey: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6" },
  openai:    { label: "GPT-4o",  envKey: "OPENAI_API_KEY",    model: "gpt-4o-mini" },
  google:    { label: "Gemini",  envKey: "GOOGLE_API_KEY",    model: "gemini-1.5-flash" },
  groq:      { label: "Groq",    envKey: "GROQ_API_KEY",      model: "llama-3.1-8b-instant" },
};

function detectKey(key) {
  return KEY_PATTERNS.find(p => p.test(key)) || null;
}

function writeEnvKey(envKey, value) {
  const envPath = path.join(__dirname, ".env.local");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}
  const lines = content.split("\n");
  const idx = lines.findIndex(l => new RegExp(`^\\s*${envKey}\\s*=`).test(l));
  if (idx >= 0) lines[idx] = `${envKey}=${value}`;
  else lines.push(`${envKey}=${value}`);
  fs.writeFileSync(envPath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n");
  process.env[envKey] = value;
}

function getAvailableLLMs() {
  return Object.entries(LLM_PROVIDERS)
    .filter(([, p]) => !!process.env[p.envKey])
    .map(([id, p]) => ({ id, label: p.label, model: p.model }));
}

// ── Tracked repo Supabase cost tracking ──────────────────────────────────────

const GOOGLE_PROJECTS_FILE = path.join(__dirname, "google-projects.json");

function loadGoogleProjects() {
  try { return JSON.parse(fs.readFileSync(GOOGLE_PROJECTS_FILE, "utf8")); }
  catch { return []; }
}

function saveGoogleProjects(projects) {
  fs.writeFileSync(GOOGLE_PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function readRepoEnv(repoPath) {
  const vars = {};
  for (const name of [".env.local", ".env"]) {
    const filePath = path.join(repoPath, name);
    let content = "";
    try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !vars[m[1]]) vars[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
    break; // prefer .env.local
  }
  return vars;
}

async function checkGoogleProjectStatus(supabaseUrl, supabaseKey) {
  try {
    const client = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await client
      .from("api_usage")
      .select("id")
      .eq("provider", "google")
      .limit(1);
    if (error) {
      if (error.code === "42P01" || (error.message || "").includes("does not exist")) return "no_table";
      return "error";
    }
    return data && data.length > 0 ? "complete" : "no_rows";
  } catch { return "error"; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

async function callLLM(provider, messages, systemPrompt) {
  const def = LLM_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown LLM provider: ${provider}`);
  const key = process.env[def.envKey];
  if (!key) throw new Error(`${def.label} key not configured`);

  // Build content array for a message, including optional image attachment
  function buildContent(msg) {
    if (!msg.image) return msg.content;
    return [
      { type: "text", text: msg.content || " " },
      { type: "image", source: { type: "base64", media_type: msg.image.mimeType, data: msg.image.data } },
    ];
  }

  if (provider === "anthropic") {
    const apiMessages = messages.map(m => ({ role: m.role, content: buildContent(m) }));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: def.model, max_tokens: 1024, system: systemPrompt, messages: apiMessages }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.statusText);
    return d.content[0].text;
  }

  if (provider === "openai" || provider === "groq") {
    const base = provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
    const apiMessages = messages.map(m => {
      if (!m.image) return { role: m.role, content: m.content };
      return { role: m.role, content: [
        { type: "text", text: m.content || " " },
        { type: "image_url", image_url: { url: `data:${m.image.mimeType};base64,${m.image.data}` } },
      ]};
    });
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: def.model, messages: [{ role: "system", content: systemPrompt }, ...apiMessages] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.statusText);
    return d.choices[0].message.content;
  }

  if (provider === "google") {
    const apiMessages = messages.map(m => {
      const parts = m.content ? [{ text: m.content }] : [];
      if (m.image) parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${def.model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: apiMessages, systemInstruction: { parts: [{ text: systemPrompt }] } }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.statusText);
    return d.candidates[0].content.parts[0].text;
  }

  throw new Error(`No handler for provider: ${provider}`);
}

function buildSystemPrompt() {
  const spend = latestData ? latestData.providers.map(p =>
    `  - ${p.label}: $${p.totalCost.toFixed(2)} (30d)`
  ).join("\n") : "  (data loading)";
  const total = latestData ? `$${latestData.grandTotal.toFixed(2)}` : "unknown";
  const llms = getAvailableLLMs().map(l => l.label).join(", ") || "none";

  return `You are the api-dash co-pilot — a helpful assistant embedded in a real-time API spend dashboard.

## What api-dash is
A standalone Node.js dashboard (server.js + public/index.html) that monitors API spend across AI providers in real-time. Runs on localhost:3737. It polls provider billing APIs hourly, caches results, and streams updates to the browser via WebSocket. Radial gauges show each provider's billing-cycle spend vs a per-provider budget set in the UI and stored in localStorage.

## Current spend (live data)
Total: ${total}
${spend}

## Configured LLM providers for this co-pilot
${llms}

## Your role
- Help users add new API providers (explain what key to get, where to find it, what permissions are needed)
- Discuss spend trends and cost optimization strategies when asked
- Answer questions about how api-dash works
- Be concise — users are developers, not beginners
- When a user pastes a key in chat, remind them to use the key-paste tile instead (it writes it to .env.local automatically)

## Key patterns you know about
- sk-ant-admin → Anthropic Admin (for billing)
- sk-ant- → Anthropic API (for co-pilot)
- sk-admin- → OpenAI Admin (for billing)
- sk-proj- → OpenAI API (for co-pilot)
- r8_ → Replicate
- VENICE_INFERENCE_KEY → Venice
- AIzaSy → Google
- sk_ (long) → ElevenLabs
- UUID format → fal.ai
- gsk_ → Groq (co-pilot only, no billing API)

## Editing the dashboard code
You can modify the dashboard directly. The user can share the current code with you using the "Share code" buttons in the co-pilot toolbar.

When you want to make a change, return one or more edit blocks in this exact format:

\`\`\`edit
FILE: index.html
FIND:
exact text to find (must appear exactly once in the file)
REPLACE:
replacement text
\`\`\`

Rules:
- FILE must be either \`server.js\` or \`index.html\`
- FIND must match the existing code exactly (copy from what the user shared)
- You can return multiple edit blocks in one message for multi-part changes
- Keep FIND strings short but unique enough to match only once
- After the user applies an edit, the previous backup is preserved so they can always reset
- For UI changes (colors, layout, labels, adding sections) prefer editing \`index.html\`
- For new providers, polling logic, or API integrations, edit \`server.js\``;
}

// ── Supabase client (for providers without billing APIs) ─────────────────────

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ── Provider definitions ──────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    color: "#d4855a",
    keys: ["ANTHROPIC_ADMIN_KEY"],
    envHint: "ANTHROPIC_ADMIN_KEY",
    docsUrl: "https://console.anthropic.com/settings/admin-keys",
  },
  openai: {
    label: "OpenAI",
    color: "#10a37f",
    keys: ["OPENAI_ADMIN_KEY"],
    envHint: "OPENAI_ADMIN_KEY",
    docsUrl: "https://platform.openai.com/settings/organization/admin-keys",
  },
  fal: {
    label: "fal.ai",
    color: "#4ade80",
    keys: ["FAL_KEY"],
    envHint: "FAL_KEY",
    docsUrl: "https://fal.ai/dashboard/keys",
    dashboardUrl: "https://fal.ai/dashboard/billing",
  },
  elevenlabs: {
    label: "ElevenLabs",
    color: "#f59e0b",
    keys: ["ELEVENLABS_API_KEY"],
    envHint: "ELEVENLABS_API_KEY",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  replicate: {
    label: "Replicate",
    color: "#c084fc",
    keys: ["REPLICATE_API_TOKEN"],
    envHint: "REPLICATE_API_TOKEN",
    docsUrl: "https://replicate.com/account/api-tokens",
  },
};

function isConfigured(provider) {
  const def = PROVIDERS[provider];
  if (!def) return false;
  return def.keys.some((k) => !!process.env[k]);
}

// ── Provider fetchers (extracted from romantasy-v1) ───────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAnthropicCosts(start, end) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) return null;

  try {
    const startISO = `${start}T00:00:00Z`;
    const endISO = `${end}T23:59:59Z`;
    const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };

    const [costData, usageData] = await Promise.all([
      (async () => {
        const all = [];
        let nextPage = null;
        for (let page = 0; page < 5; page++) {
          const params = new URLSearchParams({ starting_at: startISO, ending_at: endISO, bucket_width: "1d" });
          if (nextPage) params.set("page", nextPage);
          const url = `https://api.anthropic.com/v1/organizations/cost_report?${params}`;
          let res;
          for (let attempt = 0; attempt < 3; attempt++) {
            res = await fetch(url, { headers });
            if (res.status !== 429) break;
            const wait = (attempt + 1) * 3000;
            console.log(`  [anthropic] cost_report 429 — retry in ${wait/1000}s (attempt ${attempt + 1}/3)`);
            await sleep(wait);
          }
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.warn(`  [anthropic] cost_report HTTP ${res.status}: ${body.slice(0, 200)}`);
            break;
          }
          const json = await res.json();
          console.log(`  [anthropic] cost_report page ${page}: ${(json.data || []).length} buckets, has_more=${json.has_more}`);
          all.push(...(json.data || []));
          if (!json.has_more) break;
          nextPage = json.next_page;
        }
        return all;
      })(),
      (async () => {
        const all = [];
        let nextPage = null;
        for (let page = 0; page < 5; page++) {
          const params = new URLSearchParams({ starting_at: startISO, ending_at: endISO, bucket_width: "1d" });
          params.append("group_by[]", "model");
          if (nextPage) params.set("page", nextPage);
          const res = await fetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`, { headers });
          if (!res.ok) break;
          const json = await res.json();
          all.push(...(json.data || []));
          if (!json.has_more) break;
          nextPage = json.next_page;
        }
        return all;
      })(),
    ]);

    const dailyMap = {};
    let totalCost = 0;
    for (const bucket of costData) {
      const date = bucket.starting_at?.slice(0, 10);
      for (const item of bucket.results || []) {
        const cost = parseFloat(item.amount || "0");
        totalCost += cost;
        if (date) dailyMap[date] = (dailyMap[date] || 0) + cost;
      }
    }

    const byModel = {};
    const pricing = {
      "claude-opus-4-5-20250514": { inp: 15, out: 75 },
      "claude-opus-4-6-20250610": { inp: 15, out: 75 },
      "claude-sonnet-4-5-20250929": { inp: 3, out: 15 },
      "claude-sonnet-4-20250514": { inp: 3, out: 15 },
      "claude-haiku-4-5-20251001": { inp: 0.8, out: 4 },
    };
    for (const bucket of usageData) {
      for (const item of bucket.results || []) {
        const model = item.model || "unknown";
        const inputTokens = (item.uncached_input_tokens || 0) + (item.cache_read_input_tokens || 0);
        const outputTokens = item.output_tokens || 0;
        if (!byModel[model]) byModel[model] = { count: 0, cost: 0 };
        byModel[model].count += inputTokens + outputTokens;
        const p = pricing[model] || { inp: 3, out: 15 };
        byModel[model].cost += (inputTokens * p.inp + outputTokens * p.out) / 1_000_000;
      }
    }

    // If cost_report was rate-limited (totalCost=0) but usage_report has data, use estimated total
    const byModelTotal = Object.values(byModel).reduce((s, m) => s + m.cost, 0);
    if (totalCost === 0 && byModelTotal > 0) {
      totalCost = byModelTotal;
    } else if (totalCost > 0 && byModelTotal > 0) {
      // Normalize byModel so breakdown sums to authoritative cost_report total
      const scale = totalCost / byModelTotal;
      for (const m of Object.values(byModel)) m.cost = m.cost * scale;
    }

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost: +cost.toFixed(6) }));

    return { totalCost, byModel, daily, source: "api" };
  } catch (e) {
    console.warn("[api-dash] Anthropic error:", e.message);
    return null;
  }
}

async function fetchOpenAICosts(start, end) {
  const adminKey = process.env.OPENAI_ADMIN_KEY;
  if (!adminKey) return null;

  try {
    const startUnix = Math.floor(new Date(start).getTime() / 1000);
    const endUnix = Math.floor(new Date(end + "T23:59:59Z").getTime() / 1000);

    const dailyMap = {};
    let totalCost = 0;
    let page = null;

    do {
      const params = new URLSearchParams({
        start_time: String(startUnix),
        end_time: String(endUnix),
        bucket_width: "1d",
      });
      if (page) params.set("page", page);

      const res = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      if (!res.ok) return null;
      const data = await res.json();

      for (const bucket of data.data || []) {
        const date = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
        for (const result of bucket.results || []) {
          const cost = parseFloat(result.amount?.value || "0");
          totalCost += cost;
          dailyMap[date] = (dailyMap[date] || 0) + cost;
        }
      }
      page = data.has_more ? data.next_page : null;
    } while (page);

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost: +cost.toFixed(6) }));

    return { totalCost, byModel: {}, daily, source: "api" };
  } catch {
    return null;
  }
}

async function fetchElevenLabsUsage(start, end) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;

  try {
    // Use character-stats endpoint (doesn't require user_read permission)
    const startUnix = new Date(start + "T00:00:00Z").getTime();
    const endUnix = new Date(end + "T23:59:59Z").getTime();
    const params = new URLSearchParams({
      start_unix: String(startUnix),
      end_unix: String(endUnix),
    });

    const res = await fetch(`https://api.elevenlabs.io/v1/usage/character-stats?${params}`, {
      headers: { "xi-api-key": key },
    });
    if (!res.ok) {
      console.warn(`[api-dash] ElevenLabs HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    const data = await res.json();

    // data.time = array of unix timestamps, data.usage = { "All": [counts...] }
    const times = data.time || [];
    const usageAll = data.usage?.All || [];

    const dailyMap = {};
    let totalChars = 0;
    for (let i = 0; i < times.length; i++) {
      const chars = usageAll[i] || 0;
      totalChars += chars;
      if (chars > 0) {
        const date = new Date(times[i]).toISOString().slice(0, 10);
        dailyMap[date] = (dailyMap[date] || 0) + chars;
      }
    }

    // Estimate cost: ~$0.30 per 1000 chars (Starter tier typical rate)
    const costPerChar = 0.0003;
    const estCost = totalChars * costPerChar;
    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, chars]) => ({ date, cost: +(chars * costPerChar).toFixed(4) }));

    return {
      totalCost: estCost,
      byModel: { tts: { count: totalChars, cost: estCost } },
      daily,
      source: "api",
      extra: { totalChars, costPerChar },
    };
  } catch (e) {
    console.warn("[api-dash] ElevenLabs error:", e.message);
    return null;
  }
}

// ── Supabase-based cost estimation (for providers without billing APIs) ──────

async function fetchSupabaseCosts(provider, start, end, clientOverride = null) {
  const client = clientOverride || supabase;
  if (!client) return null;

  try {
    // Query api_usage table
    const { data: usageRows, error: usageErr } = await client
      .from("api_usage")
      .select("model, cost, input_units, output_units, created_at")
      .eq("provider", provider)
      .gte("created_at", start + "T00:00:00Z")
      .lte("created_at", end + "T23:59:59.999Z")
      .order("created_at", { ascending: true });

    if (usageErr) {
      console.warn(`  [supabase] api_usage query error for ${provider}:`, usageErr.message);
    }

    // For fal.ai, also query the generations table (has model + cost per image/video gen)
    let genRows = [];
    if (provider === "fal") {
      const falModels = [
        "flux-pro", "flux-pro-ultra", "flux-dev", "ideogram-v3", "imagen4",
        "kling-2.1-pro", "kling-2.6-pro", "kling-3.0", "kling-3.0-pro", "kling-o1",
        "wan-2.2", "seedance-2.0", "pika-scenes",
      ];
      const { data, error } = await client
        .from("generations")
        .select("model, video_model, cost, type, created_at")
        .gte("created_at", start + "T00:00:00Z")
        .lte("created_at", end + "T23:59:59.999Z")
        .order("created_at", { ascending: true });

      if (error) {
        console.warn(`  [supabase] generations query error:`, error.message);
      } else {
        // Filter to fal.ai models (exclude replicate r- prefix, venice v- prefix, modal- prefix)
        genRows = (data || []).filter(r => {
          const m = r.type === "video" ? (r.video_model || "") : (r.model || "");
          return !m.startsWith("r-") && !m.startsWith("v-") && !m.startsWith("modal-") && !m.startsWith("edit-");
        });
      }
    }

    const byModel = {};
    const dailyMap = {};
    let totalCost = 0;

    // Process api_usage rows
    for (const r of (usageRows || [])) {
      const cost = parseFloat(r.cost || "0");
      const model = r.model || "unknown";
      totalCost += cost;
      if (!byModel[model]) byModel[model] = { count: 0, cost: 0 };
      byModel[model].count += 1;
      byModel[model].cost += cost;
      const date = (r.created_at || "").slice(0, 10);
      if (date) dailyMap[date] = (dailyMap[date] || 0) + cost;
    }

    // Process generations rows (avoid double-counting if also in api_usage)
    if (genRows.length > 0 && (!usageRows || usageRows.length === 0)) {
      for (const r of genRows) {
        const cost = parseFloat(r.cost || "0");
        const model = r.type === "video" ? (r.video_model || r.model || "unknown") : (r.model || "unknown");
        totalCost += cost;
        if (!byModel[model]) byModel[model] = { count: 0, cost: 0 };
        byModel[model].count += 1;
        byModel[model].cost += cost;
        const date = (r.created_at || "").slice(0, 10);
        if (date) dailyMap[date] = (dailyMap[date] || 0) + cost;
      }
    }

    if (totalCost === 0 && Object.keys(byModel).length === 0) return null;

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost: +cost.toFixed(4) }));

    console.log(`  ✓ ${provider} (supabase): $${totalCost.toFixed(2)} from ${(usageRows || []).length + genRows.length} records`);
    return { totalCost, byModel, daily, source: "supabase" };
  } catch (e) {
    console.warn(`  [supabase] ${provider} error:`, e.message);
    return null;
  }
}


// ── Google Cloud Billing API (service account JWT auth) ──────────────────────

const jwt = require("jsonwebtoken");

let _googleAccessToken = null;
let _googleTokenExpiry = 0;

async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !privateKey) return null;

  // Cache token for 50 minutes (tokens last 60)
  if (_googleAccessToken && Date.now() < _googleTokenExpiry) return _googleAccessToken;

  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: email,
      scope: "https://www.googleapis.com/auth/cloud-billing.readonly https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.warn(`  [google] OAuth token exchange failed: ${res.status} ${err.slice(0, 200)}`);
    return null;
  }

  const data = await res.json();
  _googleAccessToken = data.access_token;
  _googleTokenExpiry = Date.now() + 50 * 60 * 1000;
  return _googleAccessToken;
}

async function fetchGoogleBillingCosts(start, end) {
  // Google Cloud has no public REST API that returns actual spend data.
  // Costs are sourced from the Supabase api_usage table, where romantasy-v1
  // and other apps log Gemini API calls with provider = "google".
  return await fetchSupabaseCosts("google", start, end);
}

async function fetchReplicateCosts(start, end) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;

  try {
    const byModel = {};
    const dailyMap = {};
    let totalCost = 0;
    let nextUrl = "https://api.replicate.com/v1/predictions";
    let pages = 0;

    while (nextUrl && pages < 10) {
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      pages++;

      for (const pred of data.results || []) {
        const created = pred.created_at?.slice(0, 10);
        if (created && created < start) { nextUrl = null; break; }
        if (created && created > end) continue;
        if (pred.status !== "succeeded") continue;

        const predictTime = pred.metrics?.predict_time || 0;
        const costPerSec = 0.001150;
        const cost = predictTime * costPerSec;

        const model = pred.model || pred.version?.split(":")[0] || "unknown";
        if (!byModel[model]) byModel[model] = { count: 0, cost: 0 };
        byModel[model].count += 1;
        byModel[model].cost += cost;
        totalCost += cost;
        if (created) dailyMap[created] = (dailyMap[created] || 0) + cost;
      }

      nextUrl = data.next || null;
    }

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost: +cost.toFixed(6) }));

    return { totalCost, byModel, daily, source: "api" };
  } catch {
    return null;
  }
}

// ── Carbon Estimation ─────────────────────────────────────────────────────────
// GPU power: A100/H100 ~350W avg under inference load
// PUE: 1.2 (typical hyperscaler)
// Grid carbon: 0.233 kg CO2/kWh (US grid adjusted for ~40% renewables)
// These are order-of-magnitude estimates (±50%)

const GPU_WATTS = 350;
const PUE = 1.2;
const GRID_KG_PER_KWH = 0.233;

// Estimated GPU-seconds per dollar by provider type
const GPU_SEC_PER_DOLLAR = {
  anthropic: 180,    // LLM inference — high throughput, ~$20/hr GPU cost → ~180 GPU-sec/$
  openai: 180,       // similar to Anthropic
  fal: 600,          // image gen — cheaper GPU time per dollar
  replicate: 870,    // compute priced at ~$0.00115/GPU-sec
  elevenlabs: 100,   // TTS — lighter compute
  google: 200,       // Gemini inference
};

function estimateCarbon(provider, totalCost) {
  const gpuSecPerDollar = GPU_SEC_PER_DOLLAR[provider] || 300;
  const gpuSeconds = totalCost * gpuSecPerDollar;
  const energyKwh = (GPU_WATTS * gpuSeconds * PUE) / (1000 * 3600);
  const co2Grams = energyKwh * GRID_KG_PER_KWH * 1000;
  return {
    co2Grams: +co2Grams.toFixed(2),
    gpuSeconds: +gpuSeconds.toFixed(0),
    energyKwh: +energyKwh.toFixed(4),
  };
}

const CARBON_COMPARISONS = [
  { label: "Google searches",    gramsEach: 0.2,   icon: "search" },
  { label: "emails sent",        gramsEach: 0.3,   icon: "mail" },
  { label: "minutes of Netflix", gramsEach: 0.6,   icon: "tv" },
  { label: "cups of coffee",     gramsEach: 200,   icon: "coffee" },
  { label: "miles driven",       gramsEach: 251,   icon: "car" },
  { label: "hours of phone use", gramsEach: 8.9,   icon: "phone" },
];

function getBestComparison(totalGrams) {
  for (const comp of CARBON_COMPARISONS) {
    const equivalent = totalGrams / comp.gramsEach;
    if (equivalent >= 0.1 && equivalent <= 200) {
      const rounded = equivalent < 1 ? equivalent.toFixed(2)
        : equivalent < 10 ? equivalent.toFixed(1)
        : Math.round(equivalent).toString();
      return { text: `${rounded} ${comp.label}`, icon: comp.icon };
    }
  }
  return { text: `${(totalGrams / 0.2).toFixed(0)} Google searches`, icon: "search" };
}

// ── Aggregator ────────────────────────────────────────────────────────────────

async function fetchAllProviders() {
  const now = new Date();
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);
  const start = d30.toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);

  const configured = Object.keys(PROVIDERS).filter(isConfigured);

  const fetchers = {
    anthropic: () => fetchAnthropicCosts(start, end),
    openai: () => fetchOpenAICosts(start, end),
    elevenlabs: () => fetchElevenLabsUsage(start, end),
    replicate: () => fetchReplicateCosts(start, end),
    fal: () => fetchSupabaseCosts("fal", start, end),
    google: () => fetchGoogleBillingCosts(start, end),
  };

  const results = {};
  await Promise.all(
    configured.map(async (p) => {
      if (fetchers[p]) {
        try {
          const cached = getCached(p);
          if (cached) {
            results[p] = cached;
            console.log(`  ✓ ${p}: $${cached.totalCost.toFixed(2)} (cached)`);
            return;
          }
          results[p] = await fetchers[p]();
          if (results[p]) {
            setCache(p, results[p]);
            console.log(`  ✓ ${p}: $${results[p].totalCost.toFixed(2)}`);
          } else {
            console.log(`  ✗ ${p}: no data (fetcher returned null)`);
          }
        } catch (e) {
          console.warn(`  ✗ ${p} error:`, e.message);
          results[p] = null;
        }
      } else {
        const def = PROVIDERS[p];
        if (def.noBillingApi) {
          console.log(`  - ${p}: no billing API (check ${def.dashboardUrl || "provider dashboard"})`);
        } else {
          console.log(`  - ${p}: no fetcher (display only)`);
        }
      }
    })
  );

  const providers = configured.map((p) => {
    const def = PROVIDERS[p];
    const data = results[p];
    const totalCost = data?.totalCost || 0;
    return {
      id: p,
      label: def.label,
      color: def.color,
      totalCost,
      byModel: data?.byModel || {},
      daily: data?.daily || [],
      extra: data?.extra || null,
      source: data?.source || "none",
      carbon: estimateCarbon(p, totalCost),
      noBillingApi: def.noBillingApi || false,
      dashboardUrl: def.dashboardUrl || null,
    };
  });

  // Project Supabase tracking — one tile per provider found in api_usage
  // Providers already covered by dedicated billing API tiles — skip to avoid double-counting
  const SUPABASE_SKIP = new Set(["anthropic", "openai", "fal", "fal.ai", "elevenlabs", "replicate"]);

  const SUPABASE_PROVIDER_META = {
    google:     { label: "Gemini",    color: "#4285f4" },
    "azure-tts":{ label: "Azure TTS", color: "#0078d4" },
    venice:     { label: "Venice",    color: "#7c3aed" },
    wavespeed:  { label: "WaveSpeed", color: "#06b6d4" },
    akool:      { label: "Akool",     color: "#f97316" },
    piapi:      { label: "PiAPI",     color: "#ec4899" },
    modal:      { label: "Modal",     color: "#6366f1" },
  };

  const googleProjects = loadGoogleProjects();
  await Promise.all(googleProjects.map(async (project) => {
    if (!project.supabaseUrl || !project.supabaseKey) return;
    const projectClient = createClient(project.supabaseUrl, project.supabaseKey);

    // Discover which providers have rows in this project's api_usage table
    const discoverKey = `gp_${project.slug}_providers`;
    let knownProviders = getCached(discoverKey);
    if (!knownProviders) {
      try {
        const { data: rows } = await projectClient
          .from("api_usage").select("provider").gte("created_at", start + "T00:00:00Z");
        const distinct = [...new Set((rows || []).map(r => r.provider).filter(Boolean))];
        // Always include google so the tile appears even before first log
        if (!distinct.includes("google")) distinct.push("google");
        knownProviders = distinct;
        setCache(discoverKey, knownProviders);
      } catch { knownProviders = ["google"]; }
    }

    await Promise.all(knownProviders.filter(p => !SUPABASE_SKIP.has(p)).map(async (provider) => {
      const cacheKey = `gp_${project.slug}_${provider}`;
      let data = getCached(cacheKey);
      if (!data) {
        data = await fetchSupabaseCosts(provider, start, end, projectClient);
        if (!data) data = { totalCost: 0, byModel: {}, daily: [], source: "supabase" };
        setCache(cacheKey, data);
      }
      const meta = SUPABASE_PROVIDER_META[provider] || { label: provider, color: "#888" };
      providers.push({
        id: `gp_${project.slug}_${provider}`,
        label: `${project.title} / ${meta.label}`,
        color: meta.color,
        totalCost: data.totalCost,
        byModel: data.byModel || {},
        daily: data.daily || [],
        extra: null,
        source: data.source || "supabase",
        carbon: estimateCarbon(provider, data.totalCost),
        noBillingApi: false,
        dashboardUrl: null,
        isGoogleProject: true,
        projectSlug: project.slug,
      });
    }));
  }));

  const grandTotal = providers.reduce((s, p) => s + p.totalCost, 0);
  const totalCarbon = providers.reduce((s, p) => s + p.carbon.co2Grams, 0);
  const totalGpuSeconds = providers.reduce((s, p) => s + p.carbon.gpuSeconds, 0);
  const totalEnergyKwh = providers.reduce((s, p) => s + p.carbon.energyKwh, 0);
  const carbonComparison = getBestComparison(totalCarbon);

  // Build cumulative
  const allDates = new Set();
  providers.forEach((p) => p.daily.forEach((d) => allDates.add(d.date)));
  const sortedDates = [...allDates].sort();

  let cum = 0;
  const cumulative = sortedDates.map((date) => {
    let dayCost = 0;
    for (const p of providers) {
      const found = p.daily.find((d) => d.date === date);
      if (found) dayCost += found.cost;
    }
    cum += dayCost;
    return { date, dayCost: +dayCost.toFixed(4), cumulative: +cum.toFixed(4) };
  });

  // Unconfigured providers — for the "add provider" UI
  const unconfigured = Object.entries(PROVIDERS)
    .filter(([id]) => !configured.includes(id))
    .map(([id, def]) => ({
      id,
      label: def.label,
      color: def.color,
      envHint: def.envHint,
      docsUrl: def.docsUrl,
    }));

  return {
    providers: providers.sort((a, b) => b.totalCost - a.totalCost),
    unconfigured,
    grandTotal: +grandTotal.toFixed(4),
    budget: BUDGET,
    budgetPct: +((grandTotal / BUDGET) * 100).toFixed(1),
    cumulative,
    carbon: {
      co2Grams: +totalCarbon.toFixed(2),
      gpuSeconds: totalGpuSeconds,
      energyKwh: +totalEnergyKwh.toFixed(4),
      comparison: carbonComparison,
      methodology: "GPU ~350W, PUE 1.2, grid 0.233 kg/kWh (US avg adjusted for renewables). ±50% estimates.",
    },
    dateRange: { start, end },
    fetchedAt: new Date().toISOString(),
  };
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

let latestData = null;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  // API endpoint
  if (req.url === "/api/spend") {
    res.writeHead(200, cors);
    res.end(JSON.stringify(latestData || { providers: [], grandTotal: 0, budget: BUDGET }));
    return;
  }

  if (req.url === "/api/config" && req.method === "GET") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      llms: getAvailableLLMs(),
      firstBoot: getAvailableLLMs().length === 0 && Object.keys(PROVIDERS).filter(isConfigured).length === 0,
    }));
    return;
  }

  if (req.url === "/api/keys" && req.method === "POST") {
    const body = await readBody(req);
    const key = (body.key || "").trim();
    if (!key) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "No key provided" })); return; }
    const match = detectKey(key);
    if (!match) { res.writeHead(422, cors); res.end(JSON.stringify({ error: "Unrecognized key format" })); return; }
    writeEnvKey(match.envKey, key);
    if (match.provider) delete providerCache[match.provider];
    refresh();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ envKey: match.envKey, provider: match.provider, label: match.label, llm: match.llm || null }));
    return;
  }

  if (req.url.startsWith("/api/google-projects/") && req.method === "DELETE") {
    const slug = req.url.slice("/api/google-projects/".length);
    saveGoogleProjects(loadGoogleProjects().filter(p => p.slug !== slug));
    // Clear all cache keys for this project (one per provider + the discovery key)
    for (const key of Object.keys(providerCache)) {
      if (key.startsWith(`gp_${slug}`)) delete providerCache[key];
    }
    refresh();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/google-projects" && req.method === "GET") {
    res.writeHead(200, cors);
    res.end(JSON.stringify(loadGoogleProjects()));
    return;
  }

  if (req.url === "/api/google-projects" && req.method === "POST") {
    const body = await readBody(req);
    const { title, repoPath } = body;
    if (!title || !repoPath) {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: "title and repoPath required" }));
      return;
    }

    const envVars = readRepoEnv(repoPath);
    const sbUrl = envVars.SUPABASE_URL || envVars.NEXT_PUBLIC_SUPABASE_URL || "";
    const sbKey = envVars.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!sbUrl || !sbKey) {
      res.writeHead(422, cors);
      res.end(JSON.stringify({
        error: "No Supabase credentials found",
        hint: `Looked for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${repoPath}/.env.local`,
        found: Object.keys(envVars).filter(k => k.includes("SUPABASE")),
      }));
      return;
    }

    const status = await checkGoogleProjectStatus(sbUrl, sbKey);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

    // Save the project whenever Supabase is reachable (complete or no_rows — tile shows $0 until data flows)
    if (status === "complete" || status === "no_rows") {
      const projects = loadGoogleProjects();
      if (!projects.find(p => p.slug === slug)) {
        projects.push({ slug, title, repoPath, supabaseUrl: sbUrl, supabaseKey: sbKey });
        saveGoogleProjects(projects);
        refresh();
      }
    }

    const CREATE_TABLE_SQL = `create table if not exists api_usage (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  provider text not null,
  model text,
  endpoint text,
  input_units integer default 0,
  output_units integer default 0,
  cost numeric(10, 6) default 0,
  user_id text,
  metadata jsonb default '{}'
);`;

    const LOGGER_SNIPPET = `// Add after each Gemini generateContent() call:
const result = await model.generateContent(prompt);
const usage = result.response.usageMetadata;

const pricing = {
  "gemini-2.5-pro":   { input: 1.25,  output: 10.0 },
  "gemini-2.5-flash": { input: 0.15,  output: 0.60 },
  "gemini-2.0-flash": { input: 0.10,  output: 0.40 },
};
const p = pricing[modelName] ?? { input: 1.25, output: 10.0 };
const cost = (usage.promptTokenCount * p.input + usage.candidatesTokenCount * p.output) / 1_000_000;

// fire-and-forget
supabase.from("api_usage").insert({
  provider: "google", model: modelName,
  input_units: usage.promptTokenCount,
  output_units: usage.candidatesTokenCount,
  cost,
}).then(() => {}).catch(() => {});`;

    res.writeHead(200, cors);
    res.end(JSON.stringify({
      status,
      title,
      slug,
      saved: status === "complete",
      sql: status === "no_table" ? CREATE_TABLE_SQL : null,
      snippet: status === "no_rows" ? LOGGER_SNIPPET : null,
    }));
    return;
  }

  // ── Dashboard code editing ─────────────────────────────────────────────────

  const EDITABLE_FILES = {
    "server.js":  path.join(__dirname, "server.js"),
    "index.html": path.join(__dirname, "public", "index.html"),
  };

  if (req.url.startsWith("/api/file") && req.method === "GET") {
    const name = new URL(req.url, "http://x").searchParams.get("name");
    const filePath = EDITABLE_FILES[name];
    if (!filePath) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown file" })); return; }
    const content = fs.readFileSync(filePath, "utf8");
    const bakPath = filePath + ".bak";
    const hasBak = fs.existsSync(bakPath);
    res.writeHead(200, cors);
    res.end(JSON.stringify({ name, content, hasBak }));
    return;
  }

  if (req.url === "/api/file" && req.method === "POST") {
    const body = await readBody(req);
    const { name, find, replace, content } = body;
    const filePath = EDITABLE_FILES[name];
    if (!filePath) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown file" })); return; }

    const bakPath = filePath + ".bak";
    const current = fs.readFileSync(filePath, "utf8");

    // Create backup on first edit only
    if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, current);

    let next;
    if (content !== undefined) {
      // Full replace
      next = content;
    } else if (find !== undefined && replace !== undefined) {
      if (!current.includes(find)) {
        res.writeHead(422, cors);
        res.end(JSON.stringify({ error: "FIND string not found in file — check the text matches exactly" }));
        return;
      }
      // Only replace first occurrence
      next = current.replace(find, replace);
    } else {
      res.writeHead(400, cors); res.end(JSON.stringify({ error: "Provide content or find+replace" })); return;
    }

    fs.writeFileSync(filePath, next);
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, hasBak: true }));
    return;
  }

  if (req.url === "/api/file/reset" && req.method === "POST") {
    const body = await readBody(req);
    const { name } = body;
    const filePath = EDITABLE_FILES[name];
    if (!filePath) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown file" })); return; }
    const bakPath = filePath + ".bak";
    if (!fs.existsSync(bakPath)) { res.writeHead(404, cors); res.end(JSON.stringify({ error: "No backup found" })); return; }
    fs.writeFileSync(filePath, fs.readFileSync(bakPath, "utf8"));
    fs.unlinkSync(bakPath);
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/file/bak-status" && req.method === "GET") {
    const status = {};
    for (const [name, filePath] of Object.entries(EDITABLE_FILES)) {
      status[name] = fs.existsSync(filePath + ".bak");
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify(status));
    return;
  }

  if (req.url === "/api/pick-folder" && req.method === "GET") {
    const folderPath = await pickFolderDialog();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ path: folderPath || null }));
    return;
  }

  if (req.url === "/api/scan-folder" && req.method === "POST") {
    const body = await readBody(req);
    const { folderPath } = body;
    if (!folderPath) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "folderPath required" })); return; }
    const envVars = readRepoEnv(folderPath);
    const folderName = path.basename(folderPath);
    const detected = [];
    for (const [k, v] of Object.entries(envVars)) {
      if (!v) continue;
      const match = detectKey(v);
      if (match) {
        detected.push({ envKey: match.envKey, label: match.label, provider: match.provider || null, llm: match.llm || null, value: v });
      }
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify({ folderName, folderPath, detected }));
    return;
  }

  if (req.url === "/api/scan-supabase-projects" && req.method === "POST") {
    const body = await readBody(req);
    const { parentPath } = body;
    if (!parentPath) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "parentPath required" })); return; }

    let entries;
    try { entries = fs.readdirSync(parentPath, { withFileTypes: true }); }
    catch (e) { res.writeHead(422, cors); res.end(JSON.stringify({ error: "Cannot read folder: " + e.message })); return; }

    const existing = new Set(loadGoogleProjects().map(p => p.slug));
    const found = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subPath = path.join(parentPath, entry.name);
      const envVars = readRepoEnv(subPath);
      const sbUrl = envVars.SUPABASE_URL || envVars.NEXT_PUBLIC_SUPABASE_URL || "";
      const sbKey = envVars.SUPABASE_SERVICE_ROLE_KEY || "";
      if (!sbUrl || !sbKey) continue;
      const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      found.push({
        name: entry.name,
        slug,
        path: subPath,
        supabaseUrl: sbUrl,
        supabaseKey: sbKey,
        alreadyAdded: existing.has(slug),
      });
    }

    res.writeHead(200, cors);
    res.end(JSON.stringify({ parentPath, found }));
    return;
  }

  if (req.url === "/api/copilot" && req.method === "POST") {
    const body = await readBody(req);
    const { messages, provider } = body;
    if (!messages || !provider) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Missing messages or provider" })); return; }
    try {
      const reply = await callLLM(provider, messages, buildSystemPrompt());
      res.writeHead(200, cors);
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500, cors);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let filePath = req.url === "/" ? "/index.html" : req.url;
  // Prevent path traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(__dirname, "public", filePath);
  const ext = path.extname(fullPath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

async function refresh() {
  try {
    console.log("[api-dash] Fetching provider data...");
    latestData = await fetchAllProviders();
    console.log(`[api-dash] Grand total: $${latestData.grandTotal} across ${latestData.providers.length} providers`);
    broadcast(latestData);
  } catch (e) {
    console.error("[api-dash] Refresh error:", e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║     api-dash · API Spend Monitor  ║`);
  console.log(`  ╠══════════════════════════════════╣`);
  console.log(`  ║  ${url.padEnd(30)}  ║`);
  console.log(`  ║  Budget: $${BUDGET.toFixed(0).padEnd(22)}  ║`);
  console.log(`  ║  Refresh: ${(POLL_INTERVAL / 1000)}s${" ".repeat(20)}  ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);

  const configured = Object.keys(PROVIDERS).filter(isConfigured);
  if (configured.length === 0) {
    console.log("  ⚠  No provider keys found. Copy .env.example to .env and add your keys.\n");
  } else {
    console.log(`  Providers: ${configured.map((p) => PROVIDERS[p].label).join(", ")}\n`);
  }

  // Auto-open browser
  if (process.argv.includes("--open")) {
    const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    require("child_process").exec(`${opener} ${url}`);
  }

  // Initial fetch + polling
  refresh();
  setInterval(refresh, POLL_INTERVAL);
});
