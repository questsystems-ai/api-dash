#!/usr/bin/env python3
"""
api-dash demo automation script
────────────────────────────────
Drives the browser through the full onboarding + feature walkthrough
using Playwright. Run this while screen-recording for the YouTube video.

Prerequisites:
  pip install playwright
  playwright install chromium

Usage:
  # 1. Seed demo data first:
  python scripts/demo/seed_demo_data.py

  # 2. Start the dev server (in a separate terminal):
  npm start

  # 3. Run the demo (start your screen recorder first):
  python scripts/demo/run_demo.py

  # With custom demo repo path:
  python scripts/demo/run_demo.py --repo ~/api-dash-demo

Timing: ~4 minutes total. Each PAUSE constant controls pacing.
For a faster run: python run_demo.py --fast
"""

import asyncio
import argparse
import os
import sys
import time
import json
from pathlib import Path

try:
    from playwright.async_api import async_playwright, expect
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

# ── Timing (seconds) ──────────────────────────────────────────────────────────

PAUSE_SHORT  = 0.8   # brief beat between actions
PAUSE_MED    = 1.2   # let the UI settle / animate
PAUSE_LONG   = 2.0   # hold on a feature so the viewer can absorb it
PAUSE_READ   = 2.8   # hold on text the viewer needs to read

BASE_URL     = "http://localhost:3737"
DEMO_REPO    = r"C:\demo-projects\my-app"
AUDIO_DIR    = Path(__file__).parent / "audio"

# Scene → target duration in seconds, loaded from narration audio files
SCENE_DURATIONS: dict[int, float] = {}

def load_scene_durations():
    """Read actual audio file durations so we can pace the demo to match."""
    manifest_path = AUDIO_DIR / "manifest.json"
    if not manifest_path.exists():
        return
    try:
        import subprocess
        manifest = json.loads(manifest_path.read_text())
        for num_str, audio_path in manifest.items():
            r = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", audio_path],
                capture_output=True, text=True
            )
            data = json.loads(r.stdout)
            SCENE_DURATIONS[int(num_str)] = float(data["format"]["duration"])
        total = sum(SCENE_DURATIONS.values())
        print(f"  Narration durations loaded: {len(SCENE_DURATIONS)} scenes, {total:.0f}s total")
    except Exception as e:
        print(f"  ! Could not load scene durations: {e}")

def scene_budget(scene_num: int, fallback: float = 30.0) -> float:
    """Return the narration duration for a scene — used to pace pauses."""
    return SCENE_DURATIONS.get(scene_num, fallback)

# ── Helpers ───────────────────────────────────────────────────────────────────

async def wait(seconds: float):
    """Pause with a console countdown."""
    if seconds <= 0:
        return
    print(f"  ... waiting {seconds:.1f}s", end="\r")
    await asyncio.sleep(seconds)
    print(" " * 40, end="\r")

async def scroll_to(page, selector: str):
    """Scroll an element into view."""
    try:
        await page.locator(selector).first.scroll_into_view_if_needed(timeout=2000)
        await wait(PAUSE_SHORT)
    except Exception:
        pass

def _pulse_style(color: str) -> str:
    """Return the CSS keyframe block for pulse animations."""
    glow = color + "55"
    return (
        f"@keyframes _apidashPulse {{"
        f"0%   {{ outline: 3px solid {color}; outline-offset: 2px; box-shadow: 0 0 6px 2px {glow}; }}"
        f"50%  {{ outline: 4px solid {color}; outline-offset: 6px; box-shadow: 0 0 28px 10px {glow}; }}"
        f"100% {{ outline: 3px solid {color}; outline-offset: 2px; box-shadow: 0 0 6px 2px {glow}; }}"
        f"}}"
    )

_PULSE_JS = """(el, args) => {
    const sid = '__pulse_style__';
    if (!document.getElementById(sid)) {
        const s = document.createElement('style');
        s.id = sid;
        s.textContent = args.style;
        document.head.appendChild(s);
    }
    el.style.animation = '_apidashPulse 0.75s ease-in-out infinite';
    el.style.position = el.style.position || 'relative';
    el.style.zIndex = '50';
    setTimeout(() => {
        el.style.animation = '';
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.style.zIndex = '';
    }, args.ms);
}"""

async def pulse(page, selector: str, color: str = "#00ff88", duration_s: float = 2.5, scroll: bool = False):
    """Pulsing glow outline. Uses Playwright locator so :has-text() pseudo-selectors work."""
    loc = page.locator(selector).first
    if scroll:
        try:
            await loc.scroll_into_view_if_needed(timeout=2000)
            await asyncio.sleep(0.4)
        except Exception:
            pass
    try:
        if await loc.count() == 0:
            return
        await loc.evaluate(_PULSE_JS, {"style": _pulse_style(color), "ms": int(duration_s * 1000)})
    except Exception:
        pass

async def pulse_many(page, selector: str, color: str = "#00ff88", duration_s: float = 2.5, scroll: bool = False):
    """Pulse all matching elements simultaneously."""
    try:
        locs = await page.locator(selector).all()
        if not locs:
            return
        args = {"style": _pulse_style(color), "ms": int(duration_s * 1000)}
        for loc in locs:
            try:
                await loc.evaluate(_PULSE_JS, args)
            except Exception:
                pass
    except Exception:
        pass

async def zoom_flash(page, selector: str, scale: float = 1.08, duration_s: float = 0.6):
    """Quick scale-up pop on an element."""
    ms = int(duration_s * 500)
    try:
        loc = page.locator(selector).first
        if await loc.count() == 0:
            return
        await loc.evaluate("""(el, args) => {
            el.style.transition = `transform ${args.ms}ms cubic-bezier(.34,1.56,.64,1)`;
            el.style.transform = `scale(${args.scale})`;
            el.style.transformOrigin = 'center center';
            el.style.position = el.style.position || 'relative';
            el.style.zIndex = '60';
            setTimeout(() => {
                el.style.transform = 'scale(1)';
                setTimeout(() => { el.style.transition = ''; el.style.zIndex = ''; }, args.ms);
            }, args.ms);
        }""", {"ms": ms, "scale": scale})
    except Exception:
        pass

async def move_to(page, selector: str):
    """Move the mouse cursor to the center of an element."""
    el = page.locator(selector).first
    if await el.count() > 0:
        box = await el.bounding_box()
        if box:
            await page.mouse.move(
                box["x"] + box["width"] / 2,
                box["y"] + box["height"] / 2,
                steps=20,
            )

async def move_to_nth(page, selector: str, n: int):
    """Move cursor to the nth matching element."""
    els = page.locator(selector)
    if await els.count() > n:
        box = await els.nth(n).bounding_box()
        if box:
            await page.mouse.move(
                box["x"] + box["width"] / 2,
                box["y"] + box["height"] / 2,
                steps=15,
            )

async def type_slow(page, selector: str, text: str, delay: int = 60):
    """Type text with a human-like delay."""
    await page.locator(selector).click()
    await page.locator(selector).type(text, delay=delay)

def b(scene_num: int, fraction: float) -> float:
    """Return budget_seconds * fraction — for proportional beat timing."""
    return scene_budget(scene_num) * fraction

# ── Demo scenes ───────────────────────────────────────────────────────────────

async def scene_first_launch(page):
    """Scene 2: First-launch data folder setup."""
    print("\n[Scene 2] First launch — data folder setup")
    N = 2

    # Let the modal render, then pulse it to draw attention
    await wait(b(N, 0.15))
    await pulse(page, "#dataFolderModal .modal, #dataFolderModal", "#4ade80", duration_s=b(N, 0.25))
    await wait(b(N, 0.20))

    # Move cursor to the path input and type the demo path
    await move_to(page, "#dataFolderPath")
    folder_input = page.locator("#dataFolderPath")
    await folder_input.fill("")
    await folder_input.type(DEMO_REPO, delay=45)
    await wait(b(N, 0.10))

    # Pulse the Let's go button then click it
    await pulse(page, "#dataFolderBtn", "#4ade80", duration_s=b(N, 0.15))
    await move_to(page, "#dataFolderBtn")
    await wait(b(N, 0.08))
    await page.locator("#dataFolderBtn").click()

    # Wait for modal to close — force-remove it if the server rejects the path
    try:
        await page.wait_for_selector("#dataFolderModal", state="detached", timeout=8000)
    except Exception:
        print("  ! modal didn't close naturally — force removing")
        await page.evaluate("""
            const m = document.getElementById('dataFolderModal');
            if (m) m.style.display = 'none';
        """)
        await asyncio.sleep(0.4)
    print("  ✓ data folder set")


async def scene_dashboard_overview(page):
    """Scene 3: The main dashboard — provider tiles."""
    print("\n[Scene 3] Dashboard overview")
    N = 3
    await page.wait_for_selector(".gauge-card", timeout=15000)

    # "Boom" — brief hold then zoom the whole header
    await wait(b(N, 0.06))
    await zoom_flash(page, "#grandTotal, .grand-total, h1", scale=1.06)
    await wait(b(N, 0.06))

    # Sweep cursor L→R across the visible tiles
    tiles = page.locator(".gauge-card")
    tile_count = await tiles.count()
    print(f"  → {tile_count} provider tiles")
    for i in range(min(tile_count, 6)):
        await move_to_nth(page, ".gauge-card", i)
        await wait(b(N, 0.05))

    # Pulse the grand total ("Grand total top right")
    await pulse(page, "#grandTotal, .total-spend, .grand-total", "#facc15", duration_s=b(N, 0.18))
    await zoom_flash(page, "#grandTotal, .total-spend, .grand-total")
    await wait(b(N, 0.14))

    # Pulse the budget bar (red — "yeah, we'll talk about that")
    await pulse(page, "#budgetBar, .budget-bar, .budget-progress", "#f87171", duration_s=b(N, 0.12))
    await wait(b(N, 0.10))

    # Scroll down to show the daily spend chart
    await page.evaluate("window.scrollTo({top: 800, behavior: 'smooth'})")
    await wait(b(N, 0.14))

    # Pulse the chart — no extra scroll, we just scrolled there
    await pulse(page, "#spendChart, canvas, .chart-container", "#4ade80", duration_s=b(N, 0.18))
    await wait(b(N, 0.16))

    # Scroll back to very top
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.10))


async def scene_provider_tile_detail(page):
    """Scene 4: Click a provider tile to expand it."""
    print("\n[Scene 4] Provider tile detail")
    N = 4

    # Move to first tile then click
    await move_to(page, ".gauge-card")
    await wait(b(N, 0.08))
    first_tile = page.locator(".gauge-card").first
    await first_tile.click()
    await wait(b(N, 0.12))

    # Ensure tile is in view, then pulse the whole expanded card
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.08))

    # Pulse model rows — scroll=False, we're already at the top
    model_rows = page.locator(".model-row, .model-breakdown li, .model-line")
    row_count = await model_rows.count()
    if row_count > 0:
        for i in range(min(row_count, 3)):
            await move_to_nth(page, ".model-row, .model-breakdown li, .model-line", i)
            await pulse(page, f".model-row:nth-child({i+1}), .model-breakdown li:nth-child({i+1})", "#4ade80", duration_s=b(N, 0.12), scroll=False)
            await wait(b(N, 0.09))
    else:
        await pulse(page, ".gauge-card:first-child", "#4ade80", duration_s=b(N, 0.30), scroll=False)
        await wait(b(N, 0.22))

    # Pulse the bar chart inside the tile — no extra scroll
    await pulse(page, ".detail-chart, .bar-chart, .daily-chart, .gauge-card canvas", "#facc15", duration_s=b(N, 0.18), scroll=False)
    await wait(b(N, 0.12))

    # Click again to close
    await move_to(page, ".gauge-card")
    await first_tile.click()
    await wait(b(N, 0.06))


async def scene_add_repo(page, demo_repo: str):
    """Scene 7: Add Repo — SQLite tracking (show modal + FAQ accordion)."""
    print("\n[Scene 7] Add Repo — SQLite tracking")
    N = 7

    # Scroll to Add Repo card
    await page.evaluate("window.scrollTo({top: 400, behavior: 'smooth'})")
    await wait(b(N, 0.06))
    await page.evaluate("document.querySelector('.add-repo-card')?.scrollIntoView({behavior:'smooth',block:'center'})")
    await wait(b(N, 0.06))

    # Pulse it
    await pulse(page, ".add-repo-card", "#4ade80", duration_s=b(N, 0.16))
    await move_to(page, ".add-repo-card")
    await wait(b(N, 0.10))

    add_repo_btn = page.locator(".add-repo-card").first
    await add_repo_btn.click()
    await wait(b(N, 0.10))

    # Modal opens
    try:
        await page.wait_for_selector("#addRepoModal", state="visible", timeout=5000)
    except Exception:
        print("  ! addRepoModal not found — skipping")
        return

    # Pulse the modal
    await pulse(page, "#addRepoModal .modal, #addRepoModal", "#4ade80", duration_s=b(N, 0.16))
    await wait(b(N, 0.12))

    # Expand the FAQ accordion ("No accounts. No cloud. Just a file.")
    faq = page.locator("#addRepoModal [data-toggle], #addRepoModal details, #addRepoModal .accordion-toggle, #addRepoModal summary")
    if await faq.count() > 0:
        await move_to(page, "#addRepoModal [data-toggle], #addRepoModal details, #addRepoModal summary")
        await faq.first.click()
        await wait(b(N, 0.14))

    # Highlight the Browse button
    browse_btn = page.locator("#addRepoModal button:has-text('Browse'), #addRepoModal button:has-text('folder')")
    if await browse_btn.count() > 0:
        await move_to(page, "#addRepoModal button:has-text('Browse'), #addRepoModal button:has-text('folder')")
        await pulse(page, "#addRepoModal button:has-text('Browse'), #addRepoModal button", "#facc15", duration_s=b(N, 0.14))
        await wait(b(N, 0.10))

    # Close cleanly
    cancel = page.locator("#addRepoModal button:has-text('Cancel'), #addRepoModal .modal-cancel")
    if await cancel.count() > 0:
        await move_to(page, "#addRepoModal button:has-text('Cancel'), #addRepoModal .modal-cancel")
        await cancel.first.click()
    else:
        await page.keyboard.press("Escape")
    await wait(b(N, 0.06))

    # Scroll back up
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.06))
    print("  ✓ Add Repo demo complete")


async def scene_budget_alert(page):
    """Scene 9: Throttle / spike detection."""
    print("\n[Scene 9] Throttle / spike detection")
    N = 9

    # Scroll to top to show budget bar and tiles
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.10))

    # Pulse the budget bar (full red — "saved me a four-figure invoice")
    await pulse(page, "#budgetBar, .budget-bar, .budget-progress", "#f87171", duration_s=b(N, 0.20))
    await zoom_flash(page, "#budgetBar, .budget-bar, .budget-progress", scale=1.04)
    await wait(b(N, 0.15))

    # Pulse the throttle controls on the first tile ("tile goes red")
    await move_to(page, ".gauge-card")
    await pulse(page, ".gauge-card:first-child .throttle, .throttle-control, .gauge-card:first-child", "#f87171", duration_s=b(N, 0.20))
    await wait(b(N, 0.15))

    # Pulse all throttle badges ("Acknowledge and continue, or go fix it")
    await pulse_many(page, ".throttle-badge, .throttle-on, [class*='throttle']", "#facc15", duration_s=b(N, 0.15))
    await wait(b(N, 0.12))

    # Scroll down to show the spike in the chart
    await page.evaluate("window.scrollTo({top: 700, behavior: 'smooth'})")
    await wait(b(N, 0.08))
    await pulse(page, "#spendChart, canvas, .chart-container", "#f87171", duration_s=b(N, 0.12))
    await wait(b(N, 0.08))

    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    print("  ✓ Throttle section shown")


async def scene_csv_import(page, demo_repo: str):
    """Scene 6: Import CSV tile — create a new tile and import a billing CSV."""
    print("\n[Scene 6] CSV import tile")
    N = 6

    # Scroll to the Import CSV card and highlight it
    await page.evaluate("window.scrollTo({top: 400, behavior: 'smooth'})")
    await wait(b(N, 0.08))
    await page.evaluate("document.querySelector('.add-repo-card:last-of-type')?.scrollIntoView({behavior:'smooth',block:'center'})")
    await wait(b(N, 0.06))

    import_card = page.locator(".add-repo-card:has-text('Import CSV')")
    if await import_card.count() == 0:
        print("  ! Import CSV card not found — skipping")
        return

    await pulse(page, ".add-repo-card:last-of-type", "#4285f4", duration_s=b(N, 0.14))
    await move_to(page, ".add-repo-card:last-of-type")
    await wait(b(N, 0.10))
    await import_card.click()
    await wait(b(N, 0.08))

    # Modal opens
    try:
        await page.wait_for_selector("#addCsvTileModal", state="visible", timeout=5000)
    except Exception:
        print("  ! CSV modal not found")
        return

    await pulse(page, "#addCsvTileModal .modal, #addCsvTileModal", "#4285f4", duration_s=b(N, 0.14))
    await wait(b(N, 0.08))

    # Type provider name
    await type_slow(page, "#csvTileLabel", "Google Cloud", delay=55)
    await wait(b(N, 0.08))

    # Click a color swatch
    await move_to(page, "#csvColorPicker, .color-swatch")
    await pulse(page, "#csvColorPicker, .color-picker", "#4285f4", duration_s=b(N, 0.10))
    await wait(b(N, 0.08))

    # Create tile
    await move_to(page, "#addCsvTileBtn")
    await page.locator("#addCsvTileBtn").click()
    await wait(b(N, 0.10))

    # Import the CSV file
    csv_path = str(Path(demo_repo).parent / "gcp-billing.csv")
    if not os.path.exists(csv_path):
        print(f"  ! CSV not found at {csv_path}")
        return

    import_btn = page.locator("button:has-text('import billing csv'), button:has-text('IMPORT BILLING CSV')").last
    if await import_btn.count() > 0:
        await move_to(page, "button:has-text('import billing csv'), button:has-text('IMPORT BILLING CSV')")
        await pulse(page, "button:has-text('import billing csv'), button:has-text('IMPORT BILLING CSV')", "#4ade80", duration_s=b(N, 0.10))
        await wait(b(N, 0.06))
        try:
            async with page.expect_file_chooser(timeout=6000) as fc_info:
                await import_btn.click()
            file_chooser = await fc_info.value
            await file_chooser.set_files(csv_path)
        except Exception as e:
            print(f"  ! file chooser not triggered ({e}) — skipping file import")
        await wait(b(N, 0.10))

        # Pulse the populated tile
        await page.evaluate("document.querySelectorAll('.gauge-card')[document.querySelectorAll('.gauge-card').length-1]?.scrollIntoView({behavior:'smooth',block:'center'})")
        await wait(b(N, 0.06))
        await pulse(page, ".gauge-card:last-child", "#4ade80", duration_s=b(N, 0.14))
        await zoom_flash(page, ".gauge-card:last-child")
        await wait(b(N, 0.08))
        print("  ✓ CSV tile created and imported")
    else:
        print("  ! import button not found")


async def scene_copilot(page):
    """Scene 10: Co-pilot chat panel."""
    print("\n[Scene 10] Co-pilot")
    N = 10

    toggle = page.locator("#copilotToggle, button:has-text('co-pilot'), [title='Co-pilot']")
    if await toggle.count() == 0:
        print("  ! Co-pilot toggle not found — skipping")
        return

    # Click to open
    await move_to(page, "#copilotToggle, button:has-text('co-pilot'), [title='Co-pilot']")
    await toggle.first.click()
    await wait(b(N, 0.12))

    # Pulse the panel ("chat interface with direct access to your spend data")
    await pulse(page, "#copilotPanel, .copilot-panel, .copilot-sidebar", "#a78bfa", duration_s=b(N, 0.20))
    await wait(b(N, 0.16))

    # Type a demo question slowly
    chat_input = page.locator("#copilotInput, .copilot-input textarea, #copilotPanel textarea, #copilotPanel input")
    if await chat_input.count() > 0:
        await chat_input.first.click()
        await chat_input.first.type("Which provider had the biggest spike this week?", delay=35)
        await wait(b(N, 0.10))
        await pulse(page, "#copilotInput, .copilot-input textarea, #copilotPanel textarea", "#a78bfa", duration_s=b(N, 0.15))
        await wait(b(N, 0.12))
        await chat_input.first.fill("")
    else:
        await wait(b(N, 0.35))

    # Close
    await toggle.first.click()
    await wait(b(N, 0.08))
    print("  ✓ Co-pilot shown")


async def scene_period_selector(page):
    """Scene 5: Time period selector — This Week / This Month / Custom."""
    print("\n[Scene 5] Period selector")
    N = 5

    period_btns = page.locator(".period-toggle")
    count = await period_btns.count()
    if count == 0:
        print("  ! Period selector not found — skipping")
        return

    # Pulse all period toggles to draw attention
    await move_to(page, ".period-toggle")
    await pulse_many(page, ".period-toggle", "#facc15", duration_s=b(N, 0.22))
    await wait(b(N, 0.18))

    # Click a couple to show cycling
    if count > 1:
        await move_to_nth(page, ".period-toggle", 1)
        await period_btns.nth(1).click()
        await wait(b(N, 0.22))

    # Click first one to show "This Month"
    await move_to_nth(page, ".period-toggle", 0)
    await period_btns.nth(0).click()
    await wait(b(N, 0.18))

    print("  ✓ Period selector shown")


async def scene_cold_open(page):
    """Scene 1: Cold open — hold on the welcome modal while narration plays."""
    print("\n[Scene 1] Cold open")
    N = 1
    # Clear the default path immediately so no username shows during the cold open
    await page.evaluate("const el = document.getElementById('dataFolderPath'); if (el) el.value = '';")
    await wait(b(N, 1.0))


async def scene_logging_snippet(page):
    """Scene 8: Logging snippet — show model/cost breakdown as the 'what you're logging'."""
    print("\n[Scene 8] Logging snippet")
    N = 8

    # Scroll back to top — show the dashboard with tile detail open
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.10))

    # Open the first tile to show model breakdown = what the snippet captures
    first_tile = page.locator(".gauge-card").first
    await move_to(page, ".gauge-card")
    await first_tile.click()
    await wait(b(N, 0.12))

    # Pulse model rows — scroll=False, we scrolled to top already
    await pulse(page, ".model-row:first-child, .model-breakdown li:first-child, .model-line:first-child",
                "#4ade80", duration_s=b(N, 0.18), scroll=False)
    await wait(b(N, 0.14))

    await pulse(page, ".model-row:nth-child(2), .model-breakdown li:nth-child(2), .model-line:nth-child(2)",
                "#4ade80", duration_s=b(N, 0.18), scroll=False)
    await wait(b(N, 0.14))

    # Zoom flash the whole expanded tile — "that's it, two extra lines"
    await zoom_flash(page, ".gauge-card.expanded, .gauge-card:first-child", scale=1.05)
    await wait(b(N, 0.10))

    # Close tile
    await first_tile.click()
    await wait(b(N, 0.08))


async def scene_wrap_up(page):
    """Scene 11: Wrap-up — final pan of the full dashboard."""
    print("\n[Scene 11] Wrap up")
    N = 11

    # Scroll to top, show the full dashboard
    await page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
    await wait(b(N, 0.12))

    # Zoom flash the grand total — "real-time spend across every AI provider"
    await zoom_flash(page, "#grandTotal, .total-spend, .grand-total", scale=1.08)
    await pulse(page, "#grandTotal, .total-spend, .grand-total", "#4ade80", duration_s=b(N, 0.25), scroll=False)
    await wait(b(N, 0.20))

    # Sweep cursor across tiles one last time
    tile_count = await page.locator(".gauge-card").count()
    for i in range(min(tile_count, 6)):
        await move_to_nth(page, ".gauge-card", i)
        await wait(b(N, 0.05))

    await wait(b(N, 0.10))


# ── Main orchestration ────────────────────────────────────────────────────────

async def run_demo(demo_repo: str, fast: bool = False, record: bool = True):
    global PAUSE_SHORT, PAUSE_MED, PAUSE_LONG, PAUSE_READ
    if fast:
        PAUSE_SHORT, PAUSE_MED, PAUSE_LONG, PAUSE_READ = 0.4, 0.8, 1.2, 1.5
    else:
        load_scene_durations()

    video_dir = Path(__file__).parent / "video_raw"
    video_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--start-maximized"],
        )
        ctx_opts = dict(
            viewport={"width": 1440, "height": 900},
            ignore_https_errors=True,
        )
        if record:
            ctx_opts["record_video_dir"] = str(video_dir)
            ctx_opts["record_video_size"] = {"width": 1440, "height": 900}

        context = await browser.new_context(**ctx_opts)
        page = await context.new_page()

        print(f"\napi-dash demo — {'FAST MODE' if fast else 'normal pacing'}")
        print(f"Demo repo: {demo_repo}")
        print(f"Opening {BASE_URL}...\n")

        # Navigate and wait for load
        await page.goto(BASE_URL, wait_until="domcontentloaded")
        await wait(PAUSE_MED)

        async def timed_scene(num: int, coro):
            """Run a scene then hold for the remainder of its narration budget."""
            t0 = time.time()
            await coro
            elapsed = time.time() - t0
            budget = scene_budget(num)
            remaining = budget - elapsed
            if remaining > 0:
                print(f"  ... holding {remaining:.1f}s to fill scene {num} narration ({budget:.0f}s)")
                await asyncio.sleep(remaining)

        # Run scenes in order — each number maps 1:1 to a narration scene for audio sync
        # Each scene is isolated: an exception skips that scene but the run continues
        scenes = [
            (1,  scene_cold_open(page)),
            (2,  scene_first_launch(page)),
            (3,  scene_dashboard_overview(page)),
            (4,  scene_provider_tile_detail(page)),
            (5,  scene_period_selector(page)),
            (6,  scene_csv_import(page, demo_repo)),
            (7,  scene_add_repo(page, demo_repo)),
            (8,  scene_logging_snippet(page)),
            (9,  scene_budget_alert(page)),
            (10, scene_copilot(page)),
            (11, scene_wrap_up(page)),
        ]
        for num, coro in scenes:
            try:
                await timed_scene(num, coro)
            except Exception as e:
                print(f"\n! Scene {num} error: {e} — holding budget and continuing")
                import traceback; traceback.print_exc()
                # Still hold the budget so audio sync is preserved
                await asyncio.sleep(scene_budget(num))

        print("\n\nDemo complete.")

        # Close context to flush the video file
        await context.close()
        await browser.close()

        if record:
            # Find the recorded webm file
            webm_files = sorted(video_dir.glob("*.webm"), key=lambda f: f.stat().st_mtime)
            if webm_files:
                latest = webm_files[-1]
                # Rename to something predictable for the render step
                dest = video_dir / "screen_recording.webm"
                if dest.exists():
                    dest.unlink()
                latest.rename(dest)
                print(f"  ✓ Video saved: {dest}")
                # Write path for render step
                (video_dir / "recording_path.txt").write_text(str(dest))
            else:
                print("  ! No video file found — check Playwright output")


def main():
    parser = argparse.ArgumentParser(description="api-dash demo automation")
    parser.add_argument("--repo", default=DEMO_REPO, help="Path to seeded demo repo")
    parser.add_argument("--fast", action="store_true", help="Faster pacing (for testing)")
    parser.add_argument("--no-record", action="store_true", help="Skip video recording (preview only)")
    parser.add_argument("--url", default=BASE_URL, help="Dashboard URL")
    args = parser.parse_args()

    asyncio.run(run_demo(demo_repo=args.repo, fast=args.fast, record=not args.no_record))


if __name__ == "__main__":
    main()
