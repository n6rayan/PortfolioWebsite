"""Checks for the Deploy to S3 workflow (.github/workflows/deploy-s3.yml).

Uses only the Python standard library. The workflow's sync script is run
with a stub `aws` command on PATH, and the exclude patterns it passes are
applied to the git-tracked files the same way `aws s3 sync` applies them
(fnmatch on the path relative to the source directory, `*` crosses `/`).

Run with: python3 -m unittest discover -s tests
"""

import fnmatch
import os
import re
import stat
import subprocess
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "deploy-s3.yml")
README = os.path.join(ROOT, "README.md")
INDEX = os.path.join(ROOT, "index.html")

STUB_AWS = """#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$AWS_ARGS_FILE"
"""


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def sync_step_script(workflow):
    """Return the `run: |` block of the "Sync site to S3" step."""
    lines = workflow.splitlines()
    start = lines.index("      - name: Sync site to S3")
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    indent = len(lines[run + 1]) - len(lines[run + 1].lstrip())
    body = []
    for line in lines[run + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def run_sync_script(bucket):
    """Run the sync script with a stub aws; return (returncode, stdout, aws args)."""
    script = sync_step_script(read(WORKFLOW))
    with tempfile.TemporaryDirectory() as tmp:
        aws = os.path.join(tmp, "aws")
        with open(aws, "w") as f:
            f.write(STUB_AWS)
        os.chmod(aws, os.stat(aws).st_mode | stat.S_IEXEC)
        args_file = os.path.join(tmp, "args")
        env = dict(os.environ)
        env["PATH"] = tmp + os.pathsep + env["PATH"]
        env["AWS_ARGS_FILE"] = args_file
        env["S3_BUCKET"] = bucket
        result = subprocess.run(
            ["bash", "-e", "-c", script],
            cwd=ROOT, env=env, capture_output=True, text=True,
        )
        args = read(args_file).splitlines() if os.path.exists(args_file) else None
    return result.returncode, result.stdout, args


def excludes(args):
    return [args[i + 1] for i, a in enumerate(args) if a == "--exclude"]


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return out.splitlines()


def uploaded_files(args):
    patterns = excludes(args)
    return {
        path for path in tracked_files()
        if not any(fnmatch.fnmatchcase(path, p) for p in patterns)
    }


def local_assets():
    refs = re.findall(r'(?:href|src)="([^"]+)"', read(INDEX))
    return sorted({
        r for r in refs
        if not re.match(r"^(?:[a-z]+:|//|#)", r)
    })


class TriggerTest(unittest.TestCase):
    def test_runs_on_push_to_master(self):
        self.assertRegex(
            read(WORKFLOW),
            r"(?m)^on:\n  push:\n    branches:\n      - master\n",
        )

    def test_runs_on_workflow_dispatch(self):
        self.assertRegex(read(WORKFLOW), r"(?m)^  workflow_dispatch:\s*$")

    def test_deploys_do_not_overlap(self):
        self.assertRegex(read(WORKFLOW), r"(?m)^concurrency:\n  group: deploy-s3\n")


class ConfigurationTest(unittest.TestCase):
    def test_bucket_region_and_role_come_from_vars_and_secrets(self):
        workflow = read(WORKFLOW)
        self.assertIn("role-to-assume: ${{ secrets.AWS_ROLE_ARN }}", workflow)
        self.assertIn("aws-region: ${{ vars.AWS_REGION }}", workflow)
        self.assertIn("S3_BUCKET: ${{ vars.S3_BUCKET }}", workflow)

    def test_nothing_sensitive_is_hardcoded(self):
        workflow = read(WORKFLOW)
        for name, pattern in [
            ("AWS access key ID", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
            ("account ID", r"\b\d{12}\b"),
            ("role ARN", r"arn:aws:"),
            ("region", r"\b(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d\b"),
            ("bucket URI", r"s3://[A-Za-z0-9]"),
            ("secret key", r"(?i)aws-secret-access-key|aws_secret_access_key"),
        ]:
            with self.subTest(name):
                self.assertNotRegex(workflow, pattern)

    def test_uses_oidc_with_read_only_contents(self):
        self.assertRegex(
            read(WORKFLOW),
            r"(?m)^permissions:\n  id-token: write\n  contents: read\n",
        )

    def test_fails_when_bucket_variable_is_missing(self):
        code, stdout, args = run_sync_script("")
        self.assertNotEqual(code, 0)
        self.assertIn("S3_BUCKET is not set", stdout)
        self.assertIsNone(args, "aws must not be called without a bucket")


class SyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code, _, cls.args = run_sync_script("example-bucket")
        assert code == 0 and cls.args is not None, "sync script failed"

    def test_syncs_repository_root_to_bucket(self):
        self.assertEqual(self.args[:4], ["s3", "sync", ".", "s3://example-bucket"])

    def test_deletes_objects_not_in_repository(self):
        self.assertIn("--delete", self.args)

    def test_uploads_every_local_asset_in_index_html(self):
        uploaded = uploaded_files(self.args)
        self.assertIn("index.html", uploaded)
        assets = local_assets()
        for expected in ["css/creative.min.css", "js/creative.min.js",
                         "img/favicon.png", "cv.pdf"]:
            self.assertIn(expected, assets)
        self.assertTrue(any(a.startswith("vendor/") for a in assets))
        for asset in assets:
            with self.subTest(asset):
                self.assertIn(asset, uploaded)

    def test_uploads_whole_vendor_and_img_directories(self):
        uploaded = uploaded_files(self.args)
        for path in tracked_files():
            if path.startswith(("vendor/", "img/")):
                with self.subTest(path):
                    self.assertIn(path, uploaded)

    def test_does_not_upload_repository_only_files(self):
        uploaded = uploaded_files(self.args)
        for path in uploaded:
            with self.subTest(path):
                self.assertFalse(
                    path.startswith((".git/", ".github/", "scss/", "tests/",
                                     "e2e/", "node_modules/")),
                )
                self.assertNotIn(path, {
                    "README.md", ".gitignore", "package.json",
                    "pnpm-lock.yaml", "playwright.config.ts",
                })
        for pattern in [".git/*", ".github/*", "scss/*", "tests/*", "e2e/*",
                        "node_modules/*", "test-results/*",
                        "playwright-report/*"]:
            with self.subTest(pattern):
                self.assertIn(pattern, excludes(self.args))

    def test_only_site_files_are_uploaded(self):
        # Anything new at the top level must be excluded or added here on purpose.
        for path in uploaded_files(self.args):
            with self.subTest(path):
                self.assertTrue(
                    path in {"index.html", "cv.pdf"}
                    or path.startswith(("css/", "js/", "img/", "vendor/")),
                )

    def test_git_directory_is_excluded(self):
        # .git/ is not tracked, so check the pattern against a real path.
        self.assertTrue(any(
            fnmatch.fnmatchcase(".git/HEAD", p) for p in excludes(self.args)
        ))


class ReadmeTest(unittest.TestCase):
    def test_documents_setup(self):
        readme = read(README)
        for text in ["S3_BUCKET", "AWS_REGION", "AWS_ROLE_ARN",
                     "token.actions.githubusercontent.com",
                     "s3:ListBucket", "s3:PutObject", "s3:DeleteObject",
                     "--delete", "Run workflow"]:
            with self.subTest(text):
                self.assertIn(text, readme)


if __name__ == "__main__":
    unittest.main()
