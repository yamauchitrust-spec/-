# Rental LINE Bot
Render で動かす LINE Bot（レンタル価格応答）

## 手順
1. このフォルダを GitHub に push
2. Render → Web Service → リポジトリ選択
3. Build Command: `npm ci`
4. Start Command: `npm start`
5. 環境変数:
   - LINE_CHANNEL_SECRET
   - LINE_CHANNEL_ACCESS_TOKEN
6. Deploy 後、URL + `/webhook` を LINE Developers の Webhook URL に設定
7. 「接続確認」で成功すれば完了
