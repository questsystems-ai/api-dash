#!/usr/bin/env python3
"""
Narration audio generator — calls ElevenLabs TTS for each scene.
Outputs: scripts/demo/audio/scene_01.mp3 ... scene_11.mp3
"""

import os
import re
import sys
import json
import requests
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

VOICE_ID     = "TX3LPaxmHKxFdv7VOQHJ"   # Liam (Energetic Social Media Creator)
MODEL_ID     = "eleven_turbo_v2_5"       # fast + high quality
OUTPUT_DIR   = Path(__file__).parent / "audio"
SCRIPT_FILE  = Path(__file__).parent / "narration.md"

VOICE_SETTINGS = {
    "stability": 0.55,
    "similarity_boost": 0.80,
    "style": 0.45,
    "use_speaker_boost": True,
}

# ── Parse scenes from narration.md ───────────────────────────────────────────

def parse_scenes(md_path: Path) -> list[dict]:
    """Extract scene number + narration text from the markdown script."""
    text = md_path.read_text(encoding="utf-8")
    scenes = []

    # Match each ## SCENE N — Title block
    pattern = re.compile(r"## SCENE (\d+)[^\n]*\n(.*?)(?=\n## SCENE |\n---\n## ElevenLabs|\Z)", re.DOTALL)
    for m in pattern.finditer(text):
        num = int(m.group(1))
        block = m.group(2)

        # Extract the quoted narration lines (inside "...")
        lines = []
        for line in block.split("\n"):
            # Strip delivery notes (lines starting with * or #)
            stripped = line.strip()
            if not stripped or stripped.startswith("*") or stripped.startswith("#"):
                continue
            lines.append(stripped)

        narration = " ".join(lines)

        # Convert [pause] markers to SSML breaks
        narration = narration.replace("[pause long]", '<break time="2s" />')
        narration = narration.replace("[pause]", '<break time="0.7s" />')

        # Wrap in SSML speak tags
        ssml = f'<speak>{narration}</speak>'

        scenes.append({"num": num, "ssml": ssml, "raw": narration})

    return scenes


# ── ElevenLabs TTS ────────────────────────────────────────────────────────────

def synthesise(ssml: str, output_path: Path, api_key: str) -> bool:
    """Call ElevenLabs TTS and save to output_path. Returns True on success."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    body = {
        "text": ssml,
        "model_id": MODEL_ID,
        "voice_settings": VOICE_SETTINGS,
    }
    r = requests.post(url, headers=headers, json=body, timeout=60)
    if not r.ok:
        print(f"    ✗ ElevenLabs {r.status_code}: {r.text[:200]}")
        return False
    output_path.write_bytes(r.content)
    size_kb = len(r.content) // 1024
    print(f"    ✓ {output_path.name} ({size_kb} KB)")
    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        # Try reading from .env.local in the repo root
        env_file = Path(__file__).resolve().parent.parent.parent / ".env.local"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() == "ELEVENLABS_API_KEY":
                    api_key = v.strip()
                    break

    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY not found in environment or .env.local")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    scenes = parse_scenes(SCRIPT_FILE)
    print(f"\nGenerating narration for {len(scenes)} scenes...\n")

    manifest = {}
    for scene in scenes:
        out = OUTPUT_DIR / f"scene_{scene['num']:02d}.mp3"
        print(f"  Scene {scene['num']:02d}:", end=" ")
        if out.exists():
            print(f"already exists — skipping ({out.name})")
            manifest[scene['num']] = str(out)
            continue
        ok = synthesise(scene["ssml"], out, api_key)
        if ok:
            manifest[scene['num']] = str(out)
        else:
            # Abort on first failure — don't burn credits on a bad key
            print("  Aborting — fix the API key and re-run.")
            sys.exit(1)

    # Save manifest for render step
    manifest_path = OUTPUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nManifest saved: {manifest_path}")
    print(f"Done. {len(manifest)}/{len(scenes)} scenes generated.")


if __name__ == "__main__":
    main()
