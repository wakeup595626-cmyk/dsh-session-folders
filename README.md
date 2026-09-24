# @dsh-external/dsh-session-folders

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds **session folders** to the Web sidebar  nest conversations into colour- and icon-tagged folders.

A folder tree is injected at the top of the session list (`ui-workspace`'s `treeBody`), rendered like a file manager.

- **Organise**  folders support nesting, custom colour, custom icon and a remembered collapse state.
- **Interact**  right-click "move to folder", drag a session onto a folder, and a batch-select mode for moving many at once.
- **Hide**  grouped sessions are removed from the native list and rendered as their own rows inside their folder; clicking one opens it through `ctx.sessions.open`.
- **Persist**  the host exposes read/change REST APIs (with optimistic concurrency via a monotonic `version`) writing to `~/.dsh/profiles/web/session-folders.json`.
- **Clean**  pure DOM injection with zero dependencies; every side effect is disposed by a `ctx.effect` disposer, so unloading leaves nothing behind.

## Install

```sh
dsh plugin --profile web add github:wakeup595626-cmyk/dsh-session-folders
```

## Usage

Open the Web UI and use the folder tree above the session list. The REST API is served at `/@dsh-external/dsh-session-folders/api`.

## Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation with the `web` profile

## Third-party notices

No third-party runtime dependencies. The client half is plain DOM against the DeepSeek Harness client runtime.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community and support

- Report bugs and ask questions through [GitHub Issues](https://github.com/wakeup595626-cmyk/dsh-session-folders/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Citation

```bibtex
@misc{dsh-session-folders,
  title={dsh-session-folders},
  author={wakeUp595626-cmyk},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/wakeup595626-cmyk/dsh-session-folders}},
}
```

## License

[MIT](LICENSE)
