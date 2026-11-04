# wake-grokbot

[English](README.md)

一个没有运行时依赖的小命令行工具：让"派活的"（dispatcher）和"干活的"（worker）两个 AI 助手通过本地收件箱互相交接任务，
有新消息时去"敲一下门"（唤醒），比如唤醒一个 Grok Bot 例程。

- 收件箱才是准的。唤醒只是提醒，结果永远从收件箱里读。
- 消息格式是一个小协议 [`wake-envelope/1`](docs/protocol.md)，带 JSON Schema。
- 默认安全：配置和消息里不放密钥和网址；输出自动打码；不跟随重定向；有频率上限和紧急停止开关。
- 需要 Node.js 22 以上，Windows / macOS / Linux 都能用。

## 快速开始

```sh
npx wake-grokbot init        # 生成示例配置和收件箱目录
# 把例程的网址和密钥放进环境变量：WAKE_GROKBOT_URL、WAKE_GROKBOT_KEY
# （不要写进配置，也不要写在命令行参数里）
npx wake-grokbot doctor      # 自检，不打印任何密钥
npx wake-grokbot guide       # 中文使用指引
```

派活：

```sh
npx wake-grokbot send --to worker --title "整理说明" --objective "把安装部分写清楚"
npx wake-grokbot send --json < task.json
```

干活：

```sh
npx wake-grokbot ack <id>
npx wake-grokbot reply <id> --status done --summary "已改好并验证" --body-file result.md
```

## 命令

| 命令 | 作用 |
|---|---|
| `send --json` | 收下一个信封，写进收件箱并生成回执，然后唤醒对方。同 id 同内容重复发送不会重复写（退出码 0）；同 id 不同内容退出码 7。 |
| `ingest --from <名字>` | 和 send 一样，但用于配置里登记过的外部来源，可要求签名。 |
| `status <id>` | 查看回执：状态、唤醒结果、回复、下一步 `next`。`--mark-wake` 用于手动核对"结果未知"的唤醒。 |
| `ack <id>` | 表示"收到，开始干"，消息移到已读，释放唤醒占位。 |
| `reply <id>` | 回复任务：写回答信封、更新回执、按任务指定的方式投递结果、需要时唤醒派活方。 |
| `watch` | 把排队的唤醒发出去（重试、退避、限流）。适合放进定时任务。 |
| `release` | 被唤醒的那一轮干完了：释放占位，把期间排队的消息合成一次唤醒发出去。 |
| `prune` | 列出（加 `--apply` 才删除）N 天前已处理完的消息、回执和回复。 |
| `init` | 生成示例配置（不覆盖已有的）并创建收件箱。 |
| `guide` | 中文指引。 |
| `doctor` | 检查 Node、配置、收件箱、唤醒通道和紧急停止开关，不发送任何东西。加 `--dry-run` 会显示将要发送的请求（网址和密钥隐藏）。 |

退出码：0 成功，1 规则拒绝，2 用法/配置错误，3 内部错误，4 签名错误，5 已写入但没唤醒成功（或结果投递失败），
6 唤醒结果未知（不要重发），7 同一 id 内容不同。

## 结果投递方式（reply_to.sink）

- `file`：写成文件。
- `webhook`：POST 到配置里登记的地址，带 HMAC-SHA256 签名头。
- `command`：运行配置里登记的命令，结果从标准输入传进去。
- `hufu-report`：写一个"Hufu 式报告文件"。第一行以状态词开头（进展、等待、就绪、受阻、失败、无需处理），
  后面接一句话总结；需要人决定时第二行是 `待人工决定：…`；再往下是正文。报告写完后才创建 `<报告>.DONE` 标记。
  报告路径必须在配置允许的目录里。

## 配置文件在哪

按顺序找，找到第一个就用：

1. `--config <文件>`
2. 环境变量 `WAKE_GROKBOT_CONFIG`
3. 当前目录下的 `./wake-grokbot.json`
4. 用户配置目录里的 `wake-grokbot.json`（Windows 是 `%APPDATA%\wake-grokbot\`）

用 1 或 2 指定时文件必须存在。找不到目标或配置时，报错会写明用的是哪个配置文件、找过哪些位置。

Windows 上，如果环境变量是用 `[Environment]::SetEnvironmentVariable(..., 'User')` 设的、当前窗口还没生效，
程序会自动从注册表里的用户变量、再到系统变量去读。`doctor` 会显示每个变量是从哪里读到的（进程/用户/系统/缺失），不显示值。

## 紧急停止

设置环境变量 `WAKE_GROKBOT_DISABLED=1`，或在状态目录放一个名为 `disabled` 的文件。消息照常写入，只是不再唤醒。

## 许可证

MIT
