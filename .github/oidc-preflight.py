#!/usr/bin/env python3
"""Ask npm whether this job's OIDC identity is a usable trusted publisher.

npm CLI collapses every trusted-publishing failure into a misleading
`ENEEDAUTH`/"please log in" message (npm/cli#9088), so a publish attempt cannot
tell a missing trusted publisher from a mismatch. This does the exchange by hand
and prints the registry's own answer, without printing either token.

Run inside a GitHub Actions job that has `id-token: write`.
"""

import json
import os
import sys
import urllib.error
import urllib.request

AUDIENCE = "npm:registry.npmjs.org"
EXCHANGE = "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange"


def mint() -> str:
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    bearer = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not bearer:
        sys.exit("id-token: write is not in effect for this job (no OIDC endpoint)")
    req = urllib.request.Request(
        f"{url}&audience={AUDIENCE}",
        headers={"Authorization": f"bearer {bearer}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["value"]


def exchange(oidc_token: str):
    body = json.dumps({"token": oidc_token}).encode()
    req = urllib.request.Request(
        EXCHANGE, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, raw


def main() -> int:
    token = mint()
    print(f"minted a GitHub OIDC token ({len(token)} bytes) for audience {AUDIENCE}")
    status, payload = exchange(token)
    print(f"exchange HTTP {status}")
    if status == 200 and isinstance(payload, dict):
        # Do not print the credential itself.
        print("exchange OK; response fields: " + ", ".join(sorted(payload)))
        print("trusted publisher is configured and usable from this workflow")
        return 0
    print("registry said: " + json.dumps(payload, indent=2))
    print(
        "::error::npm rejected the OIDC exchange; the trusted publisher for this "
        "package is missing or does not match this repository/workflow"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
