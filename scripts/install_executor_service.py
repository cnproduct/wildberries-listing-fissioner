#!/usr/bin/env python3
"""Install a macOS login service with restart-on-exit; credentials stay outside plist."""
import argparse
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.cnproduct.wb-fission.executor"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path.home()/".config/wb-fission/executor.json")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.exit(2, "This installer is for macOS; use a supervised service on other hosts.\n")
    if not args.config.is_file():
        parser.exit(2, "Protected executor configuration is missing.\n")
    args.config.chmod(0o600)
    runtime = args.config.parent
    logs = runtime/"logs"
    logs.mkdir(parents=True, exist_ok=True)
    agent = Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
    agent.parent.mkdir(parents=True, exist_ok=True)
    plist = {"Label": LABEL,
             "ProgramArguments": [sys.executable,str(ROOT/"scripts/antigravity_executor.py"),"--config",str(args.config),"--interval","5"],
             "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
             "StandardOutPath": str(logs/"executor.out.log"), "StandardErrorPath": str(logs/"executor.err.log"),
             "EnvironmentVariables": {"PATH":"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "PYTHONUNBUFFERED":"1"}}
    domain = "gui/"+str(os.getuid())
    subprocess.run(["launchctl","bootout",domain+"/"+LABEL],capture_output=True)
    agent.write_bytes(plistlib.dumps(plist))
    # launchd can briefly retain the old registration after a successful bootout.
    # Retry only its transient I/O result; preserve all other installation errors.
    for attempt in range(6):
        started = subprocess.run(["launchctl","bootstrap",domain,str(agent)], capture_output=True, text=True)
        if started.returncode == 0:
            break
        if started.returncode != 5 or attempt == 5:
            raise RuntimeError("Cannot start executor service: " + started.stderr.strip())
        time.sleep(0.5 * (attempt + 1))
    print("Installed and started:",LABEL)
    print("Login service:",agent)
    print("Runtime credentials remain in the protected configuration file.")


if __name__ == "__main__":
    main()
