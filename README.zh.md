# @dsh-external/dsh-session-folders

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 侧栏添加**会话分组（文件夹）**：把对话整理进可嵌套、可自定义颜色与图标的文件夹。

插件会在会话列表顶部（`ui-workspace` 的 `treeBody`）注入一棵文件夹树，像文件管理器一样分层渲染。

- **整理**：文件夹支持嵌套、自定义颜色、自定义图标与折叠状态记忆。
- **交互**：右键菜单「移动到分组」、把会话拖拽到文件夹、以及批量选择模式。
- **隐藏**：已分组的会话从原生列表移除，改为在文件夹内以自有行渲染；点击时通过 `ctx.sessions.open` 打开。
- **持久化**：host 侧提供只读 / 变更 REST API（通过单调递增的 `version` 做乐观并发控制），数据写入 `~/.dsh/profiles/web/session-folders.json`。
- **干净**：纯 DOM 注入、零依赖，所有副作用都由 `ctx.effect` disposer 清理，卸载即净。

## 安装

```sh
dsh plugin --profile web add github:wakeup595626-cmyk/dsh-session-folders
```

## 使用

打开 Web UI，使用会话列表上方的文件夹树。REST API 位于 `/@dsh-external/dsh-session-folders/api`。

## 环境要求

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，并使用 `web` profile

## 第三方声明

无第三方运行时依赖；client 侧是针对 DeepSeek Harness client runtime 的原生 DOM 实现。

See [THIRD_PARTY_NOTICES.zh.md](THIRD_PARTY_NOTICES.zh.md).

## 社区与支持

- Report bugs and ask questions through [GitHub Issues](https://github.com/wakeup595626-cmyk/dsh-session-folders/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## 参与贡献

See [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md).

## 引用

```bibtex
@misc{dsh-session-folders,
  title={dsh-session-folders},
  author={wakeUp595626-cmyk},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/wakeup595626-cmyk/dsh-session-folders}},
}
```

## 许可证

[MIT](LICENSE)
