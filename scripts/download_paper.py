#!/usr/bin/env python3
"""Download the latest Paper build for the pinned Minecraft version."""

import json
import urllib.request
from pathlib import Path

VERSION = "1.21.4"
API = "https://fill.papermc.io/v3/projects/paper"
DESTINATION = Path(__file__).resolve().parents[1] / "mc" / f"paper-{VERSION}.jar"
USER_AGENT = "minecraft-hrl-bot/0.1 (local research project)"


def read_json(url: str) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> None:
    if DESTINATION.exists():
        print(f"{DESTINATION.name} already exists")
        return
    builds = read_json(f"{API}/versions/{VERSION}/builds")
    stable = [build for build in builds if build["channel"] in {"STABLE", "RECOMMENDED"}]
    if not stable:
        raise RuntimeError(f"No stable Paper build exists for Minecraft {VERSION}")
    details = stable[0]
    download = details["downloads"]["server:default"]
    print(f"Downloading Paper {VERSION} build {details['id']}...")
    request = urllib.request.Request(download["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response, DESTINATION.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    print(f"Saved {DESTINATION}")


if __name__ == "__main__":
    main()
