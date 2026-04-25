<h1 align="center">オープンソース 複数レイヤー対応WebRTC絵チャ<br>システム設計書</h1>

## 1. プロジェクト概要

### 1.1 コンセプト

特定のクラウドプロバイダ (BaaS) に依存せず、どこにでも簡単にデプロイできる、複数レイヤー対応の軽量なオープンソース・ペイントチャットツール。

### 1.2 コアバリュー

- **無制限の複数レイヤー:** サーバーで画像合成を行わずクライアント (ブラウザ) のパワーに依存するため、従来のWebブラウザ型ペイントツールでありがちなレイヤー枚数制限 (2枚まで等) がなく、クライアントのメモリが許す限りレイヤーを追加可能。
- **超軽量なP2P同期:** 重厚なCRDTライブラリ等や長寿命のWebSocketサーバーに依存せず、生のRTCDataChannelで操作ログ (JSON) を直接同期。
- **分散データ生成と順序保証:** すべてのデータIDにUUIDv7を採用。複数人が同時に描画を行ってもIDが衝突せず、かつ時系列順のソートをシステムレベルで保証。
- **サーバーレス/コンテナのハイブリッド対応:** Vercel等のPaaSでも、VPS等のDocker環境でも、構成を変えずにそのままデプロイ可能。

## 2. システムアーキテクチャ

システムは大きくフロントエンド (描画)、リアルタイム通信 (P2P)、データ永続化 (バックエンド) の3層で構成されます。

### 2.1 技術スタック

- **フロントエンド・UI:** Next.js (App Router) + React
- **描画エンジン:** React Konva (CanvasのDOMライクな複数レイヤー管理)
- **リアルタイム通信:** 生のWebRTC (RTCDataChannel)
- **認証:** WebAuthn (Passkeysによるパスワードレス認証)
- **シグナリング:** Next.js API Routes + Server-Sent Events (SSE) + Redis
- **ホットデータ (一時保存):** Redis (Valkey等)
- **コールドデータ (永続化):** PostgreSQL

### 2.2 推奨デプロイメント構成

OSSとして以下の2パターンの提供を想定します。

1. **マネージド・サーバーレス構成:**
   - **Frontend / API:** Vercel
   - **Redis:** Upstash等
   - **PostgreSQL:** Neon, Supabase等
2. **セルフホスト構成 (Docker Compose):**
   - Next.jsコンテナ、Redisコンテナ、PostgreSQLコンテナを同梱し `compose.yaml` で完結。

## 3. ネットワーク・通信仕様

### 3.1 シグナリング (初期接続)

外部のシグナリングサーバーを使用せず、自前のインフラで完結させます。

1. クライアントが部屋に入室時、自身の接続情報 (Offer/Answer, ICE Candidate) をNext.jsのAPIを経由してRedisに保存。
2. 他のクライアントは、SSE (Server-Sent Events) を用いてAPIを数秒間待機 (購読) し、相手の接続情報を受信。
3. 接続情報が交換でき次第、SSEを切断 (タイムアウト問題を回避)。

### 3.1.1 接続確立フロー

シグナリング完了後のP2P接続状態遷移を以下のように管理します。

1. Offer/Answer交換完了 → RTCPeerConnection作成
2. ICE接続状態を監視:
   - 'connected' または 'completed' → 接続成功
   - 'failed' または 'disconnected' → 再シグナリングを試行 (最大3回)
   - 'closed' → ユーザーに接続失敗を通知
3. 再接続タイムアウト設定:
   - 初回リトライ: 2秒待機
   - 2回目: 5秒待機
   - 3回目: 10秒待機
   - 4回目以降: 失敗と判定、ユーザーへ通知

### 3.1.2 複数人接続戦略

複数人接続時 (N >= 3) の接続モデルを以下のように規定します。

- **採用モデル:** メッシュ型 (全員が全員と接続)
- **最大推奨同時接続数:** 8人
- **同時接続数超過時の挙動:**
  - 9人目以降の新規参加者は既接続グループへの参加待ちキューに登録
  - キューから削除されたユーザーの部屋への再接続時は優先対応
- **接続数制限の設定方法:** 部屋作成時に `maxParticipants` (デフォルト: 8) で設定可能

### 3.2 描画のリアルタイム同期

シグナリング完了後は、サーバーを経由せず、クライアント間のRTCDataChannelで直接通信します。

- **同期フォーマット:** 差分データの軽量なJSON。
- **同期内容:** ストロークの座標配列の追加、レイヤー操作 (追加/削除/並び替え/表示切替)、カーソル位置など。

### 3.2.1 ストロークデータ型仕様

P2Pで飛び交うストロークメッセージの完全な仕様は以下の通りです。

**基本構造:**

```json
{
  "type": "stroke",
  "payload": {
    "id": "018f... (UUIDv7)",
    "userId": "018f... (UUIDv7)",
    "layerId": "018f... (UUIDv7)",
    "tool": "pen",
    "color": "#000000",
    "strokeWidth": 5,
    "opacity": 1.0,
    "blendMode": "normal",
    "points": [10.5, 20.1, 12.0, 22.5],
    "pressure": [0.5, 0.7, 0.9, 1.0],
    "tilt": [0, 15, 30, 45],
    "timestamp": 1705310400000,
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

**フィールド定義:**

| フィールド  | 型       | 必須 | 説明                                                       |
| ----------- | -------- | ---- | ---------------------------------------------------------- |
| id          | UUID     | ○    | UUIDv7形式のストロークID                                   |
| userId      | UUID     | ○    | 描画ユーザーID                                             |
| layerId     | UUID     | ○    | 対象レイヤーID                                             |
| tool        | string   | ○    | 描画ツール (詳細は下表)                                    |
| color       | string   | ○    | 16進数カラーコード (#RRGGBB)                               |
| strokeWidth | number   | ○    | ストローク幅 (1-100)                                       |
| opacity     | number   | ○    | 不透明度 (0.0-1.0)                                         |
| blendMode   | string   | ○    | ブレンドモード ('normal', 'multiply', 'screen', 'overlay') |
| points      | number[] | ○    | xy座標交互形式 [x1, y1, x2, y2, ...]                       |
| pressure    | number[] | ×    | ペン圧情報 (0-1)、タッチペン非対応環境では省略可           |
| tilt        | number[] | ×    | ペン傾き角度 (度数法)、非対応環境では省略可                |
| timestamp   | number   | ○    | ミリ秒単位のタイムスタンプ                                 |
| createdAt   | string   | ○    | ISO8601形式の作成日時                                      |

**tool の定義:**

| tool   | 説明           | 特殊挙動                                        |
| ------ | -------------- | ----------------------------------------------- |
| pen    | 通常のペン描画 | なし                                            |
| eraser | 消しゴム       | 当該レイヤーのみ透明化 (複数レイヤー間消去不可) |
| line   | 直線           | 描画終了時に最短路を確定                        |
| rect   | 矩形           | ドラッグ終了時に確定                            |
| circle | 円形           | ドラッグ終了時に確定                            |

**消しゴムの挙動:**

- クライアント側では、eraser strokeはそれ自体が透明ピクセルのストロークとして記録
- サーバー側では、複数レイヤーに跨った消しゴムは行わない (単一レイヤー限定)
- 消しゴム後の復元: ナイーブには不可。Snapshots のみで履歴管理

### 3.2.2 レイヤー操作メッセージ仕様

レイヤーの追加・削除・並び替え・属性変更をメッセージフォーマットで定義します。

**1. レイヤー追加:**

```json
{
  "type": "layer",
  "action": "add",
  "payload": {
    "id": "UUIDv7",
    "name": "Layer 1",
    "index": 0,
    "opacity": 1.0,
    "blendMode": "normal",
    "visible": true,
    "timestamp": "ISO8601"
  }
}
```

**2. レイヤー削除:**

```json
{
  "type": "layer",
  "action": "delete",
  "payload": {
    "id": "UUIDv7",
    "timestamp": "ISO8601"
  }
}
```

**3. レイヤー並び替え:**

```json
{
  "type": "layer",
  "action": "reorder",
  "payload": {
    "id": "UUIDv7",
    "newIndex": 2,
    "oldIndex": 0,
    "timestamp": "ISO8601"
  }
}
```

**4. レイヤー属性変更:**

```json
{
  "type": "layer",
  "action": "update",
  "payload": {
    "id": "UUIDv7",
    "fields": {
      "name": "Background",
      "opacity": 0.8,
      "blendMode": "multiply",
      "visible": false
    },
    "timestamp": "ISO8601"
  }
}
```

**Undo/Redo対応:**

- 各レイヤー操作には `operationId` (UUIDv7) を付与
- クライアント側でスタック管理
- サーバー側では Snapshots マージ時に最新状態のみ保持

### 3.2.3 カーソル・プレゼンスメッセージ仕様

複数人描画時のリアルタイム協調作業感を向上させるため、カーソル位置・プレゼンス情報を同期します。

**メッセージ形式:**

```json
{
  "type": "presence",
  "payload": {
    "userId": "UUIDv7",
    "username": "Alice",
    "cursorX": 123.5,
    "cursorY": 456.2,
    "color": "#FF5733",
    "isDrawing": true,
    "currentTool": "pen",
    "timestamp": 1705310400000
  }
}
```

**送信戦略:**

- 送信頻度: 100ms間隔 (ネットワーク節約)
- マウスが静止 > 3秒 → presence メッセージ停止
- マウス移動 → 即座に再開
- DataChannel `ordered: false` で送受 (順序不問、低遅延重視)

**UI表現:**

- 各ユーザーのカーソルを異なる色で描画
- ユーザー名をツールチップ表示
- 3秒以上更新なし → 薄く表示

### 3.3 NAT越え (STUN/TURN戦略)

- **WebRTC設定の動的注入:** P2P通信に必要なSTUN/TURNサーバーの設定は、ハードコードせずすべてデータベース (管理者設定) から取得してクライアントに渡します。
- **STUNサーバー:** 初期セットアップ時のデフォルト値として公開STUN (Google等) を自動登録し、設定不要で大半の環境で動作するようにします。管理画面から自由に変更・追加が可能です。
- **TURNサーバー (Optional):** 企業ネットワークなど厳しい環境への対応として、管理画面からSaaS型TURNや自前構築TURNの認証情報を追加設定可能とします (OSSパッケージにはTURNサーバー本体は同梱しません)。

### 3.4 エラーハンドリング・リカバリ仕様

ネットワーク不安定環境での動作を保証するため、以下のエラーハンドリング戦略を採用します。

**ネットワーク断時のクライアント動作:**

1. RTCDataChannel 'closed' 検出 → 3秒待機後、シグナリング再実行
2. リトライ最大回数: 5回
3. 再接続失敗 → ユーザーへ通知、部屋から退出

**サーバー応答エラー形式:**

```json
{
  "type": "error",
  "code": "INVALID_STROKE | LAYER_NOT_FOUND | PERMISSION_DENIED | SERVER_ERROR",
  "message": "Human-readable error message",
  "timestamp": "ISO8601"
}
```

**エラーコード定義:**

| コード              | HTTP | 説明                         |
| ------------------- | ---- | ---------------------------- |
| INVALID_STROKE      | 400  | ストロークフォーマットが無効 |
| LAYER_NOT_FOUND     | 404  | 指定レイヤーが見つからない   |
| PERMISSION_DENIED   | 403  | ユーザーに操作権限がない     |
| SERVER_ERROR        | 500  | サーバー内部エラー           |
| RATE_LIMIT_EXCEEDED | 429  | レート制限に達した           |

**不整合検出・修復:**

- クライアント側は、ローカルのストロークID と サーバーのスナップショットIDを定期的に照合
- 照合は30秒ごとに実施
- 不一致検出 → チェックサム (CRC32) を計算して比較
- 一致 → 問題なし
- 不一致 → フルスナップショット再取得＋ローカル描画を上書き (ユーザー確認ダイアログ表示後)

**定期的なヘルスチェック:**

- 30秒ごとに ping/pong で RTCDataChannel 生存確認
- 応答なし → 再接続開始
- タイムアウト: 10秒

## 4. データ永続化フロー (ホット/コールド分離)

サーバーレス環境の制約を回避しつつ、タイムラプス再生も可能な操作ログの追記型永続化を行います。

### 4.1 描画ログ送信戦略

**シナリオ別の送信フロー:**

1. **オンライン・複数人:** (推奨)
   - ストロークをP2P (RTCDataChannel) で相手に即座に同期
   - 5秒ごとにバッチでHTTPでサーバーへ送信 (永続化)

2. **オンライン・単独利用:** (セルフホスト、他者未接続)
   - ストロークをローカルで保持 (P2P送信なし)
   - 5秒ごとにバッチでHTTPでサーバーへ送信

3. **オフライン:** (ネットワーク接続なし)
   - ストロークをローカルストレージ (IndexedDB) に保持
   - 再接続 → オフライン中のストロークを取得してサーバーへ送信

**バッチ送信メカニズム:**

- クライアント側でストロークログを配列に蓄積
- 5秒経過 || ストロークが50件に達した → どちらか早い方で送信
- 送信時にサーバーから確認ID (batchId) を取得
- 確認受け取り後、ローカルバッファをクリア
- 確認失敗時 (HTTP 5xx等) → 指数バックオフでリトライ (最大3回)
  - 1回目: 1秒待機
  - 2回目: 2秒待機
  - 3回目: 4秒待機

**バッチ送信APIリクエスト形式:**

```json
{
  "logs": [
    {
      "id": "UUIDv7",
      "userId": "UUIDv7",
      "layerId": "UUIDv7",
      "tool": "pen",
      "color": "#000000",
      "strokeWidth": 5,
      "points": [10.5, 20.1, 12.0, 22.5],
      "timestamp": 1705310400000,
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

**バッチ送信APIレスポンス形式:**

```json
{
  "batchId": "UUIDv7",
  "receivedCount": 5,
  "timestamp": "ISO8601"
}
```

### 4.2 スナップショット生成・マージ仕様

外部スケジューラー (Vercel CronやCloud Scheduler等) を用いて、一定間隔 (例: 5分) で専用のAPIをHTTPリクエストでキックします。

**バージョニング:**

各部屋ごとにスナップショットには単調増加するバージョン番号を付与します。

- Version 1, 2, 3, ... (Redisの最新ログが Version N+1 になる)
- クライアント接続時は、最新スナップショット (Version N) を取得して、その後のログ差分を適用

**マージアルゴリズム:**

1. Redisから取得したログを UUIDv7 でソート (タイムスタンプ保証)
2. レイヤー単位で構造化:
   ```
   layers = {
     layer1: { strokes: [s1, s2, ...], metadata: {...} },
     layer2: { strokes: [s3, s4, ...], metadata: {...} }
   }
   ```
3. 既存スナップショットの layers と合併:
   - 新規レイヤー → そのまま追加
   - 既存レイヤー → strokes リストを UUIDv7 ソート後に追加
   - 削除済みレイヤー → 新ログにマージされず (既存スナップショット側で保留)
4. マージ後、Brotli圧縮してPostgreSQLに保存

**スナップショット差分 (デルタ):**

クライアント側が大規模スナップショット全体ではなく、増分ログのみを受け取る機能:

- クライアント接続時、現在の Version を送信
- サーバーは Version N から Version M までのログ差分を返却
- 通常は数百KBのログ差分で済み、GB級のスナップショット全体は回避

**削除・アーカイブ方針:**

- スナップショット Version は永遠に保持 (タイムラプス再生対応)
- Rooms が 'archived' → 最新スナップショットのみ保持、古いバージョンは段階削除
- アーカイブから90日 → 最古の 10 Version を削除対象へ

## 5. データモデル設計 (プロトコル概要)

### 5.1 ID生成戦略

すべてのエンティティ (ユーザー、部屋、レイヤー、ストロークログ等) のIDにはUUIDv7を使用します。これにより、複数クライアント間での分散生成時の衝突を防ぎつつ、生成時刻ベースのソートを可能にします。

**UUIDv7による順序保証:**

複数クライアントが同じミリ秒内に同じルーム内でデータを生成した場合の対応:

- UUIDv7はタイムスタンプベースであり、ミリ秒精度で時系列順のソート保証
- クライアント側では、同じミリ秒内での複数ストロークに対して、ローカルシーケンス番号を付与して管理
- サーバー側では、UUIDv7の時間順ソート + 同一クライアントのシーケンス番号確認で最終的な順序を保証

### 5.2 通信プロトコル (DataChannel Payload)

P2Pで飛び交うJSONメッセージの基本構造は、3.2.1、3.2.2、3.2.3 を参照してください。

### 5.3 データベーススキーマ

※ UUIDv7はアプリケーション側で生成するため、SQL上の `DEFAULT gen_random_uuid()` は使用しません。

#### 5.3.1 Users テーブル

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,

  INDEX idx_email (email),
  INDEX idx_created_at (created_at)
);
```

#### 5.3.2 WebAuthnCredentials テーブル

```sql
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL,
  transports VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_user_id (user_id)
);
```

#### 5.3.3 Rooms テーブル (ライフサイクル)

```sql
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),
  last_activity_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  max_participants INT DEFAULT 8,
  is_public BOOLEAN DEFAULT false,
  canvas_width INT DEFAULT 1920,
  canvas_height INT DEFAULT 1080,
  description TEXT,

  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_is_public (is_public)
);
```

**Rooms の状態遷移:**

| 状態     | 説明                                                   |
| -------- | ------------------------------------------------------ |
| active   | 通常状態。誰でも参加可能                               |
| paused   | 管理者が一時停止。新規描画は禁止だが、既存内容は閲覧可 |
| archived | 完了状態。読み取り専用。Snapshots として永続化済み     |

**クリーンアップルール:**

- 24時間参加者なし → 'archived' に自動遷移
- 7日間 'archived' → 削除対象として標記
- 30日間削除対象 → 実削除 (または Snapshots のみ保持)

#### 5.3.4 Snapshots テーブル

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  version BIGINT NOT NULL,
  canvas_width INT NOT NULL,
  canvas_height INT NOT NULL,
  layers_data JSONB NOT NULL,
  strokes_data BYTEA,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),

  UNIQUE(room_id, version),
  INDEX idx_room_id_version (room_id, version),
  INDEX idx_created_at (created_at)
);
```

**Snapshots テーブルの構造例 (strokes_data 展開後):**

```json
{
  "version": 1,
  "canvasWidth": 1920,
  "canvasHeight": 1080,
  "layers": [
    {
      "id": "018f...",
      "name": "background",
      "opacity": 1.0,
      "blendMode": "normal",
      "visible": true,
      "index": 0,
      "strokes": [
        {
          "id": "018f...",
          "tool": "pen",
          "color": "#000000",
          "strokeWidth": 5,
          "points": [10.5, 20.1, 12.0, 22.5],
          "createdAt": "2024-01-15T10:30:00Z",
          "clientId": "018f..."
        }
      ]
    }
  ]
}
```

#### 5.3.5 OperationLogs テーブル (Redis キャッシュ用)

Redis に保存するログ構造 (PostgreSQL との同期対象):

```json
{
  "key": "logs:{{roomId}}",
  "ttl": 86400,
  "structure": "LIST",
  "items": [
    {
      "id": "UUIDv7",
      "userId": "UUIDv7",
      "layerId": "UUIDv7",
      "type": "stroke",
      "payload": { ... },
      "createdAt": "ISO8601"
    }
  ]
}
```

#### 5.3.6 Settings テーブル

```sql
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY,
  key VARCHAR(255) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_key (key)
);
```

**Settings の例:**

| key              | value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| site_name        | "Collaborative Drawing"                                           |
| site_logo_url    | "https://..."                                                     |
| stun_servers     | ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] |
| turn_servers     | [{"urls": "turn:...", "username": "...", "credential": "..."}]    |
| sync_interval_ms | 5000                                                              |
| batch_threshold  | 50                                                                |

#### 5.3.7 RoomParticipants テーブル

```sql
CREATE TABLE IF NOT EXISTS room_participants (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(50) DEFAULT 'editor',
  joined_at TIMESTAMP DEFAULT NOW(),
  left_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,

  UNIQUE(room_id, user_id),
  INDEX idx_room_id (room_id),
  INDEX idx_user_id (user_id)
);
```

### 5.4 キャンバスジオメトリ仕様

#### デフォルトサイズ

- 幅: 1920px
- 高さ: 1080px
- DPI: 96 (スクリーン標準)

#### 座標系

- 左上が原点 (0, 0)
- X軸: 右方向が正
- Y軸: 下方向が正
- 小数座標対応 (10.5, 20.7 等)

#### キャンバスリサイズ

- ユーザーがキャンバスサイズを変更 → 新サイズをストレージに保存
- 既存ストローク: スケーリングなし、座標そのまま保持
- 新サイズより外の描画: クリップ表示
- リサイズメッセージフォーマット:

```json
{
  "type": "canvas",
  "action": "resize",
  "payload": {
    "width": 2560,
    "height": 1440,
    "timestamp": "ISO8601"
  }
}
```

#### Retina対応

- devicePixelRatio に応じて内部キャンバスサイズをスケール
- ユーザーが指定するサイズ (width, height) は論理値 (CSSピクセル)
- 実際のレンダリングサイズ = 論理値 × devicePixelRatio

## 6. 設定・セットアップ仕様

インフラ設定とアプリケーション設定を完全に分離します。

### 6.1 インフラ環境変数 (実行時・サーバー側のみで参照)

利用者が `compose.yaml` 等で指定する項目。

- **`DATABASE_URL`:** PostgreSQL接続文字列
- **`REDIS_URL`:** Redis接続文字列
- **`AUTH_SECRET`:** セッション等用シークレットキー
- **`CRON_SECRET`:** 外部スケジューラー用認証キー
- **`NODE_ENV`:** 実行環境 (development | production)

### 6.2 UIベースのシステム設定

以下の項目は、初回アクセス時に作成する管理者アカウントを用いてWeb UIから設定し、PostgreSQLに保存 (Redisにキャッシュ) します。

- サイト名 / ロゴ画像
- STUNサーバー設定 (URLのリスト)
- TURNサーバー設定 (URL, Username, Credential)
- 同期・保存間隔等のチューニングパラメータ

### 6.3 認証・権限仕様

#### ユーザー認証と初期セットアップフロー

1. **初期セットアップ判定 (proxy.ts):**
   - Node.js ランタイムの `proxy.ts` にて、Redis (`GET system:setup_completed`) を確認。
   - キャッシュがない場合のみPostgreSQLの `users` テーブルのレコード数を参照。
   - ユーザー数が0の場合、リクエストをオプティミスティックに `/setup` へリダイレクトし、判定結果をRedisに `SET` します。
2. **パスキーによる管理者登録:**
   - `/setup` 画面にてメールアドレスとユーザー名を入力後、ブラウザの生体認証 (Touch ID, Windows Hello等) を用いてWebAuthn (パスキー) を登録します。
   - 最初の登録者に自動的に `Owner` ロールが付与されます。
3. **パスワードレス認証 (通常ログイン):**
   - パスワード管理を完全に廃止し、WebAuthnのみで認証を行います。
   - 認証成功後は `AUTH_SECRET` で署名された JWT を HTTPOnly Cookie に保持し、セッションを管理します。

#### 部屋アクセス権限

| 権限   | 説明                                     |
| ------ | ---------------------------------------- |
| Owner  | 部屋作成者。削除、参加者管理可能         |
| Editor | 招待された編集者。描画、レイヤー操作可能 |
| Viewer | 閲覧のみ。描画不可                       |
| Public | 誰でも参加可能 (`isPublic: true` の場合) |

#### 操作の権限

- **ストローク追加:** Editor 以上
- **レイヤー操作:** Editor 以上
- **部屋削除:** Owner のみ
- **ユーザー招待:** Owner または Editor (管理者設定で制御可能)
- **部屋一時停止:** Owner のみ
- **スナップショット復元:** Owner のみ

#### レート制限

- **ストローク送信:** 1ユーザーあたり 100件/秒 上限
- **API リクエスト:** 1ユーザーあたり 1000リクエスト/時間 上限
- **超過時:** 429 Too Many Requests
- **レート制限リセット:** 1時間単位で自動リセット

## 7. 複数人接続時の同期戦略と制限

### 7.1 最大参加者数

- **推奨最大同時接続数:** 8人
- **ハードリミット:** 16人 (メッシュ型P2P接続の限界)
- **超過時の挙動:** キューイング機構で待機管理

### 7.2 帯域幅推定

- **標準描画時:** 約 50-100 Kbps / ユーザー (P2P)
- **高頻度描画時:** 約 200-300 Kbps / ユーザー (P2P)
- **複数人参加時:** 上記値 × (参加人数 - 1)
- **推奨ネットワーク:** 1 Mbps 以上

## 8. 性能・スケーラビリティ要件

### 8.1 Konva レイヤー数上限

- **推奨上限:** 20-30レイヤー
- **ハード上限:** 100レイヤー (メモリ次第)
- **パフォーマンス低下検知:** FPSが30未満に低下した場合、ユーザーへ警告表示
- **最適化戦略:**
  - 表示されていないレイヤーは動的にアンロード
  - ストロークが多いレイヤー (1000+件) は静的キャッシュ化

### 8.2 Redis キャッシュサイズ

- **推奨 Redis メモリ:** 1GB 以上
- **部屋ごとのホットデータ保持期間:** 7日間
- **LRU削除ポリシー:** `maxmemory-policy allkeys-lru`

### 8.3 PostgreSQL ストレージ

- **推奨初期容量:** 10GB 以上
- **1部屋あたりのスナップショットサイズ:** 平均 5-50MB (ストローク量による)
- **保持ポリシー:** Snapshotsは無制限保持 (タイムラプス対応)。ただし、削除コマンドで手動削除可能
