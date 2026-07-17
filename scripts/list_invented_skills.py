#!/usr/bin/env python3
"""Print invented skills discovered during training."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--path",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "runtime" / "invented_skills.json",
    )
    args = parser.parse_args()
    if not args.path.exists():
        print("No invented skills yet. Train until the bot unlocks a milestone.")
        return
    data = json.loads(args.path.read_text(encoding="utf-8"))
    skills = data.get("skills", [])
    print(f"{len(skills)} invented skills (updated {data.get('updatedAt', '?')})")
    for skill in skills:
        sequence = " → ".join(str(step) for step in skill.get("sequence", []))
        print(f"- {skill['name']} milestone={skill['milestone']} sequence=[{sequence}]")


if __name__ == "__main__":
    main()
