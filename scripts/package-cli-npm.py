#!/usr/bin/env python3
"""Package the verified CLI archives for npm; never rebuild or download binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = (("linux", "amd64", "x64"), ("linux", "arm64", "arm64"), ("darwin", "arm64", "arm64"))
# npm versions must be canonical SemVer. Build metadata is intentionally excluded.
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error("version must be canonical SemVer without build metadata")
    version = args.version
    source = ROOT / "dist" / "cli" / version
    sums = dict(line.split()[::-1] for line in (source / "SHA256SUMS").read_text().splitlines())
    binaries = {}
    for system, goarch, arch in TARGETS:
        archive = source / f"hush_{version}_{system}_{goarch}.tar.gz"
        if hashlib.sha256(archive.read_bytes()).hexdigest() != sums.get(archive.name):
            raise ValueError(f"checksum mismatch: {archive.name}")
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            if len(members) != 1 or members[0].name != "hush" or not members[0].isfile():
                raise ValueError(f"unexpected archive contents: {archive.name}")
            binaries[f"{system}-{arch}"] = tar.extractfile(members[0]).read()

    output = ROOT / "dist" / "npm" / version
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    common = {
        "version": version,
        "description": "Hush: encrypted secrets for developer and coding-agent workflows",
        "repository": {"type": "git", "url": "git+https://github.com/txchen/hush.git"},
        "homepage": "https://github.com/txchen/hush",
        "publishConfig": {"access": "public", "registry": "https://registry.npmjs.org/"},
    }
    packages = []
    for system, _, arch in TARGETS:
        target = f"{system}-{arch}"
        directory = output / target
        (directory / "bin").mkdir(parents=True)
        binary = directory / "bin" / "hush"
        binary.write_bytes(binaries[target])
        binary.chmod(0o755)
        manifest = dict(common, name=f"@txchen/hush-{target}", os=[system], cpu=[arch], files=["bin/hush"])
        (directory / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (directory / "README.md").write_text(f"# {manifest['name']}\n\nPlatform binary for @txchen/hush. Install with `npm install -g @txchen/hush`.\n")
        packages.append(directory)

    directory = output / "hush"
    directory.mkdir()
    manifest = dict(common, name="@txchen/hush", bin={"hush": "hush.cjs"},
                    engines={"node": ">=24.0.0"}, os=["linux", "darwin"], cpu=["x64", "arm64"],
                    files=["hush.cjs"],
                    optionalDependencies={f"@txchen/hush-{target}": version for target in binaries})
    (directory / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(ROOT / "apps" / "cli" / "npm" / "hush.cjs", directory / "hush.cjs")
    (directory / "hush.cjs").chmod(0o755)
    shutil.copyfile(ROOT / "apps" / "cli" / "npm" / "README.md", directory / "README.md")
    packages.append(directory)
    for package in packages:
        subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(output)], cwd=package, check=True)
    print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
