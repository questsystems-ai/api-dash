#!/usr/bin/env python3
"""
api-dash demo video pipeline — one command to rule them all.

Usage:
  python scripts/demo/make_video.py

Steps:
  1. Seed demo data (fake repo, spend.db, GCP CSV)
  2. Generate narration audio via ElevenLabs
  3. Record the demo via Playwright (starts npm server automatically)
  4. Render: mix audio + video → output/api-dash-demo.mp4

Output: scripts/demo/output/api-dash-demo.mp4
"""

import subprocess
import sys
import time
import os
import socket
import signal
from pathlib import Path

DEMO_DIR = Path(__file__).parent
REPO_ROOT = DEMO_DIR.parent.parent
PYTHON = sys.executable
PORT = 3737


def step(label: str):
    print(f"\n{'─'*50}")
    print(f"  {label}")
    print(f"{'─'*50}")


def server_ready(port: int, timeout: int = 30) -> bool:
    """Poll until the server is accepting connections."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def main():
    step("Step 1 — Seed demo data")
    r = subprocess.run([PYTHON, str(DEMO_DIR / "seed_demo_data.py")], cwd=REPO_ROOT)
    if r.returncode != 0:
        print("✗ seed_demo_data.py failed"); sys.exit(1)

    step("Step 2 — Generate narration (ElevenLabs)")
    r = subprocess.run([PYTHON, str(DEMO_DIR / "generate_narration.py")], cwd=REPO_ROOT)
    if r.returncode != 0:
        print("✗ generate_narration.py failed"); sys.exit(1)

    # Wipe api-dash config so the first-launch modal always appears in the demo
    config_path = Path(os.path.expanduser("~")) / ".api-dash" / "config.json"
    if config_path.exists():
        config_path.unlink()
        print(f"  Wiped existing config ({config_path})")

    step("Step 3 — Start dev server")
    # Kill any existing process on the port so the demo gets a clean server
    if sys.platform == "win32":
        subprocess.run(
            f'for /f "tokens=5" %p in (\'netstat -ano ^| findstr :{PORT}\') do taskkill /F /PID %p',
            shell=True, capture_output=True
        )
    else:
        subprocess.run(f"lsof -ti:{PORT} | xargs kill -9", shell=True, capture_output=True)
    time.sleep(1)

    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    # Strip Supabase creds so the demo server never shows real project names
    demo_env = os.environ.copy()
    for key in ("SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_SERVICE_KEY", "NEXT_PUBLIC_SUPABASE_URL"):
        demo_env.pop(key, None)
    server = subprocess.Popen(
        [npm, "start"],
        cwd=REPO_ROOT,
        env=demo_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"  Server PID {server.pid} — waiting for port {PORT}...", end=" ")
    if not server_ready(PORT):
        print("\n✗ Server didn't start in time"); server.kill(); sys.exit(1)
    print("ready.")

    try:
        step("Step 4 — Record demo (Playwright)")
        r = subprocess.run(
            [PYTHON, str(DEMO_DIR / "run_demo.py")],
            cwd=REPO_ROOT,
        )
        if r.returncode != 0:
            print("✗ run_demo.py failed"); sys.exit(1)
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()
        print("\n  Server stopped.")

    step("Step 5 — Render video")
    r = subprocess.run([PYTHON, str(DEMO_DIR / "render_video.py")], cwd=REPO_ROOT)
    if r.returncode != 0:
        print("✗ render_video.py failed"); sys.exit(1)

    outputs = sorted((DEMO_DIR / "output").glob("api-dash-demo_*.mp4"), key=lambda f: f.stat().st_mtime)
    output = outputs[-1] if outputs else DEMO_DIR / "output"
    print(f"\n{'═'*50}")
    print(f"  ✓  Video ready: {output}")
    print(f"{'═'*50}\n")


if __name__ == "__main__":
    main()
