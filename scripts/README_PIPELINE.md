# 电脑截图更新脚本

需要 Python 3.10+、Git，首次安装：`python -m pip install -r requirements.txt`。截图目录按以下顺序读取（含子目录）：`--folder` 参数、`VOCAB_SCREENSHOT_DIR` 环境变量、本机 `.local/config.json` 中的 `screenshotFolder`，最后使用当前桌面的 `screenshots` 文件夹。个人目录只保存在被 Git 忽略的本机配置中，不写入公开代码。

例如，在项目的 `.local/config.json` 保存 `{"screenshotFolder":"screenshots"}`，相对路径以项目目录为基准；也可填写本机绝对路径。此文件不要上传。

可在这个本机配置中加入 `"allowPublicScreenshots": false`，硬性禁用公开截图发布。此时 `--publish` 和 `--publish-prepared` 会在识别联网、修改词库、提交或推送之前停止，`--approve-images` 也不能覆盖。未配置此字段时仍按下文的显式确认流程执行。`--prepare` 只生成本机预览，但仍会把图片发送给视觉 API。

## 首次配置

在项目目录的 PowerShell 中设置当前会话的 Key（别把真实值保存进任何文件）：

```powershell
$env:OPENAI_API_KEY = "你的 API Key"
$env:OPENAI_MODEL = "gpt-4.1-mini"
```

默认模型为 gpt-4.1-mini；可改为你有权限且支持图片输入、Responses API 和 JSON Schema 的模型。API 按用量收费，ChatGPT 订阅不等于 API 余额。Key 只从环境变量读取，脚本不将其落盘，前端也没有 Key。

## 推荐的每次更新

1. 先检查哪些图尚未处理（不联网、不写文件）：

   ```powershell
   python scripts/update_words.py --dry-run
   ```

2. 只识别新图并生成本机预览，首次建议最多 3 张：

   ```powershell
   python scripts/update_words.py --prepare --limit 3
   ```

3. 打开 `.local/pipeline/preview.html`，检查词义、例句和每张压缩截图。压缩不会遮挡姓名、聊天、账号等隐私；有隐私时，先处理原截图并重新运行。预览和处理记录均被 Git 忽略。

4. 确认适合公开后，一条命令更新词库 → commit → push：

   ```powershell
   python scripts/update_words.py --publish-prepared --approve-images
   ```

今后当文件夹中所有新增截图都已自行检查可公开时，也可一条命令完成识别到推送：

```powershell
python scripts/update_words.py --publish --approve-images
```

`--approve-images` 是你对本次公开压缩截图的确认；不要在含未检查隐私图的目录使用它。真实图会发送给 OpenAI 做识别；即使只 prepare 也会使用视觉 API。示例词库不需要 Key。

## 行为与恢复

- 内容 SHA-256 去重：重命名、移动、复制同一张图不会重复付费。改动图片内容后会重新识别。
- 每张图成功后原子保存 `.local/pipeline/state.json`；失败图不会标记完成。空识别结果保留重试机会。
- 单词按 Unicode NFC、大小写、连续空格归一去重，与网页进度标识规则一致；同词保留词库已有内容和 addedAt。相同词的不同词义目前合为一张卡，可人工编辑释义。
- 只上传宽度不超过 800px 的 WebP；去除 EXIF，原始图片不复制到仓库。重复词不会额外上传无引用截图。
- Git 只暂存 `data/words.json` 和本批引用的压缩图片；已有其他暂存内容时停止。要求项目自己的仓库、main 分支、origin 远程。
- 脚本提交统一使用匿名作者与提交者 `Vocabulary Builder <builder@users.noreply.github.com>`，覆盖继承的 Git 姓名、邮箱环境变量，并关闭本次提交的签名，避免关联个人签名身份；不修改全局 Git 配置。
- push 失败后数据和本地提交仍在，运行 `--publish-prepared --approve-images` 可再次推送，不会重新识别或付费。不自动 force push；远程有新提交时自行确认后 `git pull --rebase`。
- 提交失败：检查 `git status` 和 Git 用户名/邮箱。脚本保留预览、数据和暂存文件；修复后先提交或取消暂存，再重试。
- 同时只允许运行一个更新进程；异常断电留下锁时，确认脚本已退出后再删除 `.local/pipeline/update.lock`。
- 不要删除 `.local`，它是本机防重复收费记录。换电脑可私下迁移 `.local/pipeline`；不要上传公开仓库。
- 图像识别可能出错，预览中必须人工检查。800px 缩放后过小的字，请先裁剪成单词区域。
- API 401：Key；429：额度/限速；模型无权限：改 OPENAI_MODEL；网络错误：先确认现有网络可访问 API，脚本不会修改系统网络配置。

脚本不会后台监视文件夹；每次截图后运行更新命令，GitHub Actions 部署成功后手机联网打开应用会拉取新词。

官方接口依据：[图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)。
