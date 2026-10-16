#!/usr/bin/env python3
"""Submit a model-specific generation request to Muapi and download its first output.

Usage:
  python muapi_generate.py --endpoint <endpoint> --request request.json --out assets/generated.png

The request JSON must match the selected model's current Muapi schema. See
https://muapi.ai/docs for endpoint discovery and model-specific parameters.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://api.muapi.ai/api/v1"


def request(url, key, method="GET", body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "x-api-key": key,
        "Content-Type": "application/json",
        "User-Agent": "ReelMimic-Muapi-integration/1.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--endpoint", required=True, help="Muapi endpoint slug for the chosen model")
    ap.add_argument("--request", required=True, help="JSON file with model-specific request fields")
    ap.add_argument("--out", required=True, help="Path for the downloaded first output")
    ap.add_argument("--timeout", type=int, default=1800, help="Maximum wait in seconds (default: 1800)")
    ap.add_argument("--interval", type=int, default=5, help="Polling interval in seconds (default: 5)")
    args = ap.parse_args()

    key = os.environ.get("MUAPI_API_KEY")
    if not key:
        sys.exit("MUAPI_API_KEY is missing; add it to ~/.reelmimic/secrets.json or the environment.")
    if not args.endpoint.replace("-", "").replace("_", "").isalnum():
        sys.exit("Endpoint must be a model endpoint slug (letters, numbers, hyphens, underscores).")

    try:
        with open(args.request, encoding="utf-8") as f:
            payload = json.load(f)
        submitted = request(f"{BASE}/{args.endpoint}", key, method="POST", body=payload)
        request_id = submitted.get("request_id")
        if not request_id:
            sys.exit(f"Muapi did not return a request_id: {json.dumps(submitted)}")

        deadline = time.monotonic() + max(1, args.timeout)
        while time.monotonic() < deadline:
            result = request(f"{BASE}/predictions/{request_id}/result", key)
            status = result.get("status", "").lower()
            if status == "completed":
                outputs = result.get("outputs") or []
                if not outputs or not isinstance(outputs[0], str):
                    sys.exit(f"Muapi task completed without a downloadable output: {json.dumps(result)}")
                with urllib.request.urlopen(outputs[0], timeout=120) as response:
                    content = response.read()
                target = Path(args.out)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                print(json.dumps({"request_id": request_id, "status": status, "file": str(target),
                                  "bytes": len(content), "cost": result.get("cost", submitted.get("cost"))}))
                return
            if status in {"failed", "cancelled"}:
                sys.exit(f"Muapi task {status}: {json.dumps(result)}")
            time.sleep(max(1, args.interval))
        sys.exit(f"Timed out waiting for Muapi request {request_id}; it can still be checked in the Muapi dashboard.")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"Muapi HTTP {e.code}: {detail}")
    except (OSError, ValueError, urllib.error.URLError) as e:
        sys.exit(f"Muapi generation failed: {e}")


if __name__ == "__main__":
    main()
