#!/usr/bin/env node
// api-dash — Standalone API spend dashboard
// Run: node server.js   or   npx api-dash

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

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
  google: {
    label: "Google AI",
    color: "#4285f4",
    keys: ["GOOGLE_API_KEY"],
    envHint: "GOOGLE_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
    dashboardUrl: "https://aistudio.google.com/billing",
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

async function fetchSupabaseCosts(provider, start, end) {
  if (!supabase) return null;

  try {
    // Query api_usage table
    const { data: usageRows, error: usageErr } = await supabase
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
      const { data, error } = await supabase
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
  const billingAccount = process.env.GOOGLE_BILLING_ACCOUNT || "011EAD-1507CF-B1940C";
  const accessToken = await getGoogleAccessToken();

  if (!accessToken) {
    console.log(`  [google] no service account configured, falling back to Supabase`);
    return await fetchSupabaseCosts("google", start, end);
  }

  try {
    const accountId = `billingAccounts/${billingAccount}`;
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

    // Try Cloud Billing report endpoint
    const reportUrl = `https://cloudbilling.googleapis.com/v1beta/${accountId}/reports:query`;
    const reportRes = await fetch(reportUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        dateRange: {
          startDate: { year: +start.slice(0, 4), month: +start.slice(5, 7), day: +start.slice(8, 10) },
          endDate: { year: +end.slice(0, 4), month: +end.slice(5, 7), day: +end.slice(8, 10) },
        },
        currencyCode: "USD",
      }),
    });

    if (reportRes.ok) {
      const data = await reportRes.json();
      console.log(`  [google] billing report response:`, JSON.stringify(data).slice(0, 500));

      const dailyMap = {};
      const byModel = {};
      let totalCost = 0;

      // Parse rows — structure varies by API version
      const rows = data.rows || data.costRows || data.results || [];
      for (const row of rows) {
        const costObj = row.cost || row.costAmount || {};
        const cost = parseFloat(typeof costObj === "object" ? (costObj.amount || costObj.nanos / 1e9 || "0") : costObj || "0");
        const dateObj = row.date || row.usageDate || {};
        const date = typeof dateObj === "object"
          ? `${dateObj.year}-${String(dateObj.month).padStart(2, "0")}-${String(dateObj.day).padStart(2, "0")}`
          : String(dateObj);
        const service = row.service?.description || row.serviceName || "Google AI";

        totalCost += cost;
        if (!byModel[service]) byModel[service] = { count: 0, cost: 0 };
        byModel[service].count += 1;
        byModel[service].cost += cost;
        if (date && date !== "undefined-0undefined-0undefined") {
          dailyMap[date] = (dailyMap[date] || 0) + cost;
        }
      }

      if (totalCost > 0) {
        const daily = Object.entries(dailyMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, cost]) => ({ date, cost: +cost.toFixed(4) }));
        console.log(`  ✓ google (billing API): $${totalCost.toFixed(2)}`);
        return { totalCost, byModel, daily, source: "api" };
      }
    } else {
      const errText = await reportRes.text().catch(() => "");
      console.warn(`  [google] billing report HTTP ${reportRes.status}: ${errText.slice(0, 300)}`);
    }

    // Fallback: try listing projects under the billing account for verification
    const projRes = await fetch(`https://cloudbilling.googleapis.com/v1/${accountId}/projects`, { headers });
    if (projRes.ok) {
      const projData = await projRes.json();
      const projects = projData.projectBillingInfo || [];
      console.log(`  [google] billing account has ${projects.length} projects: ${projects.map(p => p.projectId).join(", ")}`);
    } else {
      console.warn(`  [google] project list HTTP ${projRes.status}: ${(await projRes.text().catch(() => "")).slice(0, 200)}`);
    }

    console.log(`  [google] billing API returned no spend data, falling back to Supabase`);
    return await fetchSupabaseCosts("google", start, end);
  } catch (e) {
    console.warn(`  [google] billing error:`, e.message);
    return await fetchSupabaseCosts("google", start, end);
  }
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
          results[p] = await fetchers[p]();
          if (results[p]) {
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

const server = http.createServer((req, res) => {
  // API endpoint
  if (req.url === "/api/spend") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(latestData || { providers: [], grandTotal: 0, budget: BUDGET }));
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
