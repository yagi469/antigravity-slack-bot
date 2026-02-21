# Discord → Slack Bot 変換 ウォークスルー

## 変更概要

Discord Bot (`discord_bot.js`) を Slack Bot (`slack_bot.js`) に全面変換しました。CDPによるAntigravity操作ロジックは完全に維持しています。

## 変更されたファイル

| ファイル | 変更内容 |
|---|---|
| [package.json](file:///c:/Users/user/Dev/antigravity-slack-bot/package.json) | `discord.js` → `@slack/bolt`、名前・スクリプト変更 |
| [slack_bot.js](file:///c:/Users/user/Dev/antigravity-slack-bot/slack_bot.js) | **新規作成**: Slack Bot メインファイル（~1150行） |
| [.env.example](file:///c:/Users/user/Dev/antigravity-slack-bot/.env.example) | Slack用環境変数に更新 |
| [start_bot.bat](file:///c:/Users/user/Dev/antigravity-slack-bot/start_bot.bat) | 起動スクリプト変更 |
| [SPECIFICATION.md](file:///c:/Users/user/Dev/antigravity-slack-bot/SPECIFICATION.md) | Slack Bot仕様に更新 |
| [README.md](file:///c:/Users/user/Dev/antigravity-slack-bot/README.md) | Slack Bot セットアップ手順に更新 |

## `slack_bot.js` の主要機能

- **Socket Mode** で動作（公開URL不要）
- **スラッシュコマンド**: `/ag-help`, `/ag-screenshot`, `/ag-stop`, `/ag-newchat`, `/ag-status`, `/ag-title`, `/ag-model`, `/ag-mode`
- **メッセージ処理**: DMで送信→CDPでAntigravityに注入→AI応答をポーリング→Slackに返信
- **承認ボタン**: Block Kit の `actions` ブロックで ✅ Approve / ❌ Reject ボタン
- **ファイル処理**: `files.uploadV2` / `url_private` ダウンロード
- **ファイル監視**: chokidar による変更検知→Slack通知
- **ユーザー制限**: `SLACK_ALLOWED_USER_ID` による認証

## 検証結果

- ✅ `npm install` 成功（125パッケージ、脆弱性なし）
- ✅ `node --check slack_bot.js` 構文チェックパス

## 次のステップ（ユーザー作業）

1. [Slack API](https://api.slack.com/apps) で新規 App を作成
2. Socket Mode 有効化、App-Level Token 取得
3. Bot Token Scopes 設定（`chat:write`, `commands`, `files:read`, `files:write`, `reactions:write`）
4. `.env` に `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USER_ID` を設定
5. `npm start` で起動
