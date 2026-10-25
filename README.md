# 词间 · 截图单词学习系统

英语截图 → 视觉识别 → 词库 → GitHub Pages → 手机间隔复习。原生 JS，无前端依赖，无后端；附 5 个明确标注的示例词卡。

本项目先用 5 个示例单词验证学习与离线流程。公开部署仅包含通用代码和示例数据；个人截图、个人词库和复习进度不属于演示发布内容。接入真实内容前，需先完成私密存储与访问保护。

## 1. 首次部署（只用示例词）

需要 Git、Node.js 22+、Python 3.10+。所有命令在此 README 所在的 `vocab` 文件夹运行。

推荐通过已连接的 GitHub 账号创建 **公开、空的 `vocab` 仓库**，上传此目录的源文件（包括 `.github`、`.gitignore`）。`dist/`、`.local/`、原截图和密钥不应上传。仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。推送 `main` 后，`.github/workflows/pages.yml` 自动测试、构建和发布。

也附有环境变量 Token 方式的部署助手（不需要将凭据发给聊天）：

```powershell
python scripts/deploy_github.py --repo vocab
# 上一条只显示计划。自行在本机环境变量配置 GITHUB_TOKEN 或 GH_TOKEN 后：
python scripts/deploy_github.py --repo vocab --deploy
python scripts/deploy_github.py --repo vocab --status
```

助手只允许发布原始 5 个示例词，拒绝覆盖无关的同名仓库，不强推。首次推送所用凭据只在子进程环境中使用；后续 `update_words.py` 的推送需要本机 Git Credential Manager 已登录，或在终端手动完成 Git 登录。不要把 Token 填进远程 URL、代码、命令历史或仓库。助手不代替 GitHub Actions 成功检查。

最终地址以仓库 **Settings → Pages / Actions 成功部署返回的 URL** 为准，格式通常为 `https://你的GitHub用户名.github.io/vocab/`。程序的资源、manifest、Service Worker 均使用相对路径，支持更换仓库名。

**验证永久托管与离线：**

1. 在手机正式浏览器打开成功部署的 Pages 地址，确认 5 张示例卡可翻面、评分。
2. 设置页等待“离线已就绪”（页面、词库、所有图片均已缓存）。手机开启飞行模式，彻底关闭再重新打开应用，验证翻卡、截图和评分；重开后确认进度仍在。离线语音需要手机已安装英语语音包。
3. 关闭电脑，手机关闭飞行模式、使用移动数据，通过无痕窗口首次打开该 Pages 地址。这样验证的是 GitHub 远程托管，而非本机或手机已有缓存。
4. 以后 push 成功后确认 Actions 为绿色；手机联网点“更新词库”。新词会加入，已学进度保留。应用关闭期间不能主动同步，重新打开或恢复联网时会检查。

## 2. 手机使用

- **先回忆再翻卡**。看完释义、例句，可展开截图来源，然后选忘了 / 模糊 / 记得。
- 采用三按钮 SM-2：评分分别映射 1 / 3 / 5；忘了进入 10 分钟重学；成功间隔从 1 天、6 天开始，再按记忆难度调整。到期旧词优先。它是一种间隔复习方法，不承诺精确预测个人的遗忘曲线。
- 每天默认最多 15 个新词，设置可改成 0–200；0 表示只复习旧词。“今日已学”按当天不同单词计数，多次评分不重复计数；连续天数按设备本地日期计算。
- iPhone：Safari → 分享 → 添加到主屏幕。Android：Chrome 菜单 → 安装应用 / 添加到主屏幕。微信内置浏览器请用“在浏览器打开”。
- 定期在设置导出 JSON 进度备份；换手机后导入。导入合并较新的复习记录，不清空原进度。清理网站存储前先备份。

**同步范围：手机和电脑共享词库，复习进度各自存在 IndexedDB。** 纯静态 + IndexedDB 不提供跨设备实时进度同步；本版用导出 / 导入迁移或合并。Safari、Chrome、主屏幕应用可能拥有独立存储，不同域名或仓库名也是独立进度空间。需要自动共享复习进度时，应另外增加带身份认证的数据服务，或转用支持同步的 Anki。

## 3. 电脑每次更新截图

通用默认目录为桌面的 `screenshots`，支持桌面重定向和子目录。你的实际截图目录只写入被 Git 忽略的 `.local/config.json` 的 `screenshotFolder`，或由环境变量 `VOCAB_SCREENSHOT_DIR` / `--folder` 指定，不能写进公开代码或说明。

```powershell
python -m pip install -r requirements.txt
# 在本机环境变量配置 OPENAI_API_KEY；不要把真实 Key 发到聊天或写入仓库。
python scripts/update_words.py --dry-run
python scripts/update_words.py --prepare --limit 3
```

打开 `.local/pipeline/preview.html` 检查识别与图片。确认这批内容可公开后：

```powershell
python scripts/update_words.py --publish-prepared --approve-images
```

今后所有新截图都已检查可公开时，一条命令完成识别 → 合并 → 压缩 → commit → push：

```powershell
python scripts/update_words.py --publish --approve-images
```

Key 只从环境变量读取；模型可由 `OPENAI_MODEL` 改选，默认 `gpt-4.1-mini`。识别会将压缩图片发送给 OpenAI，API 按用量计费；演示词库无需 Key。仅新增内容调用 API，SHA-256 检查避免同图重命名后再次识别。`.local/` 是本机配置、处理记录和预览，请保留并私下备份，不能上传。脚本提交固定使用通用作者 / 提交者，并禁用本次签名，不继承系统中的私人姓名、邮箱和签名身份。

公开仓库与 Pages 上的词库、压缩截图人人可看。**压缩和去除 EXIF 不会遮挡截图里的隐私文字**；先裁剪到单词区域，再运行识别。有误识别时先改好预览里的候选数据或公开 `data/words.json`，词条身份按单词的大小写 / 空格归一确定，不要随意改词名。自动脚本保留同词已有释义，避免覆盖人工修改；同词多义目前合并为一张卡。

完整操作、失败恢复见 [电脑脚本说明](scripts/README_PIPELINE.md)。本版每次运行命令才处理新增截图，不会在后台持续监视文件夹。

## 4. 常见问题

| 现象 | 处理 |
| --- | --- |
| Pages 404 | 等待 Actions 成功；确认仓库 Pages Source 为 GitHub Actions，地址含仓库名和结尾 `/`。 |
| 手机没新词 | 先确认 push 和 Actions 都成功，再联网打开，点“更新词库”；失败时保留旧词库。 |
| 离线图片缺失 | 联网点更新，设置页确认“离线已就绪”；首次打开尚未缓存完成时不要断网。浏览器仍可能因存储空间不足回收缓存。 |
| 新页面未出现 | 关闭后重新打开，应用检测到新 Service Worker 后会刷新；进度保存在独立数据库。先导出备份再排查。 |
| 声音没出来 | 点击听发音；检查静音 / 音量 / 英语语音包；部分浏览器语音联网才可用。 |
| 进度看似丢失 | 确认同一网址、同一浏览器 / 主屏幕入口、非无痕模式；从备份导入。单词改名会成为新卡。 |
| API 401 / 429 | 分别检查 Key / 额度与限速；不要将错误日志连同 Key 上传。 |
| Git push 失败 | 检查 Git 登录与远程权限；数据和提交会保留，可重试，不会重新识别。遇远程新提交先确认再 rebase；不强推。 |

## 5. 开发与数据结构

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py" -v
npm run build
```

`dist/` 只含静态应用、公开词库和图片，不含 Python、环境变量或原截图。构建清理旧产物，按全部静态内容生成缓存版本；离线缓存按仓库子路径隔离。数据更新不删除 IndexedDB 进度。

`data/words.json` 是数组，每项包含字符串字段 `word / phonetic / meaning / example / image / addedAt`，图片为 `images/...`，日期用 ISO 8601。进度以归一化单词为键。应用无外部字体、CDN 或浏览器端 API Key。

参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[OpenAI 官方图片输入文档](https://developers.openai.com/api/docs/guides/images-vision)。
