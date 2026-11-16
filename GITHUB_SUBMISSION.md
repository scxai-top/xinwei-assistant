# 提交后续修改

当前仓库为 `scxai-top/xinwei-assistant`，默认分支为 `main`，最新版本为 **1.0.0**。

## 本地提交

先确认改动范围，运行语法检查和相关测试，再提交需要上传的文件：

```sh
git status --short --branch
git remote -v
npm run check
npm test
git add <需要提交的文件>
git commit -m "说明这次改了什么"
git push origin main
```

`origin` 应指向 `https://github.com/scxai-top/xinwei-assistant.git`。需要审阅时，可以另建分支并向本仓库的 `main` 发起 Pull Request。

## 上传范围

上传公开源码、资源、测试和文档，保留 `LICENSE` 和原作者署名。不要上传 `.git`、`node_modules`、浏览器资料、账号信息、Cookie、Token、密钥、内部证据或本机绝对路径。

向原作者项目提交贡献时，按对方的仓库要求单独准备差异和验证说明；本仓库的版本号不代表原作者的发布或认可。
