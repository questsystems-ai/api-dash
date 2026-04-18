#!/usr/bin/env python3
"""
api-dash demo data seeder
─────────────────────────
Creates a fake project repo with real-shaped spending data (anonymized).
All paths and names are generic — no personal identifiers.

Output structure:
  C:\demo-projects\
    my-app\
      spend.db       ← SQLite with api_usage records
      .env.local     ← fake API keys
  C:\demo-projects\gcp-billing.csv

Run: python scripts/demo/seed_demo_data.py
"""

import sqlite3
import os
import csv
import random
import argparse
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_OUT  = r"C:\demo-projects"
REPO_NAME    = "my-app"

FAKE_KEYS = {
    "ANTHROPIC_ADMIN_KEY":    "sk-ant-admin01-dEm0kEy1111111111111111111111111111111111111111AA",
    "OPENAI_ADMIN_KEY":       "sk-admin-dEm0kEy22222222222222222222222222222222222222222222222222",
    "REPLICATE_API_TOKEN":    "r8_dEm0kEy333333333333333333333333333333",
    "ELEVENLABS_API_KEY":     "sk_dEm0kEy4444444444444444444444444444444444444444",
    "FAL_KEY":                "dEm0-kEy5-5555-5555-5555-555555555555",
}

# ── Real spend data (anonymized) ──────────────────────────────────────────────
# Based on actual provider totals — no personal names, just the numbers.

# Providers logged in SQLite (no billing API): Gemini, Venice, WaveSpeed
# Mirroring the shape of real data: gemini ~$3.94 over 28 days
SQLITE_PROVIDERS = [
    {
        "provider": "google",
        "models": ["gemini-2.0-flash", "gemini-2.5-pro"],
        "daily_spend": {
            # Real daily pattern, anonymized
            "2026-03-25": 0.84, "2026-03-26": 0.79, "2026-03-29": 0.85,
            "2026-03-31": 0.26, "2026-04-01": 0.05, "2026-04-07": 0.41,
            "2026-04-11": 0.74,
        },
        "avg_calls_per_dollar": 8,
    },
    {
        "provider": "venice",
        "models": ["venice-uncensored", "llama-3.3-70b"],
        "daily_spend": {
            "2026-04-05": 0.12, "2026-04-08": 0.09, "2026-04-12": 0.18,
            "2026-04-15": 0.07,
        },
        "avg_calls_per_dollar": 20,
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def fake_timestamp(date_str, hour=None):
    h = hour if hour is not None else random.randint(8, 22)
    m, s = random.randint(0, 59), random.randint(0, 59)
    return f"{date_str}T{h:02d}:{m:02d}:{s:02d}Z"

def seed_sqlite(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS api_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            model TEXT,
            cost REAL DEFAULT 0,
            input_units INTEGER DEFAULT 0,
            output_units INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            project_slug TEXT
        )
    """)

    rows_inserted = 0
    for p in SQLITE_PROVIDERS:
        for date, day_total in p["daily_spend"].items():
            n_calls = max(1, int(day_total * p["avg_calls_per_dollar"]))
            per_call = day_total / n_calls
            model = random.choice(p["models"])
            for _ in range(n_calls):
                cost = round(per_call * random.uniform(0.7, 1.3), 6)
                c.execute(
                    "INSERT INTO api_usage (provider, model, cost, input_units, output_units, created_at, project_slug) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (p["provider"], model, cost,
                     random.randint(200, 4000), random.randint(50, 800),
                     fake_timestamp(date), REPO_NAME)
                )
                rows_inserted += 1

    conn.commit()
    conn.close()
    print(f"  ✓ spend.db: {rows_inserted} rows across {len(SQLITE_PROVIDERS)} providers")

def seed_env(env_path):
    os.makedirs(os.path.dirname(env_path), exist_ok=True)
    with open(env_path, "w") as f:
        f.write("# API keys for my-app (DEMO — not real keys)\n\n")
        for k, v in FAKE_KEYS.items():
            f.write(f"{k}={v}\n")
    print(f"  ✓ .env.local: {len(FAKE_KEYS)} fake keys")

def seed_gcp_csv(csv_path):
    """GCP billing CSV — real service cost shape, generic project name."""
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)

    # Real cost shape: Gemini API heavy, some Compute + Storage
    gcp_services = [
        ("Vertex AI API",    131.87),
        ("Compute Engine",    51.61),
        ("Cloud Storage",      3.21),
        ("Cloud Run",          1.44),
        ("Artifact Registry",  0.18),
    ]

    rows = [["Project Name", "Service", "SKU", "Start Date", "End Date", "Cost ($)", "Currency"]]
    start = "2026-04-01"
    end   = "2026-04-17"

    for service, total in gcp_services:
        # Spread across days with some noise
        days = 17
        per_day = total / days
        for i in range(days):
            date = (datetime(2026, 4, 1, tzinfo=timezone.utc) + timedelta(days=i)).strftime("%Y-%m-%d")
            cost = round(per_day * random.uniform(0.6, 1.4), 6)
            rows.append(["my-project", service, f"{service} usage", date, date, str(cost), "USD"])

    with open(csv_path, "w", newline="") as f:
        csv.writer(f).writerows(rows)

    total_all = sum(float(r[5]) for r in rows[1:])
    print(f"  ✓ gcp-billing.csv: {len(rows)-1} rows, ${total_all:.2f} total")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    repo_dir = os.path.join(args.out, REPO_NAME)
    print(f"\nSeeding demo data → {args.out}\n")

    seed_sqlite(os.path.join(repo_dir, "spend.db"))
    seed_env(os.path.join(repo_dir, ".env.local"))
    seed_gcp_csv(os.path.join(args.out, "gcp-billing.csv"))

    print(f"\nDone. Demo structure:")
    print(f"  {args.out}/")
    print(f"    {REPO_NAME}/spend.db")
    print(f"    {REPO_NAME}/.env.local")
    print(f"    gcp-billing.csv")

if __name__ == "__main__":
    main()
