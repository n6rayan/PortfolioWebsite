# PortfolioWebsite
My developer portfolio website!

## Deployment

The site is deployed to an S3 bucket by the [Deploy to S3](.github/workflows/deploy-s3.yml) GitHub Actions workflow. It runs on every push to `master`, and can be run by hand from the **Actions** tab (**Deploy to S3** → **Run workflow**).

The workflow runs `aws s3 sync --delete`, so any object in the bucket that isn't in the repository is removed. Source and development files are not uploaded: `.git/`, `.github/`, `scss/`, `tests/`, `e2e/`, `node_modules/`, Playwright output, `README.md`, `.gitignore`, `package.json`, `pnpm-lock.yaml` and `playwright.config.ts`.

### Setup

Repository variables (**Settings → Secrets and variables → Actions → Variables**):

- `S3_BUCKET` - name of the bucket hosting the site
- `AWS_REGION` - region of the bucket, e.g. `eu-west-2`

Repository secrets:

- `AWS_ROLE_ARN` - ARN of the IAM role the workflow assumes through GitHub OIDC

The role needs a trust policy for the GitHub OIDC provider (`token.actions.githubusercontent.com`) limited to this repository, and these permissions:

- `s3:ListBucket` on `arn:aws:s3:::<bucket>`
- `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*`

### Tests

`tests/` checks the deploy workflow: it runs the sync step against a stub `aws` command and confirms which files would be uploaded. It needs only Python 3 and runs in CI on every pull request:

```
python3 -m unittest discover -s tests
```
