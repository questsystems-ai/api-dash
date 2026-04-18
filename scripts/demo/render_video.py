#!/usr/bin/env python3
"""
Video render — mixes Playwright screen recording + ElevenLabs narration into a final .mp4

Approach:
  - Concatenates scene audio files into one narration track
  - Stretches/pads the screen recording to match narration length
  - Outputs: scripts/demo/output/api-dash-demo.mp4

Usage:
  python scripts/demo/render_video.py
"""

import subprocess
import json
import sys
from datetime import datetime
from pathlib import Path

DEMO_DIR    = Path(__file__).parent
AUDIO_DIR   = DEMO_DIR / "audio"
VIDEO_DIR   = DEMO_DIR / "video_raw"
OUTPUT_DIR  = DEMO_DIR / "output"

def make_output_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return OUTPUT_DIR / f"api-dash-demo_{stamp}.mp4"

# Silence gap between scenes (seconds)
SCENE_GAP = 0.5


def run(cmd: list, label: str = "") -> subprocess.CompletedProcess:
    """Run an ffmpeg command, print progress."""
    print(f"  {label or 'running'}...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  ✗ Error:\n{r.stderr[-600:]}")
        sys.exit(1)
    return r


def get_duration(path: Path) -> float:
    """Return media duration in seconds via ffprobe."""
    r = subprocess.run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", path
    ], capture_output=True, text=True)
    data = json.loads(r.stdout)
    return float(data["format"]["duration"])


def build_narration_track(manifest_path: Path, output_path: Path) -> float:
    """
    Concatenate scene audio files with short gaps into one narration .mp3
    Returns total duration in seconds.
    """
    manifest = json.loads(manifest_path.read_text())
    scene_nums = sorted(int(k) for k in manifest.keys())

    # Build ffmpeg concat filter
    inputs = []
    filter_parts = []

    for i, num in enumerate(scene_nums):
        audio_file = Path(manifest[str(num)])
        if not audio_file.exists():
            print(f"  ! Missing audio for scene {num}: {audio_file}")
            continue
        inputs += ["-i", str(audio_file)]
        filter_parts.append(f"[{i}:a]")

    if not filter_parts:
        print("  ✗ No audio files found — run generate_narration.py first")
        sys.exit(1)

    n = len(filter_parts)
    concat_filter = "".join(filter_parts) + f"concat=n={n}:v=0:a=1[outa]"

    cmd = ["ffmpeg", "-y"]
    cmd += inputs
    cmd += ["-filter_complex", concat_filter, "-map", "[outa]", str(output_path)]
    run(cmd, f"Concatenating {n} audio scenes")

    duration = get_duration(output_path)
    print(f"  ✓ Narration track: {duration:.1f}s")
    return duration


def build_atempo_filter(speed: float) -> str:
    """Build chained atempo filter — each stage must be 0.5–2.0."""
    stages = []
    remaining = speed
    while remaining > 2.0:
        stages.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        stages.append("atempo=0.5")
        remaining /= 0.5
    stages.append(f"atempo={remaining:.6f}")
    return ",".join(stages)


def render(screen_path: Path, audio_path: Path, narration_duration: float):
    """Mix screen recording + narration into final mp4.
    Video plays at natural speed; narration is sped up to match.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_file = make_output_path()
    screen_duration = get_duration(screen_path)
    print(f"  Screen recording: {screen_duration:.1f}s")
    print(f"  Narration:        {narration_duration:.1f}s")

    ratio = narration_duration / screen_duration
    print(f"  Ratio (audio/video): {ratio:.3f}x")

    if ratio <= 1.3:
        # Minor mismatch — speed up audio slightly to match video
        print(f"  Strategy: speed audio {ratio:.3f}x")
        atempo = build_atempo_filter(ratio)
        video_filter = "fps=30[v]"
        audio_filter = f"{atempo}[a]"
        filter_complex = f"[0:v]{video_filter};[1:a]{audio_filter}"
    else:
        # Large mismatch — slow video down to match audio (keeps voice natural)
        pts = ratio
        print(f"  Strategy: slow video {pts:.3f}x to match audio (voice stays natural)")
        filter_complex = f"[0:v]fps=30,setpts={pts:.6f}*PTS[v];[1:a]acopy[a]"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(screen_path),
        "-i", str(audio_path),
        "-filter_complex", filter_complex,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "h264_mf",
        "-b:v", "8000k",
        "-c:a", "aac",
        "-b:a", "192k",
        str(output_file),
    ]
    run(cmd, f"Rendering final video → {output_file.name}")
    final_duration = get_duration(output_file)
    size_mb = output_file.stat().st_size // (1024 * 1024)
    print(f"\n  ✓ Done: {output_file}")
    print(f"     Duration: {final_duration:.1f}s  |  Size: {size_mb} MB")


def main():
    print("\nRendering api-dash demo video...\n")

    # Locate screen recording
    recording_hint = VIDEO_DIR / "recording_path.txt"
    if recording_hint.exists():
        screen_path = Path(recording_hint.read_text().strip())
    else:
        # Fall back to most recent webm
        webms = sorted(VIDEO_DIR.glob("*.webm"), key=lambda f: f.stat().st_mtime)
        if not webms:
            print("✗ No screen recording found. Run run_demo.py first.")
            sys.exit(1)
        screen_path = webms[-1]

    if not screen_path.exists():
        print(f"✗ Screen recording not found: {screen_path}")
        sys.exit(1)

    print(f"  Screen: {screen_path.name}")

    # Build narration track
    manifest_path = AUDIO_DIR / "manifest.json"
    if not manifest_path.exists():
        print("✗ No narration manifest found. Run generate_narration.py first.")
        sys.exit(1)

    narration_path = AUDIO_DIR / "narration_full.mp3"
    narration_duration = build_narration_track(manifest_path, narration_path)

    # Render
    render(screen_path, narration_path, narration_duration)


if __name__ == "__main__":
    main()
