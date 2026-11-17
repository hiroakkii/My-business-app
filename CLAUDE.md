# 業務アプリ（まとめ版）引き継ぎメモ

このリポジトリで作業する Claude Code 向けの引き継ぎです。最初に読んでください。
利用者は薬局の実務担当者で、プログラミングの専門家ではありません。**説明は日本語で、専門用語を避けて**行ってください。

## 絶対に守ること

- **実在の患者・医師の名前やID、画像に写った情報を、テストデータ・コード・コミット・PR に入れない。** リポジトリは公開です。
  テストには「試験 太郎」「しけん たろう」のような架空の名前だけを使う。
- 利用者のメールアドレスなどの個人情報もリポジトリに入れない。
- 各アプリは `index.html` をブラウザ（Edge / Chrome）で**パソコン内のファイルとして開いて**使う（`file://`）。サーバーは使わない。
  動作確認も `file://` で行う（http で開くと保存領域の共有や同一オリジンの扱いが変わり、結果が違う）。

## 構成

- `index.html` … まとめ画面。上部タブで各アプリを iframe で切り替える。
  - タブのドラッグ並べ替え（`businessApp.portal.tabOrder` に保存）、最後に開いたタブの記憶
  - **患者マスタ一括取込**: 1つの Excel を各アプリの取込欄に渡し、確認画面の OK まで自動で進める
  - **バックアップ・データ削除**: 全アプリのブラウザ内データ（localStorage・IndexedDB）を1ファイルに一括バックアップ
    （パスワード指定時は PBKDF2 + AES-GCM で暗号化）、一括復元、一括削除
  - ワクチン接種管理の「保存先フォルダ」選択の代行（`FS_CFG` で ワクチン接種管理だけ許可）
- `apps/<名前>/` … 各アプリ。元のリポジトリのファイルをほぼそのまま置いている。

| タブ | フォルダ | 元のリポジトリ（ベースのブランチ） |
|---|---|---|
| 薬剤在庫管理 | `apps/stock` | hiroakkii/Antibiotic-stock-control（`claude/inspiring-cerf-qjr1iu`） |
| 在宅移行初期管理料 指示書 | `apps/order` | hiroakkii/Visit-Request（`claude/elegant-fermat-4t97b5`） |
| 訪問リスト印刷 | `apps/visit-list` | hiroakkii/X-ray-management（`claude/confident-hypatia-9p17kr`） |
| ワクチン接種管理 | `apps/vaccine` | **なし（このリポジトリが原本）** |
| 持参薬管理 | `apps/jisan` | hiroakkii/Medication-Reconciliation（`main`） |

- `apps/common/portal-import.js` … 一括取込・一括バックアップの記録用。各アプリの最後で読み込む（単独で開いたときは何もしない）。
- `apps/vaccine/portal-fs-bridge.js` … タブの中でワクチン接種管理の保存先フォルダを使うための補助。
- `tools/sync_app.py` … `apps/<名前>` の内容を元のリポジトリのチェックアウトへ反映（まとめ版専用の読み込み行は除く）。
- `tools/apply_keep_eol.py` … 元ファイルの行末（CRLF/LF 混在）を保ったまま変更行だけ反映する。
  **持参薬管理の `index.html` は行末が混在しているので、反映にはこちらを使う**（そのままコピーすると全行が差分になる）。

## しくみの要点

- `file://` で開くと、まとめ画面と5アプリは**同じブラウザ内保存領域**を共有する（タブの中でも単独で開いても同じデータ）。
  ただし iframe 同士は別オリジン扱いなので、まとめ画面⇔アプリは `postMessage` でやり取りする。
- 各アプリの保存先（一括バックアップ・削除の対象。他のツールのデータを消さないよう名前で限定）:
  - 在庫: localStorage `abx-stock-control-*`
  - 指示書: localStorage `homeTransitionOrder.*`、IndexedDB `homeTransitionOrder`（郵便番号データ。バックアップ対象外）
  - 訪問リスト: localStorage `visitPatientList.*`
  - ワクチン: localStorage `vaccineKanri.*`、IndexedDB `vaccineKanri.fs`（保存先フォルダの記録。バックアップ対象外）
  - 持参薬: localStorage `jisan-yaku-*`、IndexedDB `jisan-yaku-db`
- 一括復元・削除は IndexedDB を**削除せず中身だけ入れ替える**（アプリが開いたままでも待たされないように）。
  持参薬管理・ワクチン接種管理は `onversionchange` で接続を閉じて譲る。
- 全アプリに Content-Security-Policy あり。外部通信は訪問リスト印刷の国土地理院
  （`cyberjapandata.gsi.go.jp`・`msearch.gsi.go.jp`）だけ許可。変更後は CSP 違反が出ないか確認する。

## 運用ルール（利用者の職場に合わせたもの）

- **患者マスタ取込時の自動除外**（訪問リスト印刷**以外**の4アプリ）: ID に「WA」を含む、または名前に「[亘]」を含む患者。
  全角 ＷＡ／［亘］、【亘】、(亘) も対象。かっこ無しの「亘理」は対象外。各アプリの `isExcludedPatient`。
- **住所からグループホーム判定**（訪問リスト印刷・ワクチン接種管理）: 住所に「おひさまの家」を含めば、
  グループホーム欄が空や「○」でも「おひさまの家」とする。`GH_NAMES_IN_ADDRESS` に追加すれば増やせる。
- 患者マスタの Excel 形式: 見出し **ID・名前・ふりがな・生年月日・住所・グループホーム・住民票住所・性別**。

## これまでに追加した主な機能（アプリ別）

- 薬剤在庫管理: 処方メモの状態を 未発行（黄）／指示未記載（赤）／指示記載済 で管理、「指示記載を確認」、
  絞り込み・並び順、医師別 未記載一覧（医師ごとに1ページ印刷。医師名に「先生」は付けない、No.・記載・ID列なし、
  患者名・日付は収まらないときだけ文字を縮小）、お守り薬一覧の見出しクリックで並べ替え、ふりがな・ひらがなでの検索。
  ロジックは `apps/stock/js/logic.js`、テストは `apps/stock/tests/`（`npm test`）。
- ワクチン接種管理: 絞り込みに「チェックマーク患者」（並び: すべて／予定日を過ぎた未接種／未接種（キャンセル除く）／
  接種予定日が未定／チェックマーク患者／接種済／キャンセル。「本日接種予定」は削除）、一括バックアップ後は「未保存」警告を出さない。

## 作業の進め方

- 変更はまず `apps/<名前>` に行い、動作確認してからこのリポジトリにコミット・プッシュする。
- 元のリポジトリにも反映する場合は、元のリポジトリをチェックアウトし、`sync-from-my-business-app` ブランチで
  `python3 tools/sync_app.py apps/<名前> <チェックアウト先>`（持参薬は `tools/apply_keep_eol.py`）で反映してプッシュする。
  元のリポジトリの既定ブランチへ直接プッシュしない。
- 動作確認: Playwright（`require('playwright')`、`chromium.launch()`）で `file:///.../index.html` を開いて操作する。
  架空の患者データで確認し、`securitypolicyviolation`（CSP 違反）とページのエラーが出ないことも見る。
- 利用者のPCの字形（BIZ UDPゴシック など）は確認環境より幅が広いことがある。印刷物の幅は余裕を持たせる。

## 現在の状況（引き継ぎ時点）

- 作業ブランチ: `claude/ecstatic-cannon-z0knsu`（`main` への PR #1 あり。`main` と履歴が別だったため `main` を取り込み済み）。
- 元のリポジトリへの PR: Antibiotic-stock-control #1・Visit-Request #1・X-ray-management #1（いずれも `sync-from-my-business-app` ブランチ）。
- **持参薬管理（Medication-Reconciliation）は Claude に書き込み権限が無いため未反映。利用者の指示で対応不要。**
- 一度、テストデータに実在の患者名を入れてしまい、該当コミットを書き直して強制プッシュした経緯がある。今後は架空の名前だけを使うこと。
