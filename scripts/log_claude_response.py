#!/usr/bin/env python3
"""
Stop hook — appends Claude's last response (minus code blocks) to session-log.md.
Receives hook JSON via stdin from Claude Code.
"""
import json, re, sys
from datetime import datetime
from pathlib import Path

try:
    data = json.loads(sys.stdin.read())
    transcript_path = data.get("transcript_path")
    if not transcript_path:
        sys.exit(0)

    lines = Path(transcript_path).read_text(encoding="utf-8", errors="ignore").strip().split("\n")

    # Find last assistant message
    for line in reversed(lines):
        try:
            msg = json.loads(line)
            # Handle wrapped formats (some versions nest under "message")
            if "message" in msg:
                msg = msg["message"]
            if msg.get("role") != "assistant":
                continue

            content = msg.get("content", "")
            if isinstance(content, list):
                text = "\n".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            else:
                text = str(content)

            # Strip fenced code blocks
            text = re.sub(r"```[\s\S]*?```", "[code]", text)
            # Collapse excess whitespace
            text = re.sub(r"\n{3,}", "\n\n", text).strip()

            if not text:
                break

            ts = datetime.now().strftime("%H:%M")
            log_path = Path("scripts/output/session-log.md")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as f:
                # Truncate very long responses but keep the shape
                if len(text) > 800:
                    text = text[:800] + "… [truncated]"
                f.write(f"[{ts}] [CLAUDE] {text}\n")
            break
        except Exception:
            continue
except Exception:
    pass  # Never block Claude's response
