#!/usr/bin/env python3
"""Exercise the real Bash installer with local release downloads."""
import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
RELEASES = "https://github.com/txchen/hush/releases"
VERSION = "0.0.2"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hush install test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.downloads = self.root / "downloads"
        self.bin = self.root / "commands"
        self.target = self.root / "install directory"
        for directory in (self.downloads, self.bin, self.target, self.root / "tmp"):
            directory.mkdir()
        self.destination = self.target / "hush"
        self.destination.write_text("existing installation\n")
        self.env = dict(os.environ)
        self.env.pop("HUSH_VERSION", None)
        self.env.update(
            PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            HUSH_INSTALL_DIR=str(self.target),
            TMPDIR=str(self.root / "tmp"),
            FIXTURE_DOWNLOADS=str(self.downloads),
            FIXTURE_LOG=str(self.root / "requests"),
            FIXTURE_SYSTEM="Linux",
            FIXTURE_ARCH="x86_64",
        )
        self.command("uname", '''#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$FIXTURE_SYSTEM" ;;
  -m) printf '%s\\n' "$FIXTURE_ARCH" ;;
  *) exit 1 ;;
esac
''')
        self.command("curl", '''#!/bin/sh
set -eu
url=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FIXTURE_LOG"
if [ "${FIXTURE_FAIL_DOWNLOAD:-}" = "${url##*/}" ]; then exit 22; fi
cp "$FIXTURE_DOWNLOADS/${url##*/}" "$output"
''')
        self.make_release()

    def command(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def make_release(self, version=VERSION, kind="binary", binary=None):
        lines = []
        for target in ("linux_amd64", "linux_arm64", "darwin_arm64"):
            archive = self.downloads / f"hush_{version}_{target}.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo("other" if kind == "missing" else "hush")
                if kind == "symlink":
                    member.type = tarfile.SYMTYPE
                    member.linkname = str(self.destination)
                    tar.addfile(member)
                else:
                    data = binary or f'#!/bin/sh\necho "hush {version}"\n'.encode()
                    member.size = len(data)
                    member.mode = 0o755
                    tar.addfile(member, io.BytesIO(data))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            lines.append(f"{digest}  {archive.name}\n")
        (self.downloads / "SHA256SUMS").write_text("".join(lines))

    def run_installer(self, success=True, args=()):
        # Feed stdin just as curl | bash does, with every write confined to a fixture.
        result = subprocess.run(
            ["bash", "-s", "--", *args], input=(ROOT / "install.sh").read_text(),
            env=self.env, text=True, capture_output=True, timeout=30,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(self.destination.read_text(), "existing installation\n")
        self.assertEqual(list((self.root / "tmp").iterdir()), [])
        self.assertEqual(list(self.target.glob(".hush.*")), [])
        return result

    def requests(self):
        path = self.root / "requests"
        return path.read_text().splitlines() if path.exists() else []

    def test_latest_selects_platform_and_pins_download(self):
        for system, arch, target in (
            ("Linux", "x86_64", "linux_amd64"),
            ("Linux", "aarch64", "linux_arm64"),
            ("Darwin", "arm64", "darwin_arm64"),
        ):
            with self.subTest(target=target):
                self.env.update(FIXTURE_SYSTEM=system, FIXTURE_ARCH=arch)
                result = self.run_installer()
                self.assertEqual(self.requests()[-2:], [
                    f"{RELEASES}/latest/download/SHA256SUMS",
                    f"{RELEASES}/download/v{VERSION}/hush_{VERSION}_{target}.tar.gz",
                ])
                self.assertEqual(self.destination.stat().st_mode & 0o777, 0o755)
                self.assertIn("export PATH=", result.stdout)
                self.assertIn(f"hush {VERSION}", result.stdout)

    def test_pinned_prerelease(self):
        version = "0.0.3-rc.1"
        self.make_release(version=version)
        self.env["HUSH_VERSION"] = f"v{version}"
        self.run_installer()
        self.assertEqual(self.requests()[0], f"{RELEASES}/download/v{version}/SHA256SUMS")

    def test_checksum_mismatch_preserves_installation(self):
        archive = self.downloads / f"hush_{VERSION}_linux_amd64.tar.gz"
        archive.write_bytes(archive.read_bytes() + b"corrupt")
        self.assertIn("SHA-256 mismatch", self.run_installer(False).stderr)

    @unittest.skipUnless(shutil.which("shasum"), "shasum is unavailable")
    def test_shasum_fallback(self):
        # macOS ships shasum; exercise that path even on hosts with sha256sum.
        for command in ("bash", "tar", "gzip", "mktemp", "install", "cp", "chmod", "mkdir", "mv", "rm", "shasum"):
            (self.bin / command).symlink_to(shutil.which(command))
        self.env["PATH"] = str(self.bin)
        self.run_installer()

    def test_bad_manifests_preserve_installation(self):
        manifest = self.downloads / "SHA256SUMS"
        lines = manifest.read_text().splitlines(keepends=True)
        for content in ("", lines[1], lines[0] * 2, "invalid  " + lines[0].split("  ")[1]):
            with self.subTest(content=content):
                manifest.write_text(content)
                self.run_installer(False)

    def test_version_mismatch_preserves_installation(self):
        self.env["HUSH_VERSION"] = "v0.0.1"
        self.assertIn("does not match", self.run_installer(False).stderr)
        self.assertEqual(len(self.requests()), 1)

    def test_download_failures_preserve_installation(self):
        for filename in ("SHA256SUMS", f"hush_{VERSION}_linux_amd64.tar.gz"):
            with self.subTest(filename=filename):
                self.env["FIXTURE_FAIL_DOWNLOAD"] = filename
                self.run_installer(False)

    def test_unsupported_platform_fails_before_downloading(self):
        self.env.update(FIXTURE_SYSTEM="Darwin", FIXTURE_ARCH="x86_64")
        self.run_installer(False)
        self.assertEqual(self.requests(), [])

    def test_invalid_options_fail_before_downloading(self):
        for name, value in (("HUSH_VERSION", "../../bad"), ("HUSH_INSTALL_DIR", "relative")):
            with self.subTest(name=name):
                original = self.env.get(name)
                self.env[name] = value
                self.run_installer(False)
                if original is None:
                    del self.env[name]
                else:
                    self.env[name] = original
        self.run_installer(False, args=("unexpected",))
        self.assertEqual(self.requests(), [])

    def test_missing_or_symlink_binary_is_rejected(self):
        for kind in ("missing", "symlink"):
            with self.subTest(kind=kind):
                self.make_release(kind=kind)
                self.run_installer(False)

    def test_binary_that_cannot_run_preserves_installation(self):
        self.make_release(binary=b"#!/bin/sh\nexit 1\n")
        self.run_installer(False)

    @unittest.skipUnless(os.environ.get("HUSH_TEST_ARCHIVE_DIR"), "no native archives supplied")
    def test_native_release_archive(self):
        source = Path(os.environ["HUSH_TEST_ARCHIVE_DIR"])
        for path in source.iterdir():
            shutil.copyfile(path, self.downloads / path.name)
        self.env.update(FIXTURE_SYSTEM=platform.system(), FIXTURE_ARCH=platform.machine())
        self.run_installer()
        result = subprocess.run([str(self.destination), "version"], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(source.name, result.stdout)


if __name__ == "__main__":
    unittest.main()
