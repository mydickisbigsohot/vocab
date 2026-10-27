# 电脑自动截图同步

监听程序把新增截图上传到**已验证为私有**的独立数据仓库，公开网页仓库不保存截图。每批上传将压缩图片和截图词卡索引一起提交；提交成功后，手机联网刷新即可获取新卡片，无需等待后台处理任务。

本机设置放在被 Git 忽略的 `.local/config.json`：

```json
{
  "screenshotFolder": "你的本机截图目录",
  "privateRepo": "你的账号/私有数据仓库",
  "allowPrivateSync": true,
  "allowPublicScreenshots": false,
  "watchIntervalSeconds": 5,
  "watchBatchSize": 12
}
```

Git Credential Manager 需要已登录并有私有数据仓库的写入权限。凭据只在进程内读取，不写入配置、日志、代码或图片文件名。不要把实际配置文件或认证信息提交到公开仓库。

```powershell
python scripts/watch_folder.py --dry-run
python scripts/watch_folder.py --once
python scripts/watch_folder.py --once --max-batch 1
python scripts/watch_folder.py --watch
python scripts/watch_folder.py --status
```

`--dry-run` 只统计新增图片，不联网、不读取凭据、不写文件。`--once` 等待文件连续两次大小与修改时间不变，再上传一批；每批默认最多 12 张，可由 `watchBatchSize` 或 `--max-batch` 调整为 1–30 张。持续监听会处理后续批次。默认每 5 秒检查，不叠加线程。首次启动会将现有图片也视为待同步。

- 原图始终留在原目录；上传图片压缩为宽度不超过 800px 的 WebP，去除 EXIF，不上传原文件名。
- 图片保存在私有仓库的 `images/<内容哈希>.webp`，索引保存在 `data/words.json`。词卡以图片为主，使用内容哈希作为稳定标识，不生成释义或例句。
- 使用原文件内容的 SHA-256 去重，同图改名或移动不会再次上传。状态保存在 `.local/watcher-state.json`。
- 一批图片和索引只创建一个通用身份的 Git 提交，避免手机看到只有索引却缺图片的中间状态。若手机同时上传或写入学习进度，重新读取最新分支和词卡索引、合并新图片，不强推。
- 每批上传前再次确认远程仓库是私有的；若变成公开仓库，立即停止上传。
- 网络失败不标记完成，下次检查重试。异常信息只保存通用错误码，不包含截图内容、路径或 Token。
- 将 `allowPrivateSync` 改为 `false` 可停止后续上传；重新启用后需重新启动程序。
- `.local/watcher-status.json` 覆盖保存最近状态，无需持续日志。`github_authentication_required` 表示需要完成本机 Git 登录；`github_permission_required` 表示凭据无对应仓库权限；`public_repository_blocked` 表示远程隐私保护阻止上传。

启动项由首次本机部署单独配置；本脚本不会自行安装启动项，不改变系统网络、浏览器或 Git 全局设置。
