# Discord Bot → Slack Bot 変換計画

Antigravity (VS Code Fork) を遠隔操作するBotを Discord版から Slack版に全面書き換えする。
CDPによるAntigravityの操作ロジックは完全に維持し、メッセージングプラットフォーム層のみ差し替える。

## User Review Required

> [!IMPORTANT]
> **Socket Mode を採用します**
> Slack Bot は **Socket Mode** で動作します。これにより公開URLが不要で、ローカル環境でそのまま動作します（Discord版と同様の利便性）。

> [!IMPORTANT]
> **Slack Appの事前作成が必要です**
> Botを動作させるには [Slack API](https://api.slack.com/apps) で App を作成し、以下のトークンを取得する必要があります：
> - **Bot Token** (`xoxb-...`): OAuth & Permissions で取得
> - **App-Level Token** (`xapp-...`): Socket Mode用に Basic Information → App-Level Tokens で生成
> - **Signing Secret**: Basic Information → App Credentials から取得

> [!WARNING]
> **`discord_bot.js` は削除して `slack_bot.js` を新規作成します**
> 元のDiscord版は不要になるため削除します。必要であれば Git 履歴から復元可能です。

---

## Proposed Changes

### 依存パッケージ

#### [MODIFY] [package.json](file:///c:/Users/user/Dev/antigravity-slack-bot/package.json)

- `discord.js` → `@slack/bolt` に差し替え
- `name` を `ag-slack-bot` に変更
- `description` を Slack 用に更新
- `scripts.start` / `scripts.dev` を `node slack_bot.js` に変更

```diff
-    "name": "ag-mobile-monitor",
+    "name": "ag-slack-bot",
-    "description": "Mobile web interface for monitoring Antigravity chat via visual snapshots",
+    "description": "Slack bot for remotely controlling Antigravity via CDP",
     "scripts": {
-        "start": "node discord_bot.js",
-        "dev": "node discord_bot.js"
+        "start": "node slack_bot.js",
+        "dev": "node slack_bot.js"
     },
     "dependencies": {
+        "@slack/bolt": "^4.0.0",
         "chokidar": "^5.0.0",
-        "discord.js": "^14.25.1",
         "dotenv": "^16.6.1",
         "ws": "^8.18.0"
     },
```

---

### メインボットファイル

#### [DELETE] [discord_bot.js](file:///c:/Users/user/Dev/antigravity-slack-bot/discord_bot.js)

#### [NEW] [slack_bot.js](file:///c:/Users/user/Dev/antigravity-slack-bot/slack_bot.js)

全面書き換え。以下の構造で作成：

**1. 初期化部分**
```javascript
import pkg from '@slack/bolt';
const { App } = pkg;

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});
```

**2. CDP関連関数（そのまま移植）**

以下の関数は `discord_bot.js` からほぼそのまま転記：
- `getJson`, `discoverCDP`, `connectCDP`, `ensureCDP`
- `injectMessage`, `checkIsGenerating`, `checkApprovalRequired`, `clickApproval`
- `getLastResponse`, `getScreenshot`, `stopGeneration`, `startNewChat`
- `getCurrentModel`, `getCurrentTitle`, `getModelList`, `switchModel`
- `getCurrentMode`, `switchMode`
- `logInteraction`, `setTitle`（ログ用）
- `downloadFile`, `ensureWatchDir`

**3. スラッシュコマンドのマッピング**

| Discord (旧) | Slack (新) | 実装方法 |
|---|---|---|
| `/help` | `/ag-help` | `app.command('/ag-help', ...)` + `ack()` + `respond()` |
| `/screenshot` | `/ag-screenshot` | `ack()` → CDP Screenshot → `client.files.uploadV2()` |
| `/stop` | `/ag-stop` | `ack()` → `stopGeneration()` → `respond()` |
| `/newchat` | `/ag-newchat` | `ack()` → `startNewChat()` → `respond()` |
| `/title` | `/ag-title` | `ack()` → `getCurrentTitle()` → `respond()` |
| `/status` | `/ag-status` | `ack()` → モデル&モード取得 → `respond()` |
| `/model` | `/ag-model` | `ack()` → 引数解析 → 一覧or切替 → `respond()` |
| `/mode` | `/ag-mode` | `ack()` → 引数解析 → 表示or切替 → `respond()` |

> [!NOTE]
> Slack ではスラッシュコマンドにプレフィックスが必要なため、`/ag-` プレフィックスを付けます。
> コマンド名はSlack App設定画面で事前に登録する必要があります。

**4. メッセージイベント**

```javascript
app.message(async ({ message, say, client }) => {
    // botメッセージを無視
    if (message.subtype) return;
    // 許可ユーザーチェック
    if (message.user !== process.env.SLACK_ALLOWED_USER_ID) return;
    
    // ファイル添付処理
    // テキスト注入 → monitorAIResponse()
});
```

**5. 承認ボタン（Block Kit）**

Discord の `ActionRowBuilder + ButtonBuilder` を Slack Block Kit に変換：

```javascript
// 承認要求メッセージ
const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Approval Required*\n\`\`\`${approval.message}\`\`\`` } },
    {
        type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, style: 'primary', action_id: 'approve_action' },
            { type: 'button', text: { type: 'plain_text', text: '❌ Reject' }, style: 'danger', action_id: 'reject_action' },
        ]
    }
];

// ボタンアクションハンドラ
app.action('approve_action', async ({ ack, body, client }) => {
    await ack();
    await clickApproval(cdp, true);
    // メッセージを更新してボタンを削除
});

app.action('reject_action', async ({ ack, body, client }) => {
    await ack();
    await clickApproval(cdp, false);
});
```

**6. ファイル監視**

通知先を Discord チャンネルから Slack チャンネルに変更：
```javascript
// ファイル変更通知
await app.client.chat.postMessage({
    channel: lastActiveChannel,
    text: `📁 *File Updated:* \`${path.basename(filePath)}\``
});

// ファイル添付（8MB以下）
await app.client.files.uploadV2({
    channel_id: lastActiveChannel,
    file: fs.createReadStream(filePath),
    filename: path.basename(filePath),
});
```

**7. AI応答監視ループ (`monitorAIResponse`)**

ロジックは同一。返信方法のみ変更：
- `originalMessage.reply(...)` → `app.client.chat.postMessage({ channel, thread_ts, text })`
- 2000文字制限の分割ロジックは維持（Slackのメッセージ制限は約4000文字）
- 承認ボタンの送信を Block Kit 形式に変更

---

### 設定ファイル

#### [MODIFY] [.env.example](file:///c:/Users/user/Dev/antigravity-slack-bot/.env.example)

```diff
-DISCORD_BOT_TOKEN=ここにあなたのDiscord Botトークン
-DISCORD_ALLOWED_USER_ID=操作を許可するDiscordユーザーID
+SLACK_BOT_TOKEN=xoxb-で始まるBot User OAuth Token
+SLACK_SIGNING_SECRET=Signing Secret (Basic Information → App Credentials)
+SLACK_APP_TOKEN=xapp-で始まるApp-Level Token (Socket Mode用)
+SLACK_ALLOWED_USER_ID=操作を許可するSlackユーザーID (例: U01ABCDEF)
 WATCH_DIR=監視したいフォルダパス（空欄の場合は監視機能が無効になります）
```

#### [MODIFY] [start_bot.bat](file:///c:/Users/user/Dev/antigravity-slack-bot/start_bot.bat)

- `discord_bot.js` → `slack_bot.js` に変更
- 表示テキストを更新

---

### ドキュメント

#### [MODIFY] [SPECIFICATION.md](file:///c:/Users/user/Dev/antigravity-slack-bot/SPECIFICATION.md)

- タイトルを「Antigravity Slack Bot 仕様書」に変更
- アーキテクチャ図の Discord を Slack に差し替え
- コンポーネント説明を `@slack/bolt` に変更
- 環境変数を Slack 用に更新

#### [MODIFY] [README.md](file:///c:/Users/user/Dev/antigravity-slack-bot/README.md)

- 全体を Slack Bot 用に書き換え
- Discord Developer Portal → Slack API の手順に変更
- バッジを Slack/Bolt に変更
- セットアップ手順を Socket Mode ベースに変更
- コマンド一覧を `/ag-` プレフィックス付きに変更

---

### テストファイル

テストファイル（`tests/` ディレクトリ、`test_logic.js`、`test_dropdown.js`）は **CDP テスト** であり、Discord/Slack に依存しないため変更不要。

#### [MODIFY] [selectors.js](file:///c:/Users/user/Dev/antigravity-slack-bot/selectors.js)

変更なし（CDPセレクタはプラットフォーム非依存）

---

## Verification Plan

### 自動テスト

既存のテストファイルは CDP の DOM 操作テストであり、Slack/Discord に依存しないため、そのまま実行可能：

```bash
node test_logic.js      # モデルリスト取得テスト
node test_dropdown.js   # ドロップダウン操作テスト
```

> [!NOTE]
> これらのテストは Antigravity がデバッグモードで起動している必要があります。

### 手動検証

以下の手順でBotの動作を確認します（Slack App と Antigravity がセットアップ済みであること前提）：

1. **起動確認**: `node slack_bot.js` でエラーなく起動し、`⚡️ Bolt app is running!` が表示されること
2. **コマンド応答**: Slackの任意のチャンネルで `/ag-help` を実行し、コマンド一覧が表示されること
3. **メッセージ転送**: ボットにメンションまたはDMでテキストを送信し、Antigravityにテキストが注入されること
4. **スクリーンショット**: `/ag-screenshot` でスクリーンショットがSlackに投稿されること

> [!IMPORTANT]
> 手動テストには Slack App の事前作成とトークン設定が必要です。ユーザーにてSlack Appの準備をお願いする想定です。
