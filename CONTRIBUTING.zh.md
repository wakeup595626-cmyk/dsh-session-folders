# 参与贡献

[English](CONTRIBUTING.md) | 中文

感谢你有兴趣为 `@dsh-external/dsh-session-folders` 贡献代码！

这是一个由单人维护的小型插件，欢迎任何规模的贡献报告 bug 和修正文档，与提交代码同样有价值。

## 可以怎么贡献

- **报告问题** — 在 [GitHub Issues](https://github.com/wakeup595626-cmyk/dsh-session-folders/issues) 提交，请附上你的 DeepSeek Harness 版本、复现步骤，以及你期望的结果。
- **提出需求** — 欢迎描述你想解决的问题，而不只是你设想的方案。
- **改进文档** — README 同时提供英文与中文两份，任何一侧的修正都欢迎。
- **提交 PR** — 见下文。

## 本地开发

```sh
git clone https://github.com/wakeup595626-cmyk/dsh-session-folders.git
cd dsh-session-folders
```

插件直接从 `lib/` 加载，因此本地检出无需构建步骤。要测试改动，把本地目录装入 profile：

```sh
dsh plugin --profile web add <你的检出目录>
```

## 提交 PR

- 每个 PR 只做一件事。
- 请保持既有代码风格；本插件刻意不引入第三方运行时依赖，如需新增请先讨论。
- 若改动了文档中描述的行为，请同时更新 `README.md` 与 `README.zh.md`。
- 请说明你验证了什么、如何验证。

## 许可证

提交贡献即表示你同意：你的贡献将以本项目所采用的 [MIT](LICENSE) 许可协议授权。
