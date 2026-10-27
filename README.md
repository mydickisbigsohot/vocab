# 词间 · 私密截图词卡

一张截图就是一张复习卡，支持放大查看，用“忘了 / 模糊 / 记得”安排间隔复习。当前流程不识字、不调用 AI，不需要 AI Key。

## 日常使用

1. 电脑截图放入指定文件夹，监听器待复制完成后自动同步。电脑原图不修改、不删除。
2. 手机点“添加截图”，从相册选择一张或多张；上传后其他已连接设备也能看到。
3. 看图回忆，点图片可放大；准备好后翻卡评分。到期旧卡优先，每天默认最多 15 张新卡，可在设置调整。
4. 网页联网且可见时每 15 秒同步，刷新、切回应用或恢复联网时也检查。复制与网络传输需要时间，无法保证零延迟。网页关闭时不保证后台同步。

## 隐私与首次连接

公开 Pages 仓库只有通用代码、图标和示例数据，个人截图、索引和复习进度放在独立的**私有 GitHub 仓库**。每次上传前验证目标仍为私有，图片不带原文件名和 EXIF，提交使用通用身份。

手机首次在设置填写“账号/私有仓库名”和只允许读写该仓库的 GitHub 细粒度令牌（Contents：Read and write）。这是私密同步授权，不是 AI Key。凭据仅发往 `api.github.com`；默认只留在本次页面内存，勾选“在我的个人设备上记住连接”后才存入本设备 IndexedDB。进度备份不含凭据、连接信息或图片。

关闭 GitHub 的令牌生成页面不会撤销令牌。若电脑网页已经连接，打开设置点“复制已有同步凭据”，可把已有凭据粘贴到自己的手机；不要发到聊天或公开文件。若没有此按钮，表示此网页没有可复制的凭据；若令牌已删除、撤销或过期，需要在 GitHub 重新生成并连接。

私有仓库不是端到端加密，有仓库访问权的账号或授权应用可以读取。不要把数据仓库改为公开。

## 电脑监听

需要 Python 3.10+、Pillow、已登录的 Git Credential Manager。

```powershell
python -m pip install -r requirements.txt
python scripts/watch_folder.py --dry-run
python scripts/watch_folder.py --once --max-batch 1
python scripts/watch_folder.py --watch
```

配置放在被 Git 忽略的 `.local/config.json`，不能提交：

```json
{
  "screenshotFolder": "你的截图目录",
  "privateRepo": "你的账号/你的私有词库",
  "allowPrivateSync": true,
  "allowPublicScreenshots": false,
  "watchIntervalSeconds": 5
}
```

Windows 后台启动与管理：

```powershell
powershell -File scripts/manage_watcher.ps1 -Action Start
powershell -File scripts/manage_watcher.ps1 -Action Status
powershell -File scripts/manage_watcher.ps1 -Action Stop
powershell -File scripts/manage_watcher.ps1 -Action InstallStartup
powershell -File scripts/manage_watcher.ps1 -Action RemoveStartup
```

脚本只操作本项目的精确路径；开启登录启动后无终端窗口。若系统阻止执行 PowerShell 脚本，请用 Python 命令或登录启动快捷方式，不要降低系统安全策略。详见 [监听说明](scripts/README_WATCHER.md)。

监听按原图 SHA-256 去重，宽度不超过 800px 的 WebP 去除 EXIF；失败保留本地原图和状态，下次重试。不强推，不覆盖手机新增图片或进度。

## 手机安装、离线与备份

iPhone：Safari → 分享 → 添加到主屏幕。Android：Chrome → 菜单 → 安装应用 / 添加到主屏幕。

首次联网完成同步，等设置页“离线已就绪”，再开飞行模式、关闭并重开验证。页面用 Service Worker 缓存，私密截图放在本设备 IndexedDB。离线评分本地保存，联网后合并同一词库的较新进度；不同词库进度不互相上传。

评分采用 SM-2：忘了 10 分钟后重学，成功间隔从 1 天、6 天开始，再按评分调整。可导出/导入 JSON 备份，清理网站存储前先备份。

图片不会自动生成英文单词、释义或朗读文本，可按“截图词卡 01”等编号查找。示例单词保留朗读演示。

## 部署与排查

push main 后 `.github/workflows/pages.yml` 自动测试、构建、部署。所有路径兼容 `/仓库名/`，`dist/` 只含静态应用和示例图，不含本机配置或真实截图。

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
npm run build
```

| 现象 | 处理 |
| --- | --- |
| 只有示例词 | 在设置连接自己的私密词库。GitHub 网页登录与应用读取私有图片的授权是两回事。 |
| 同步失败 | 检查网络、令牌有效期、所选私有仓库及 Contents 读写权限。 |
| 电脑新图未出现 | 查看 `watch_folder.py --status`，确认监听器运行并等待复制结束。 |
| 离线图片不全 | 联网完成同步，等“离线已就绪”。空间不足时浏览器可能回收缓存。 |
| 新界面未出现 | 关闭再重开应用，等待新 Service Worker 接管，不要先清理进度。 |
| Pages 404 | 检查 Pages Source 为 GitHub Actions、工作流成功、地址含仓库名及结尾斜杠。 |

旧 `update_words.py` / `README_PIPELINE.md` 属于此前可选识别方案；当前只运行 `watch_folder.py`，不调用旧识别入口。
