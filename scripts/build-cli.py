#!/usr/bin/env python3
"""Build deterministic CLI archives with a fixed Go toolchain and version."""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ("linux/amd64", "linux/arm64", "darwin/arm64")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="dev")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", args.version):
        parser.error("version must be a short alphanumeric release identifier")
    output = ROOT / "dist" / "cli" / args.version
    output.mkdir(parents=True, exist_ok=True)
    checksums = []
    for target in TARGETS:
        system, arch = target.split("/")
        with tempfile.TemporaryDirectory(prefix="hush-build-") as temp:
            binary = Path(temp) / "hush"
            env = dict(os.environ, CGO_ENABLED="0", GOOS=system, GOARCH=arch)
            # Fix target baseline independently of the caller's environment.
            env.update(GOAMD64="v1", GOARM64="v8.0", GOFLAGS="", GOEXPERIMENT="")
            subprocess.run(
                ["go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
                 "-ldflags", f"-s -w -X main.version={args.version}",
                 "-o", str(binary), "./cmd/hush"],
                cwd=ROOT / "apps" / "cli", env=env, check=True,
            )
            name = f"hush_{args.version}_{system}_{arch}.tar.gz"
            archive = output / name
            data = binary.read_bytes()
            with archive.open("wb") as raw:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
                    with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                        info = tarfile.TarInfo("hush")
                        info.size = len(data)
                        info.mode = 0o755
                        info.mtime = 0
                        tar.addfile(info, io.BytesIO(data))
            checksums.append(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {name}\n")
            print(archive.relative_to(ROOT), flush=True)
    (output / "SHA256SUMS").write_text("".join(checksums), encoding="ascii")


if __name__ == "__main__":
    main()
