# Release Guide

This package publishes as `@maolaila/selvedge` and exposes the `selvedge` binary.

## Prerequisites

1. Use Node.js 20 or newer.
2. Install pnpm 9.x.
3. Log in to npm with an account that can publish under the `@maolaila` scope:

```sh
npm login
npm whoami
```

4. Confirm the package name is still available or owned by you:

```sh
npm view @maolaila/selvedge name version --json
```

An npm `E404` means the package has not been published yet or is not visible to
the current account.

## Prepublish Verification

Run the full local gate:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
npm publish --dry-run --access public
```

Test the generated tarball in a temporary project:

```sh
mkdir ../selvedge-smoke
cd ../selvedge-smoke
npm init -y
npm install ../selvedge/maolaila-selvedge-0.1.0.tgz
npx --no-install selvedge init
npx --no-install selvedge status
npx --no-install selvedge validate
npx --no-install selvedge dashboard --no-open --port 17371
```

If `npm pack --dry-run` was used, create a real tarball first:

```sh
cd ../selvedge
npm pack
```

## Publish

For the first public release:

```sh
npm publish --access public
```

For later releases:

```sh
npm version patch
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm build
npm publish --access public
git push origin main --follow-tags
```

## Verify After Publish

```sh
npm view @maolaila/selvedge name version dist-tags --json
mkdir ../selvedge-published-smoke
cd ../selvedge-published-smoke
npm init -y
npm install @maolaila/selvedge
npx selvedge init
npx selvedge status
```

## Notes

- `selvedge` is already occupied on npm, so the scoped package is used.
- If you prefer `@selvedge/cli`, create or join that npm organization first,
  then update `package.json`, README, and generated `selvedge.yaml` package
  name expectations before publishing.
- Auto commit and push are disabled by default; pass `--auto-push` only for
  repositories where that behavior is explicitly allowed.
