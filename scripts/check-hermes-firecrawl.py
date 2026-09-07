#!/usr/bin/env python3
"""Read-only, no-network healthcheck. Never prints config, environment or exceptions."""
import argparse
import contextlib
import io
import json
import logging
import sys


def validate(web):
    for key in ("backend", "search_backend", "extract_backend"):
        if web.get(key) != "firecrawl":
            raise ValueError("backend_changed")
    for key in ("use_gateway", "keyless_fallback", "keyless_rescue", "cache_enabled"):
        if web.get(key) is not False:
            raise ValueError("unsafe_web_policy")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-only", metavar="JSON", help="Offline example validation; does not certify installed Hermes")
    args = parser.parse_args()
    if args.config_only:
        with open(args.config_only, encoding="utf-8") as config:
            validate(json.load(config)["web"])
        return {"status": "config-only", "backend": "firecrawl"}

    # Run in the installed Hermes venv with its checkout on PYTHONPATH and the
    # intended isolated HERMES_HOME. Suppress third-party startup/log output.
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from tools.web_tools import _load_web_config, _get_search_backend, _get_extract_backend
        from plugins.web.firecrawl.provider import _get_direct_firecrawl_config, _use_keyless_ring
        web = _load_web_config()
        validate(web)
        if (_get_search_backend(), _get_extract_backend()) != ("firecrawl", "firecrawl"):
            raise ValueError("backend_changed")
        direct = _get_direct_firecrawl_config()
        if not direct or direct[0] != "keyless" or _use_keyless_ring():
            raise ValueError("keyed_or_fallback_route")
    return {"status": "ready", "backend": "firecrawl", "mode": "keyless", "web": web_policy(web)}


def web_policy(web):
    # Output only allowlisted, already validated non-secret fields.
    return {key: web[key] for key in (
        "backend", "search_backend", "extract_backend", "use_gateway",
        "keyless_fallback", "keyless_rescue", "cache_enabled")}


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:
        # No exception text: loaders can embed credentials or complete config.
        print('{"status":"blocked","reason":"Free Firecrawl policy or installed Hermes compatibility check failed"}')
        sys.exit(1)
