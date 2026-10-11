#!/usr/bin/env python3
"""Deploy from a local staging directory to avoid cloud-drive file timeouts."""
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wrangler", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=Path.home()/".config/wb-fission/executor.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="wb-gateway-deploy-") as temp:
        stage = Path(temp)
        for name in ("src", "wrangler.toml", "package.json"):
            src = ROOT / "cloudflare-worker" / name
            if src.is_dir():
                shutil.copytree(src, stage/name)
            else:
                shutil.copy2(src, stage/name)
        argv = ["node", str(args.wrangler)]
        if not args.dry_run:
            config = json.loads(args.config.read_text())
            secret_names = ("EXECUTOR_SECRET", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN")
            if not all(config.get(k) for k in secret_names):
                parser.error("Required protected secrets are missing")
            # Secret values are passed on stdin, never command line or source files.
            # New protected binding names avoid collisions with legacy plaintext vars.
            subprocess.run(argv+["secret", "bulk"], input=json.dumps({k+"_V2":config[k] for k in secret_names}), text=True, cwd=stage, check=True)
        subprocess.run(argv+["deploy"]+(["--dry-run"] if args.dry_run else []), cwd=stage, check=True)


if __name__ == "__main__":
    main()
