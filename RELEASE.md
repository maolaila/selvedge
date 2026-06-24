# 发布指南

Selvedge 当前以 `@maolaila/selvedge` 这个 npm 包名发布，并暴露
`selvedge` 命令行入口。

## 发布前准备

1. 使用 Node.js 20 或更新版本。
2. 安装 pnpm 9.x。
3. 使用有权限发布 `@maolaila` scope 的 npm 账号登录：

```sh
npm login
npm whoami
```

4. 确认包名仍可用，或者当前账号有权限管理该包：

```sh
npm view @maolaila/selvedge name version --json
```

如果 npm 返回 `E404`，通常表示这个包还没有发布，或者当前账号看不到该包。

## 发布前验证

先跑完整本地检查：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
npm publish --dry-run --access public
```

再用打包产物在一个临时项目里试装：

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

如果前面只跑了 `npm pack --dry-run`，它不会留下真实 tarball。需要先回到
Selvedge 仓库生成实际包文件：

```sh
cd ../selvedge
npm pack
```

## 正式发布

第一次公开发布：

```sh
npm publish --access public
```

后续 patch 版本发布：

```sh
npm version patch
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm build
npm publish --access public
git push origin main --follow-tags
```

## 发布后验证

```sh
npm view @maolaila/selvedge name version dist-tags --json
mkdir ../selvedge-published-smoke
cd ../selvedge-published-smoke
npm init -y
npm install @maolaila/selvedge
npx selvedge init
npx selvedge status
```

## 注意事项

- `selvedge` 这个非 scope 包名已经被 npm 上的其它包占用，所以当前使用
  `@maolaila/selvedge`。
- 如果后续想改成 `@selvedge/cli`，需要先创建或加入对应 npm organization，
  然后同步修改 `package.json`、README，以及 `selvedge init` 生成的
  `selvedge.yaml` 里的包名期望。
- 默认不会自动 commit 或 push。只有在仓库策略明确允许时，才给运行命令传
  `--auto-push`。
